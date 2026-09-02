#!/usr/bin/env node
/**
 * Shared onboarding state + cartridge/wallet helpers for the tmux welcome gate.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { call, loadMeta, saveMeta, GAME_ID } from "./identity.mjs";
import { persistHeroCollateral, findCollateralColors, writeWalletGotchiCache, loadWalletGotchiIndex } from "./collateral-resolve.mjs";
import { resolveSubgraphUrl, infraHeaders } from "./infra-client.mjs";
import { resolveCastBin } from "./platform.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SESSIONS = `${ROOT}/sessions`;
export const ONBOARDING_PATH = `${SESSIONS}/.onboarding.json`;
export const WALLET_PATH = `${SESSIONS}/.wallet.json`;
export const PIN_PATH = `${SESSIONS}/.pin`;
export const ART_PATH = `${ROOT}/assets/gotchi-framed.ascii`;
const COLLATERAL_COLORS_PATH = `${ROOT}/assets/collateral-colors.json`;
const AARCADE_HAUNT1 = resolve(ROOT, "../AarcadeGh-t/JSONs/aavegotchi_db_collaterals_haunt1.json");
const AARCADE_HAUNT2 = resolve(ROOT, "../AarcadeGh-t/JSONs/aavegotchi_db_collaterals_haunt2.json");

/** Known aToken short names (aDAI → dai). Not brand names like amazon. */
const ATOKEN_SPIRITS = new Set([
  "dai", "weth", "aave", "link", "usdt", "usdc", "tusd", "uni", "yfi",
]);

/** Strip ma/am/a prefixes → spirit id used by cartridge sim fee ledger. */
export function libraryNameToSpiritId(name) {
  const raw = String(name || "").trim().toLowerCase();
  if (!raw) return "";
  const h2Rest = raw.startsWith("am") ? raw.slice(2) : "";
  const h1Rest = raw.startsWith("ma") ? raw.slice(2) : "";
  const isATokenRest = (rest) =>
    ATOKEN_SPIRITS.has(rest) || rest === "wbtc" || rest === "wmatic" || rest === "matic";
  let n = raw;
  if (h2Rest && isATokenRest(h2Rest)) n = h2Rest;
  else if (h1Rest && isATokenRest(h1Rest)) n = h1Rest;
  else if (raw.startsWith("a") && ATOKEN_SPIRITS.has(raw.slice(1))) n = raw.slice(1);
  if (n === "wmatic" || n === "matic") return "matic";
  if (n === "btc" || n === "bitcoin") return "wbtc";
  return n;
}

function displayCollateralLabel(libraryName, spiritId) {
  if (spiritId === "matic") return "MATIC";
  if (spiritId === "wbtc") return "BTC";
  return String(libraryName || spiritId).trim();
}

function optionsFromHauntDb(db, hauntId) {
  const list = Array.isArray(db?.collaterals) ? db.collaterals : [];
  return list
    .map((c) => {
      const libraryName = String(c?.name || "").trim();
      if (!libraryName) return null;
      const id = libraryNameToSpiritId(libraryName);
      if (!id) return null;
      return {
        id,
        label: displayCollateralLabel(libraryName, id),
        libraryName,
        hauntId,
        collateralType: c?.collateralType ? String(c.collateralType) : undefined,
      };
    })
    .filter(Boolean);
}

function readJsonIfExists(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Base-track starter collaterals (H1 ma* + H2 am*) — matches AarcadeGh-t starterCollaterals.ts. */
export function loadBaseStarterCollaterals() {
  const h1 = readJsonIfExists(AARCADE_HAUNT1);
  const h2 = readJsonIfExists(AARCADE_HAUNT2);
  if (h1 || h2) {
    return [...optionsFromHauntDb(h1, 1), ...optionsFromHauntDb(h2, 2)];
  }

  const fallback = readJsonIfExists(COLLATERAL_COLORS_PATH);
  const list = Array.isArray(fallback?.collaterals) ? fallback.collaterals : [];
  return list
    .filter((c) => c.haunt === 1 || c.haunt === 2)
    .map((c) => {
      const libraryName = String(c.name || "").trim();
      const hauntId = Number(c.haunt) === 2 ? 2 : 1;
      const id = libraryNameToSpiritId(libraryName);
      if (!libraryName || !id) return null;
      return {
        id,
        label: displayCollateralLabel(libraryName, id),
        libraryName,
        hauntId,
        collateralType: c.collateralType ? String(c.collateralType) : undefined,
      };
    })
    .filter(Boolean);
}

/** @deprecated Use loadBaseStarterCollaterals() — spirit ids only, wrong order/labels. */
export const COLLATERALS_16 = loadBaseStarterCollaterals().map((c) => c.id);

const endpoints = JSON.parse(
  readFileSync(`${ROOT}/config/subgraph.endpoints.json`, "utf8"),
);
function coreSubgraphUrl() {
  return (
    process.env.GOTCHIBOT_SUBGRAPH_CORE_URL?.trim() ||
    process.env.AAVEGOTCHI_SUBGRAPH_UPSTREAM_AAVEGOTCHI_CORE_BASE?.trim() ||
    resolveSubgraphUrl("aavegotchi-core-base")
  );
}

const USERS_GOTCHIS_QUERY = `query GotchisOwnedByUser($owner: String!, $first: Int!, $skip: Int!) {
  users(where: { id: $owner }) {
    gotchisOwned(first: $first, skip: $skip, orderBy: id) {
      id
      gotchiId
      name
      collateral
      hauntId
    }
  }
}`;

const GOTCHIS_BY_OWNER_QUERY = `query GotchisByOwner($owner: String!, $first: Int!, $skip: Int!) {
  aavegotchis(first: $first, skip: $skip, orderBy: gotchiId, where: { owner: $owner }) {
    id
    gotchiId
    name
    collateral
    hauntId
  }
}`;

const GOTCHIS_BY_OWNER_NESTED_QUERY = `query GotchisByOwnerNested($owner: String!, $first: Int!, $skip: Int!) {
  aavegotchis(first: $first, skip: $skip, orderBy: gotchiId, where: { owner_: { id: $owner } }) {
    id
    gotchiId
    name
    collateral
    hauntId
  }
}`;

const AAVEGOTCHI_DIAMOND = "0xA99c4B08201F2913Db8D28e71d020c4298F29dBF";

const CAST_BIN = resolveCastBin();
const BASE_RPC_URLS = [
  process.env.GOTCHIBOT_BASE_RPC,
  process.env.BASE_RPC_URL,
  "https://mainnet.base.org",
  "https://base.llamarpc.com",
].filter(Boolean);
const TOKEN_IDS_OF_OWNER_SELECTOR = "0x9e59e598";
const GET_AAVEGOTCHI_SELECTOR = "0x37c1d569";
const GET_AAVEGOTCHI_CAST_SIG =
  "getAavegotchi(uint256)((uint256,string,address,uint256,uint256,int16[6],int16[6],uint16[16],address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool))";
const RPC_NAME_BATCH = 8;

function encodeGetAavegotchiCalldata(tokenId) {
  const id = BigInt(String(tokenId).trim());
  return `${GET_AAVEGOTCHI_SELECTOR}${id.toString(16).padStart(64, "0")}`;
}

function parseGetAavegotchiCastJson(stdout) {
  try {
    const parsed = JSON.parse(String(stdout || "").trim());
    const row = Array.isArray(parsed?.[0]) ? parsed[0] : Array.isArray(parsed) ? parsed : null;
    if (!row) return null;
    const name = row[1] != null ? String(row[1]).trim() : "";
    return {
      name: name || null,
      hauntId: row[17] != null ? Number(row[17]) : null,
      collateral: row[8] ? String(row[8]) : null,
    };
  } catch {
    return null;
  }
}

function fetchAavegotchiInfoCast(tokenId) {
  let lastErr;
  for (const rpc of baseRpcUrls()) {
    try {
      const r = spawnSync(
        CAST_BIN,
        ["call", AAVEGOTCHI_DIAMOND, GET_AAVEGOTCHI_CAST_SIG, String(tokenId), "--rpc-url", rpc, "--json"],
        { encoding: "utf8", timeout: 20_000 },
      );
      if (r.status !== 0) throw new Error((r.stderr || r.stdout || "cast call failed").trim());
      const info = parseGetAavegotchiCastJson(r.stdout);
      if (info) return info;
      throw new Error("empty getAavegotchi response");
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

async function fetchAavegotchiInfoFetch(tokenId) {
  const call = { to: AAVEGOTCHI_DIAMOND, data: encodeGetAavegotchiCalldata(tokenId) };
  let hex;
  let lastErr;
  for (const rpc of baseRpcUrls()) {
    try {
      hex = await postJsonRpc(rpc, "eth_call", [call, "latest"]);
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!hex) throw lastErr || new Error("getAavegotchi eth_call failed");
  if (!castAvailable()) return null;

  const r = spawnSync(
    CAST_BIN,
    ["abi-decode", GET_AAVEGOTCHI_CAST_SIG, String(hex)],
    { encoding: "utf8", timeout: 10_000 },
  );
  if (r.status !== 0) return null;
  const line = String(r.stdout || "").trim();
  const nameMatch = line.match(/,\s*"((?:\\.|[^"\\])*)"\s*,/);
  if (!nameMatch) return null;
  const name = nameMatch[1].replace(/\\"/g, '"').trim();
  return { name: name || null, hauntId: null, collateral: null };
}

async function fetchAavegotchiInfo(tokenId) {
  if (castAvailable()) {
    try {
      return fetchAavegotchiInfoCast(tokenId);
    } catch {}
  }
  return fetchAavegotchiInfoFetch(tokenId);
}

async function enrichGotchiNamesFromRpc(gotchis) {
  const list = Array.isArray(gotchis) ? gotchis : [];
  const pending = list.filter((g) => !g.name);
  if (!pending.length) return list;

  for (let i = 0; i < pending.length; i += RPC_NAME_BATCH) {
    const chunk = pending.slice(i, i + RPC_NAME_BATCH);
    const infos = await Promise.all(
      chunk.map(async (g) => {
        try {
          return await fetchAavegotchiInfo(g.gotchiId);
        } catch {
          return null;
        }
      }),
    );
    for (let j = 0; j < chunk.length; j++) {
      const info = infos[j];
      if (!info?.name) continue;
      chunk[j].name = info.name;
      if (!chunk[j].hauntId && info.hauntId) chunk[j].hauntId = info.hauntId;
      if (!chunk[j].collateral && info.collateral) chunk[j].collateral = info.collateral;
    }
  }
  return list;
}

function baseRpcUrls() {
  return [...new Set(BASE_RPC_URLS.map((u) => String(u || "").trim()).filter(Boolean))];
}

function castAvailable() {
  try {
    return spawnSync(CAST_BIN, ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

async function postJsonRpc(rpcUrl, method, params, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || "RPC error");
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

function encodeTokenIdsOfOwnerCalldata(owner) {
  const addr = String(owner).toLowerCase().replace(/^0x/, "");
  return `${TOKEN_IDS_OF_OWNER_SELECTOR}${addr.padStart(64, "0")}`;
}

function decodeTokenIdsFromRpcHex(hex) {
  const raw = String(hex || "").replace(/^0x/, "");
  if (raw.length < 128) return [];
  const len = Number.parseInt(raw.slice(64, 128), 16);
  const ids = [];
  for (let i = 0; i < len; i++) {
    const start = 128 + i * 64;
    const slot = raw.slice(start, start + 64);
    if (!slot) break;
    ids.push(String(BigInt(`0x${slot}`)));
  }
  return ids;
}

async function fetchTokenIdsFromRpcFetch(owner) {
  const call = { to: AAVEGOTCHI_DIAMOND, data: encodeTokenIdsOfOwnerCalldata(owner) };
  let lastErr;
  for (const rpc of baseRpcUrls()) {
    try {
      const result = await postJsonRpc(rpc, "eth_call", [call, "latest"]);
      return decodeTokenIdsFromRpcHex(result);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("tokenIdsOfOwner failed on all RPC endpoints");
}

function fetchTokenIdsFromRpcCast(owner) {
  let lastErr;
  for (const rpc of baseRpcUrls()) {
    try {
      const r = spawnSync(
        CAST_BIN,
        [
          "call",
          AAVEGOTCHI_DIAMOND,
          "tokenIdsOfOwner(address)(uint256[])",
          owner,
          "--rpc-url",
          rpc,
          "--json",
        ],
        { encoding: "utf8", timeout: 20_000 },
      );
      if (r.status !== 0) throw new Error((r.stderr || r.stdout || "cast call failed").trim());
      const parsed = JSON.parse(String(r.stdout || "").trim());
      const arr = Array.isArray(parsed?.[0]) ? parsed[0] : Array.isArray(parsed) ? parsed : [];
      return arr.map((n) => String(n));
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("tokenIdsOfOwner failed via cast");
}

async function fetchWalletGotchisFromRpc(owner) {
  const tokenIds = castAvailable()
    ? fetchTokenIdsFromRpcCast(owner)
    : await fetchTokenIdsFromRpcFetch(owner);
  const list = tokenIds.map((gotchiId) => ({
    gotchiId,
    name: null,
    collateral: null,
    hauntId: null,
  }));
  await enrichGotchiNamesFromRpc(list);
  return list;
}

function subgraphHeaders() {
  return { "Content-Type": "application/json", ...infraHeaders() };
}

async function postSubgraph(query, variables, { timeoutMs = 15_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(coreSubgraphUrl(), {
      method: "POST",
      headers: subgraphHeaders(),
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const msg = e?.name === "AbortError" ? "subgraph timed out" : String(e.message || e);
    throw new Error(msg);
  }
  clearTimeout(timer);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    const hint = res.status === 530 ? "Cloudflare tunnel down" : `HTTP ${res.status}`;
    throw new Error(`subgraph unreachable (${hint})`);
  }
  if (!res.ok) throw new Error(`subgraph HTTP ${res.status}`);
  if (body.errors?.length) throw new Error(body.errors[0]?.message ?? "subgraph error");
  return body.data;
}

function normalizeGotchi(g) {
  return {
    gotchiId: String(g.gotchiId ?? g.id),
    name: g.name ?? null,
    collateral: g.collateral ?? null,
    hauntId: g.hauntId ?? null,
  };
}

function dedupeGotchis(list) {
  const seen = new Set();
  const out = [];
  for (const g of list) {
    const id = String(g.gotchiId ?? g.id ?? "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(normalizeGotchi(g));
  }
  return out;
}

async function fetchGotchiPage(query, variables) {
  const data = await postSubgraph(query, variables);
  if (query === USERS_GOTCHIS_QUERY) {
    return data?.users?.[0]?.gotchisOwned ?? [];
  }
  return data?.aavegotchis ?? [];
}

/** Wallet gotchis — Envio subgraph first, Base RPC tokenIdsOfOwner when tunnel is down. */
export async function fetchWalletGotchis(address, { pageSize = 1000, max = 10_000 } = {}) {
  const owner = address.toLowerCase();
  const merged = [];
  let subgraphError = null;

  const loadAll = async (query) => {
    const list = [];
    let skip = 0;
    while (list.length < max) {
      const page = await fetchGotchiPage(query, { owner, first: pageSize, skip });
      if (!page.length) break;
      for (const g of page) list.push(g);
      if (page.length < pageSize) break;
      skip += pageSize;
    }
    return list;
  };

  let primary = [];
  try {
    primary = await loadAll(USERS_GOTCHIS_QUERY);
  } catch (e) {
    subgraphError = e;
    primary = [];
  }
  merged.push(...primary);

  if (merged.length === 0) {
    for (const query of [GOTCHIS_BY_OWNER_QUERY, GOTCHIS_BY_OWNER_NESTED_QUERY]) {
      try {
        const fallback = await loadAll(query);
        if (fallback.length) {
          merged.push(...fallback);
          break;
        }
      } catch (e) {
        subgraphError = subgraphError || e;
      }
    }
  }

  if (merged.length === 0) {
    try {
      const rpc = await fetchWalletGotchisFromRpc(owner);
      if (rpc.length) {
        const out = dedupeGotchis(rpc);
        out.source = "base-rpc";
        return out;
      }
    } catch (e) {
      if (subgraphError) {
        throw new Error(
          `${subgraphError.message || subgraphError}; RPC fallback: ${e.message || e}`,
        );
      }
      throw e;
    }
  }

  const out = dedupeGotchis(merged);
  if (out.some((g) => !g.name)) {
    await enrichGotchiNamesFromRpc(out);
  }
  out.source = "subgraph";
  return out;
}

/** Lookup one gotchi by token id for the connected wallet. */
export async function fetchWalletGotchiById(address, gotchiId) {
  const id = String(gotchiId).replace(/^#/, "").trim();
  if (!/^\d+$/.test(id)) return null;
  const owner = address.toLowerCase();

  try {
    const data = await postSubgraph(
      `query GotchiById($owner: String!, $id: String!) {
        aavegotchis(first: 1, where: { id: $id, owner: { id: $owner } }) {
          id gotchiId name collateral hauntId
        }
      }`,
      { owner, id },
    );
    const hit = data?.aavegotchis?.[0];
    if (hit) return normalizeGotchi(hit);
  } catch {}

  const owned = await fetchWalletGotchis(owner);
  const hit = owned.find((g) => String(g.gotchiId) === id) ?? null;
  if (hit?.name) return hit;

  try {
    const info = await fetchAavegotchiInfo(id);
    if (info?.name) {
      return normalizeGotchi({ gotchiId: id, ...info });
    }
  } catch {}

  return hit;
}

export function commandExists(cmd) {
  return spawnSync("command", ["-v", cmd], { shell: true, stdio: "ignore" }).status === 0;
}

export function readWalletFile() {
  try {
    const w = JSON.parse(readFileSync(WALLET_PATH, "utf8"));
    return w.address?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

export function saveWalletFile(address, source = "metamask") {
  mkdirSync(SESSIONS, { recursive: true });
  writeFileSync(
    WALLET_PATH,
    JSON.stringify({ address: address.toLowerCase(), source, verifiedAt: new Date().toISOString() }, null, 2),
  );
}

export function loadOnboarding() {
  try {
    return JSON.parse(readFileSync(ONBOARDING_PATH, "utf8"));
  } catch {
    return { complete: false };
  }
}

export function saveOnboarding(patch) {
  mkdirSync(SESSIONS, { recursive: true });
  const prev = loadOnboarding();
  writeFileSync(ONBOARDING_PATH, JSON.stringify({ ...prev, ...patch, updatedAt: new Date().toISOString() }, null, 2));
}

export function clearOnboarding() {
  if (existsSync(ONBOARDING_PATH)) {
    try { writeFileSync(ONBOARDING_PATH, JSON.stringify({ complete: false }, null, 2)); } catch {}
  }
}

export function hasServiceKey() {
  return Boolean(process.env.AARCADE_GOTCHIBOT_SERVICE_SECRET);
}

export function runAbraNode(scriptRel, args = []) {
  const script = `${ROOT}/${scriptRel}`;
  if (hasServiceKey()) {
    return spawnSync(process.execPath, [script, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["inherit", "pipe", "pipe"],
    });
  }
  if (!commandExists("abra")) {
    return { status: 1, stderr: "abra not found — run: abra run gotchibot -- ./scripts/gotchibot tmux\n" };
  }
  return spawnSync("abra", ["run", "gotchibot", "--", process.execPath, script, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  });
}

export async function fetchCartridgeHeroes(cartridgeId) {
  const r = await call(`/cartridges/${cartridgeId}`);
  if (!r.ok) return [];
  const c = r.data.cartridge ?? r.data;
  return c.cAavegotchis ?? [];
}

export async function ensureCartridgeForOwner(address) {
  const r = await call("/cartridges/ensure", {
    method: "POST",
    body: { owner: address, gameId: GAME_ID, simPay: true },
  });
  if (!r.ok) throw new Error(JSON.stringify(r.data).slice(0, 300));
  const c = r.data.cartridge ?? r.data;
  const cartridgeId = c.id ?? c.cartridgeId;
  saveMeta({ cartridgeId, owner: address });
  saveOnboarding({ wallet: address, cartridgeId });
  return cartridgeId;
}

function persistMintedHeroColors(heroId, collateral, hero = {}) {
  if (!heroId) return;
  const hauntId = Number(hero.hauntId) || 1;
  const colors = findCollateralColors(collateral || hero.collateral, hauntId);
  persistHeroCollateral(heroId, {
    collateral: colors?.spirit || collateral || hero.collateral,
    collateralName: colors?.name || null,
    hauntId: hauntId || colors?.hauntId || 1,
    primary: colors?.primary,
    secondary: colors?.secondary,
  });
}

export async function bindStarterHero(cartridgeId, collateral) {
  const r = await call(`/cartridges/${cartridgeId}/bind-starter`, {
    method: "POST",
    body: { gameId: GAME_ID, collateral, simPay: true },
  });
  if (!r.ok) throw new Error(JSON.stringify(r.data).slice(0, 300));
  const c = r.data.cartridge ?? r.data;
  const heroes = c.cAavegotchis ?? [];
  const hero = heroes[heroes.length - 1];
  const heroId = hero?.id ?? null;
  persistMintedHeroColors(heroId, collateral, hero);
  return heroId;
}

export async function bindOwnedGotchi(cartridgeId, sourceTokenId, gotchiHint = null) {
  const tokenId = String(sourceTokenId);
  let walletGotchi = gotchiHint && (gotchiHint.collateral || gotchiHint.gotchiId)
    ? gotchiHint
    : null;
  if (!walletGotchi) {
    try {
      const owner = readWalletFile();
      if (owner) walletGotchi = await fetchWalletGotchiById(owner, tokenId);
    } catch {}
  }
  const hauntId = walletGotchi?.hauntId != null ? Number(walletGotchi.hauntId) : null;
  const collAddr = walletGotchi?.collateral || null;
  const colors = findCollateralColors(collAddr || walletGotchi?.collateralName || "", hauntId || 2);
  const spirit = colors?.spirit || libraryNameToSpiritId(walletGotchi?.collateralName || collAddr || "") || null;

  const r = await call(`/cartridges/${cartridgeId}/bind-owned`, {
    method: "POST",
    body: {
      sourceTokenId: tokenId,
      simPay: true,
      collateral: spirit || undefined,
      collateralAddress: collAddr || undefined,
      hauntId,
    },
  });
  if (!r.ok) throw new Error(JSON.stringify(r.data).slice(0, 300));
  const c = r.data.cartridge ?? r.data;
  const hero = c.cAavegotchi ?? (c.cAavegotchis ?? []).find((h) => String(h.sourceTokenId) === tokenId)
    ?? (c.cAavegotchis ?? []).find((h) => h.id === `owned-${tokenId}`)
    ?? (c.cAavegotchis ?? []).slice(-1)[0];
  const heroId = hero?.id ?? `owned-${tokenId}`;
  persistHeroCollateral(heroId, {
    collateral: spirit || hero?.collateral,
    collateralAddress: collAddr || hero?.collateralAddress || hero?.collateral,
    collateralName: colors?.name || walletGotchi?.collateralName || null,
    hauntId: hauntId || hero?.hauntId,
    primary: colors?.primary,
    secondary: colors?.secondary,
    sourceTokenId: tokenId,
  });
  try {
    const idx = loadWalletGotchiIndex();
    const rows = [...idx.values()];
    const row = {
      gotchiId: tokenId,
      tokenId,
      name: walletGotchi?.name || hero?.name || null,
      hauntId,
      collateral: collAddr,
      collateralName: colors?.name || walletGotchi?.collateralName || null,
    };
    const filtered = rows.filter((g) => String(g.gotchiId) !== tokenId);
    filtered.push(row);
    writeWalletGotchiCache({ owner: readWalletFile(), source: "bind-owned", gotchis: filtered });
  } catch {}
  return heroId;
}

export async function mintSubAgentHero(cartridgeId, collateral) {
  const r = await call(`/cartridges/${cartridgeId}/subagents/mint`, {
    method: "POST",
    body: { collateral, simPay: true },
  });
  if (!r.ok) throw new Error(JSON.stringify(r.data).slice(0, 300));
  const c = r.data.cartridge ?? r.data;
  const heroes = c.cAavegotchis ?? [];
  const hero = heroes[heroes.length - 1];
  const heroId = hero?.id ?? null;
  persistMintedHeroColors(heroId, collateral, hero);
  return heroId;
}

export async function selectOrchestratorHero(cartridgeId, heroId) {
  const r = await call(`/cartridges/${cartridgeId}/select-hero`, {
    method: "POST",
    body: { cAavegotchiId: heroId },
  });
  if (!r.ok) throw new Error(JSON.stringify(r.data).slice(0, 300));
}

export function pinAvatar(heroId, { asOrchestrator = true } = {}) {
  mkdirSync(SESSIONS, { recursive: true });
  writeFileSync(PIN_PATH, `${heroId}\n`);
  saveMeta({ activeHeroId: heroId });
  if (asOrchestrator) {
    saveOnboarding({ orchestratorHeroId: heroId });
  }
  // Refresh official SVG in background (subgraph → sessions/.avatars/<id>.svg)
  try {
    const child = spawn(process.execPath, [`${ROOT}/scripts/gotchi-svg.mjs`, "--force", heroId], {
      cwd: ROOT,
      stdio: "ignore",
      detached: true,
    });
    child.unref();
  } catch {}
}

export async function isOnboarded() {
  const ob = loadOnboarding();
  if (!ob.complete || !ob.orchestratorHeroId) return false;
  const wallet = readWalletFile();
  if (!wallet) return false;
  const meta = loadMeta();
  if (!meta?.cartridgeId) return false;
  const heroes = await fetchCartridgeHeroes(meta.cartridgeId);
  return heroes.some((h) => h.id === ob.orchestratorHeroId);
}

export function readWelcomeArt(maxLines = 18) {
  try {
    return readFileSync(ART_PATH, "utf8").split("\n").slice(0, maxLines).join("\n");
  } catch {
    return "  GotchiBot — Aavegotchi orchestrator";
  }
}

export function resolveOwner() {
  return readWalletFile();
}

function isDirectCheck() {
  return process.argv[1]?.endsWith("onboarding-lib.mjs") && process.argv[2] === "check";
}

if (isDirectCheck()) {
  isOnboarded().then((ok) => process.exit(ok ? 0 : 1));
}
