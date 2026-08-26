#!/usr/bin/env node
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
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
  const o = process.env.GOTCHIBOT_OWNER;
  if (!o) {
    console.error("owner wallet missing. Set it once:\n" +
      "  abra set gotchibot GOTCHIBOT_OWNER   # paste your address");
    process.exit(1);
  }
  return o;
}

async function call(path, { method = "GET", body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-aarcade-service-key": serviceKey(),
    },
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
  const meta = loadMeta();
  if (!meta?.cartridgeId) {
    console.error("no cartridge yet — run: gotchibot identity ensure");
    process.exit(1);
  }
  const r = await call(`/cartridges/${meta.cartridgeId}/portals/mint`, {
    method: "POST",
    body: { quantity: 1, gameId: GAME_ID },
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
  const meta = loadMeta();
  if (!meta?.cartridgeId) {
    console.error("no cartridge yet — run: gotchibot identity ensure");
    process.exit(1);
  }
  const sessionId = process.env.GOTCHIBOT_CHECKPOINT_SESSION;
  const label = process.env.GOTCHIBOT_CHECKPOINT_LABEL ?? "milestone";
  let gameState = {};
  if (sessionId) {
    const dir = resolve(ROOT, "sessions", sessionId);
    try {
      gameState = {
        sessionId,
        prompt: readFileSync(`${dir}/prompt.txt`, "utf8").slice(0, 2000),
        output: readFileSync(`${dir}/output.md`, "utf8").slice(0, 8000),
      };
    } catch {
      gameState = { sessionId, note: "session files unavailable" };
    }
  } else {
    gameState = { note: label, at: new Date().toISOString() };
  }

  const r = await call(`/cartridges/${meta.cartridgeId}/checkpoint`, {
    method: "POST",
    body: { gameId: GAME_ID, gameState, signature: null, message: null, label },
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

const cmd = process.argv[2];
const handlers = { ensure, mint, roster, rules, checkpoint };
if (!handlers[cmd]) {
  console.error("usage: identity.mjs ensure|mint|roster|rules|checkpoint");
  process.exit(2);
}
handlers[cmd]().catch((e) => { console.error(e.message); process.exit(1); });
