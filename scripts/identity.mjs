#!/usr/bin/env node
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(readFileSync(`${ROOT}/config/subgraph.endpoints.json`, "utf8"));
const BASE = (process.env.GOTCHIBOT_CARTRIDGE_URL ?? cfg.identityLayer.cartridgeSim)
  .replace(/\/$/, "");
const API = `${BASE}/api/cartridge-sim`;
const GAME_ID = "gotchibot";

function serviceKey() {
  const key = process.env.AARCADE_GOTCHIBOT_SERVICE_SECRET;
  if (!key) {
    console.error(
      "service key missing. Run through abracadabra:\n" +
      "  abra run gotchibot -- ./scripts/gotchibot identity ensure"
    );
    process.exit(1);
  }
  return key;
}

function owner() {
  if (process.env.GOTCHIBOT_OWNER) return process.env.GOTCHIBOT_OWNER;
  try {
    const w = JSON.parse(readFileSync(`${ROOT}/sessions/.wallet.json`, "utf8"));
    if (w.address) return w.address;
  } catch {}
  console.error("no wallet. Connect once:\n" +
    "  ./scripts/gotchibot connect   # MetaMask popup in browser");
  process.exit(1);
}

async function call(path, { method = "GET", body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (process.env.AARCADE_GOTCHIBOT_SERVICE_SECRET) {
    headers["x-aarcade-service-key"] = process.env.AARCADE_GOTCHIBOT_SERVICE_SECRET;
  }
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
  return { status: res.status, ok: res.ok, data };
}

function print(result) {
  console.log(JSON.stringify(result.data, null, 2));
  if (!result.ok) process.exitCode = 1;
}

async function ensure() {
  serviceKey();
  const r = await call("/cartridges/ensure", {
    method: "POST",
    body: { owner: owner(), gameId: GAME_ID },
  });
  if (r.ok) {
    const c = r.data.cartridge ?? r.data;
    saveMeta({ cartridgeId: c.id ?? c.cartridgeId, owner: owner() });
  }
  print(r);
}

async function mint() {
  serviceKey();
  const meta = loadMeta();
  if (!meta?.cartridgeId) {
    console.error("no cartridge yet — run: gotchibot identity ensure");
    process.exit(1);
  }
  const r = await call(`/cartridges/${meta.cartridgeId}/portals/mint`, {
    method: "POST",
    body: { quantity: 10, gameId: GAME_ID },
  });
  if (r.status === 401 || r.status === 403) {
    console.error(
      "portals/mint does not accept service keys yet (session-auth only).\n" +
      "Server-side work pending: add x-aarcade-service-key acceptance to\n" +
      "AarcadeGh-t api/routes/cartridge-sim.js portals/mint route."
    );
    process.exit(2);
  }
  print(r);
}

async function roster() {
  const r = await call(`/cartridges?owner=${encodeURIComponent(owner())}&gameId=${GAME_ID}`);
  print(r);
}

async function rules() {
  const r = await call(`/rules/${GAME_ID}`);
  print(r);
}

async function checkpoint() {
  serviceKey();
  const meta = loadMeta();
  if (!meta?.cartridgeId) {
    console.error("no cartridge yet — run: gotchibot identity ensure");
    process.exit(1);
  }
  const sessionId = process.env.GOTCHIBOT_CHECKPOINT_SESSION;
  const label = process.env.GOTCHIBOT_CHECKPOINT_LABEL ?? "milestone";
  let gameState = { schemaVersion: 1 };
  if (sessionId) {
    const dir = resolve(ROOT, "sessions", sessionId);
    try {
      gameState.agents = {
        orchestrator: { cAavegotchiId: "orchestrator", status: "active" },
        "sub-agents": [
          {
            id: `sub-${sessionId}`,
            cAavegotchiId: sessionId,
            runtime: "opencode",
            model: process.env.GOTCHIBOT_CHECKPOINT_MODEL ?? "",
            status: "completed",
            task: label,
            startedAt: null,
          },
        ],
      };
      gameState.handoff = {
        knowledgeFiles: [],
        prompt: readFileSync(`${dir}/prompt.txt`, "utf8").slice(0, 2000),
        output: readFileSync(`${dir}/output.md`, "utf8").slice(0, 8000),
      };
    } catch {
      gameState.note = "session files unavailable";
    }
  } else {
    gameState.agents = { orchestrator: { status: "idle" }, "sub-agents": [] };
    gameState.handoff = { note: label, at: new Date().toISOString() };
  }

  const r0 = await call(`/cartridges/${meta.cartridgeId}`);
  if (!r0.ok) { print(r0); return; }
  const snap = r0.data.cartridge ?? r0.data;
  const nonce = (snap.checkpoint?.nonce || 0) + 1;

  const stableStringify = (obj) => JSON.stringify(obj, Object.keys(obj).sort());
  const stateHash = "0x" + crypto.createHash("sha256").update(stableStringify(gameState)).digest("hex");
  const message = [
    "Aarcade cartridge checkpoint",
    `cartridgeId: ${meta.cartridgeId}`,
    `nonce: ${nonce}`,
    `stateHash: ${stateHash}`,
  ].join("\n");

  const r = await call(`/cartridges/${meta.cartridgeId}/checkpoint`, {
    method: "POST",
    body: {
      gameId: GAME_ID,
      gameState,
      signature: "service-key",
      message,
      label,
    },
  });
  print(r);
}

function metaPath() { return `${ROOT}/sessions/.identity.json`; }
function loadMeta() {
  try { return JSON.parse(readFileSync(metaPath(), "utf8")); } catch { return null; }
}
function saveMeta(m) {
  const prev = loadMeta() ?? {};
  mkdirSync(dirname(metaPath()), { recursive: true });
  writeFileSync(metaPath(), JSON.stringify({ ...prev, ...m }, null, 2));
}

async function seal() {
  serviceKey();
  const meta = loadMeta();
  if (!meta?.cartridgeId) {
    console.error("no cartridge yet — run: gotchibot identity ensure");
    process.exit(1);
  }
  const batchId = process.env.GOTCHIBOT_BATCH_ID;
  if (!batchId) {
    console.error("set GOTCHIBOT_BATCH_ID to the pack batchId to seal");
    process.exit(1);
  }
  const words = Array.from({ length: 30 }, () =>
    `0x${crypto.randomBytes(32).toString("hex")}`
  );
  const r = await call(`/cartridges/${meta.cartridgeId}/portals/fulfill`, {
    method: "POST",
    body: { batchId, entropyWords: words, requestId: `dev-${Date.now()}` },
  });
  print(r);
}

async function unpack() {
  serviceKey();
  const meta = loadMeta();
  if (!meta?.cartridgeId) {
    console.error("no cartridge yet — run: gotchibot identity ensure");
    process.exit(1);
  }
  const batchId = process.env.GOTCHIBOT_BATCH_ID;
  if (!batchId) {
    console.error("set GOTCHIBOT_BATCH_ID to the sealed pack batchId");
    process.exit(1);
  }
  const r = await call(`/cartridges/${meta.cartridgeId}/portals/open-pack`, {
    method: "POST",
    body: { packId: batchId },
  });
  print(r);
}

async function open() {
  serviceKey();
  const meta = loadMeta();
  if (!meta?.cartridgeId) {
    console.error("no cartridge yet — run: gotchibot identity ensure");
    process.exit(1);
  }
  const portalId = process.argv[3] ?? process.env.GOTCHIBOT_PORTAL_ID;
  if (!portalId) {
    console.error("usage: identity.mjs open <portalId>");
    process.exit(1);
  }
  const r = await call(`/cartridges/${meta.cartridgeId}/portals/${portalId}/open`, {
    method: "POST",
    body: {},
  });
  print(r);
}

async function bind() {
  serviceKey();
  const meta = loadMeta();
  if (!meta?.cartridgeId) {
    console.error("no cartridge yet — run: gotchibot identity ensure");
    process.exit(1);
  }
  const r = await call(`/cartridges/${meta.cartridgeId}/bind-starter`, {
    method: "POST",
    body: { gameId: GAME_ID },
  });
  print(r);
}

async function apply() {
  serviceKey();
  const meta = loadMeta();
  if (!meta?.cartridgeId) {
    console.error("no cartridge yet — run: gotchibot identity ensure");
    process.exit(1);
  }
  const portalId = process.argv[3] ?? process.env.GOTCHIBOT_PORTAL_ID;
  const heroId = process.argv[4] ?? process.env.GOTCHIBOT_HERO_ID;
  if (!portalId || !heroId) {
    console.error("usage: identity.mjs apply <portalId> <cAavegotchiId>");
    process.exit(1);
  }
  const r = await call(`/cartridges/${meta.cartridgeId}/portals/${portalId}/apply`, {
    method: "POST",
    body: { cAavegotchiId: heroId },
  });
  print(r);
}

export { call, loadMeta, saveMeta, owner, serviceKey, GAME_ID, API };

function isDirectRun() {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const cmd = process.argv[2];
  const handlers = { ensure, mint, seal, unpack, open, bind, apply, roster, rules, checkpoint };
  if (!handlers[cmd]) {
    console.error("usage: identity.mjs ensure|mint|seal|unpack|open|bind|apply|roster|rules|checkpoint");
    process.exit(2);
  }
  handlers[cmd]().catch((e) => { console.error(e.message); process.exit(1); });
}
