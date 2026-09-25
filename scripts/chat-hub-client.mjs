/**
 * Desk → Hub chat API client (desk token auth).
 * Resolves gotchibot-hub:// stateUris against the pinned Hub.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertChatDeskAllowed, deskAuthHeaders } from "./infra-client.mjs";
import { contentHashOf } from "./chat-canonical.mjs";
import { parseStateUri } from "./chat-state-uri.mjs";
import { loadDiamond, CHAIN_ID } from "./chat-checkpoint-onchain.mjs";
import { resolveCastBin } from "./platform.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAIRING_HINT =
  "desk token required — run: gotchibot hub join <host> <code>";

/**
 * JSON request to the pinned Hub desk API.
 * @throws {Error} with .status / .body; 401 appends pairing hint
 */
export async function hubRequest(method, path, { query, body, env = process.env } = {}) {
  const { base } = assertChatDeskAllowed(env);
  const url = new URL(`${base}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v != null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const headers = { ...deskAuthHeaders(env) };
  if (body != null) headers["Content-Type"] = "application/json";
  const res = await fetch(url, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: text.slice(0, 200) };
  }
  if (!res.ok) {
    let msg = json.error || `HTTP ${res.status}`;
    if (res.status === 401 && !/hub join/i.test(msg)) {
      msg = `${msg}\n${PAIRING_HINT}`;
    }
    const err = new Error(msg);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

export async function fetchSnapshot(snapshotId, env = process.env) {
  const id = String(snapshotId || "").trim();
  if (!id) throw new Error("snapshotId required");
  return hubRequest("GET", `/api/gotchibot/chats/snapshot/${encodeURIComponent(id)}`, { env });
}

const resolvers = {
  async "gotchibot-hub"(id, env) {
    return fetchSnapshot(id, env);
  },
  async ipfs() {
    throw new Error("ipfs:// stateUri not supported yet");
  },
};

/**
 * Desk-side stateUri resolver. Hub scheme → fetchSnapshot on pinned Hub.
 */
export async function resolveStateUri(uri, env = process.env) {
  const parsed = parseStateUri(uri);
  if (!parsed) throw new Error(`invalid stateUri: ${uri}`);
  const fn = resolvers[parsed.scheme];
  if (!fn) throw new Error(`unknown stateUri scheme: ${parsed.scheme}`);
  return fn(parsed.id, env);
}

/**
 * Fetch snapshot, recompute contentHash, compare expectHashes.
 */
export async function verifySnapshot({
  snapshotId,
  stateUri,
  expectHashes = [],
  env = process.env,
} = {}) {
  let id = snapshotId ? String(snapshotId).trim() : "";
  let uri = stateUri ? String(stateUri).trim() : "";
  if (!id && uri) {
    const p = parseStateUri(uri);
    if (!p || p.scheme !== "gotchibot-hub") {
      throw new Error(`cannot resolve snapshot from stateUri: ${uri}`);
    }
    id = p.id;
  }
  if (!id) throw new Error("snapshotId or gotchibot-hub:// stateUri required");

  const snap = await fetchSnapshot(id, env);
  const content = snap.content;
  const computedHash = contentHashOf(content);
  const hubHash = String(snap.contentHash || "").toLowerCase();
  const checks = (expectHashes || []).map(({ label, hash }) => {
    const expected = String(hash || "").toLowerCase();
    return {
      label: label || "expected",
      expected,
      match: expected === computedHash.toLowerCase(),
    };
  });
  const hubMatch = hubHash === computedHash.toLowerCase();
  const ok = hubMatch && checks.every((c) => c.match);
  return {
    snapshotId: snap.snapshotId || id,
    stateUri: snap.stateUri || uri || `gotchibot-hub://${id}`,
    computedHash,
    hubHash: snap.contentHash,
    checks: [
      { label: "hub contentHash", expected: snap.contentHash, match: hubMatch },
      ...checks,
    ],
    ok,
    content,
  };
}

async function loadEthers() {
  try {
    return await import("ethers");
  } catch {
    return import(resolve(ROOT, "../AarcadeGh-t/node_modules/ethers/lib.esm/index.js"));
  }
}

/**
 * READ-ONLY eth_call getCheckpoint(uint256) on Base Sepolia.
 * Never sends a transaction.
 */
export async function readOnchainCheckpoint({
  cartridgeId,
  diamond,
  rpc,
} = {}) {
  const id = cartridgeId != null ? String(cartridgeId) : "";
  if (!id) throw new Error("cartridgeId required");
  const chain = loadDiamond();
  const addr = String(diamond || process.env.CARTRIDGE_DIAMOND || chain.cartridgeDiamond || "").trim();
  if (!addr) throw new Error("cartridgeDiamond missing");
  const rpcUrl = String(rpc || process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org").trim();

  const sig =
    "function getCheckpoint(uint256 cartridgeId) view returns (tuple(uint256 nonce, bytes32 stateHash, string stateUri, uint256 savedAt))";

  try {
    const ethersMod = await loadEthers();
    const iface = new ethersMod.Interface([sig]);
    const data = iface.encodeFunctionData("getCheckpoint", [BigInt(id)]);
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: addr, data }, "latest"],
      }),
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    const decoded = iface.decodeFunctionResult("getCheckpoint", json.result);
    const tup = decoded[0];
    return {
      nonce: String(tup.nonce ?? tup[0]),
      stateHash: String(tup.stateHash ?? tup[1]),
      stateUri: String(tup.stateUri ?? tup[2]),
      savedAt: String(tup.savedAt ?? tup[3]),
      chainId: CHAIN_ID,
      diamond: addr,
      cartridgeId: id,
      via: "ethers-eth_call",
    };
  } catch (e) {
    const cast = resolveCastBin();
    if (!cast) throw e;
    const r = spawnSync(
      cast,
      [
        "call",
        addr,
        "getCheckpoint(uint256)((uint256,bytes32,string,uint256))",
        id,
        "--rpc-url",
        rpcUrl,
        "--chain",
        String(CHAIN_ID),
      ],
      { encoding: "utf8", env: process.env },
    );
    if (r.status !== 0) {
      throw new Error(String(r.stderr || r.stdout || e.message || "cast call failed").slice(0, 400));
    }
    const out = String(r.stdout || "").trim();
    // cast prints tuple like (1, 0x…, "gotchibot-hub://…", 123)
    const m = /^\(\s*(\d+)\s*,\s*(0x[0-9a-fA-F]{64})\s*,\s*"([^"]*)"\s*,\s*(\d+)\s*\)$/.exec(out);
    if (!m) {
      // try without quotes around empty string / alternate spacing
      const parts = out.replace(/^[(\s]+|[)\s]+$/g, "").split(/\s*,\s*/);
      if (parts.length >= 4) {
        return {
          nonce: parts[0],
          stateHash: parts[1],
          stateUri: parts[2].replace(/^"|"$/g, ""),
          savedAt: parts[3],
          chainId: CHAIN_ID,
          diamond: addr,
          cartridgeId: id,
          via: "cast",
        };
      }
      throw new Error(`unparseable cast output: ${out.slice(0, 200)}`);
    }
    return {
      nonce: m[1],
      stateHash: m[2],
      stateUri: m[3],
      savedAt: m[4],
      chainId: CHAIN_ID,
      diamond: addr,
      cartridgeId: id,
      via: "cast",
    };
  }
}

export { CHAIN_ID, loadDiamond };
