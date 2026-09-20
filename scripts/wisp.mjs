#!/usr/bin/env node
/**
 * Wisp (Gotchi Closet) — soul MCP + companion chat for GotchiBot.
 *
 * Free plan: MCP tools (get_soul, build_chat_context, …). Hosted chat needs paid/partner.
 * Keys: WISP_API_KEY or sessions/.wisp.env — never print wsp_ values.
 *
 *   node scripts/wisp.mjs status [--json]
 *   node scripts/wisp.mjs mint [--wallet 0x…]   # free key; stores locally, does not print
 *   node scripts/wisp.mjs env                  # export lines for chat-pane (redacts in errors)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = `${ROOT}/sessions`;
const ENV_FILE = `${SESSIONS}/.wisp.env`;
const STATE = `${SESSIONS}/.wisp.json`;
const BASE = (process.env.WISP_BASE_URL || "https://api.gotchicloset.com").replace(/\/$/, "");
const MCP_URL = `${BASE}/mcp`;

function loadWallet() {
  const override = process.env.WISP_WALLET?.trim() || process.argv.find((a, i, arr) => arr[i - 1] === "--wallet");
  if (override && /^0x[a-fA-F0-9]{40}$/.test(override)) return override;
  try {
    const w = JSON.parse(readFileSync(`${SESSIONS}/.wallet.json`, "utf8"));
    const a = String(w.address || w.wallet || "").trim();
    if (/^0x[a-fA-F0-9]{40}$/.test(a)) return a;
  } catch {}
  return "";
}

function loadKey() {
  const fromEnv = process.env.WISP_API_KEY?.trim() || "";
  if (fromEnv.startsWith("wsp_")) return fromEnv;
  if (!existsSync(ENV_FILE)) return "";
  try {
    const raw = readFileSync(ENV_FILE, "utf8");
    const m = raw.match(/^WISP_API_KEY=(.+)$/m);
    const v = (m?.[1] || "").trim().replace(/^["']|["']$/g, "");
    return v.startsWith("wsp_") ? v : "";
  } catch {
    return "";
  }
}

function saveKey(apiKey, plan) {
  mkdirSync(SESSIONS, { recursive: true });
  writeFileSync(ENV_FILE, `WISP_API_KEY=${apiKey}\n`, { mode: 0o600 });
  try { chmodSync(ENV_FILE, 0o600); } catch {}
  const prev = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
  writeFileSync(
    STATE,
    `${JSON.stringify({ ...prev, plan: plan || prev.plan || "free", mcpUrl: MCP_URL, updatedAt: new Date().toISOString(), keyStored: true }, null, 2)}\n`,
  );
}

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    return {};
  }
}

async function accountGet(key) {
  const r = await fetch(`${BASE}/api/mcp/account`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
  return { ok: r.ok, status: r.status, body };
}

async function cmdStatus(json) {
  const key = loadKey();
  const wallet = loadWallet();
  const state = loadState();
  const out = {
    configured: Boolean(key),
    keySource: process.env.WISP_API_KEY?.startsWith("wsp_") ? "env" : key ? "sessions/.wisp.env" : null,
    plan: state.plan || null,
    mcpUrl: MCP_URL,
    wallet: wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : null,
    model: "wisp/gotchi",
    note: "Free key = MCP tools. Hosted companion chat needs paid/partner. Never print wsp_ keys.",
  };
  if (key) {
    try {
      const a = await accountGet(key);
      out.accountOk = a.ok;
      out.accountStatus = a.status;
      if (a.ok && a.body) {
        out.plan = a.body.plan || out.plan;
        out.chatInPlan = a.body.chatInPlan ?? a.body.features?.chat ?? null;
      } else {
        out.accountError = a.body?.message || a.body?.error || `http ${a.status}`;
      }
    } catch (e) {
      out.accountOk = false;
      out.accountError = String(e.message || e);
    }
  }
  if (json) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`wisp: ${out.configured ? "key stored" : "no key"} · plan ${out.plan || "?"}`);
    console.log(`  mcp  ${out.mcpUrl}`);
    if (out.wallet) console.log(`  wallet ${out.wallet}`);
    if (out.accountOk === false) console.log(`  account check failed (${out.accountError})`);
    else if (out.accountOk) console.log(`  account ok${out.chatInPlan === false ? " · hosted chat not in plan (MCP OK)" : ""}`);
    console.log(`  model: /model wisp/gotchi  (proxy: ./scripts/gotchibot wisp-proxy)`);
    console.log(`  mint: ./scripts/gotchibot wisp mint`);
  }
}

async function cmdMint() {
  const wallet = loadWallet();
  if (!wallet) {
    console.error("need connected wallet (sessions/.wallet.json) or --wallet 0x…");
    process.exit(1);
  }
  if (loadKey()) {
    console.log("wisp key already stored (sessions/.wisp.env or WISP_API_KEY). status:");
    await cmdStatus(false);
    return;
  }
  const r = await fetch(`${BASE}/api/mcp/account`, {
    method: "POST",
    headers: { "content-type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ wallet }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !String(body.apiKey || "").startsWith("wsp_")) {
    console.error(`mint failed (http ${r.status}): ${body.message || body.error || "no apiKey"}`);
    process.exit(1);
  }
  saveKey(body.apiKey, body.plan || "free");
  console.log(`wisp: free key stored for ${wallet.slice(0, 6)}…${wallet.slice(-4)} (plan=${body.plan || "free"})`);
  console.log("  key path: sessions/.wisp.env (mode 600) — not printed");
  console.log("  optional: abra set gotchibot WISP_API_KEY  (paste once; keep out of chat)");
  console.log("  then: ./scripts/gotchibot wisp-proxy  +  /model wisp/gotchi");
}

function cmdEnv() {
  const key = loadKey();
  if (!key) {
    console.error("no WISP_API_KEY — run: ./scripts/gotchibot wisp mint");
    process.exit(1);
  }
  console.log(`export WISP_API_KEY=${JSON.stringify(key)}`);
  console.log(`export WISP_BASE_URL=${JSON.stringify(BASE)}`);
  console.log(`export GOTCHIBOT_WISP_MCP=${JSON.stringify(MCP_URL)}`);
}

const cmd = process.argv[2] || "status";
const json = process.argv.includes("--json");
if (cmd === "status") cmdStatus(json).catch((e) => { console.error(e.message || e); process.exit(1); });
else if (cmd === "mint") cmdMint().catch((e) => { console.error(e.message || e); process.exit(1); });
else if (cmd === "env") cmdEnv();
else {
  console.error("usage: wisp.mjs status|mint|env [--json] [--wallet 0x…]");
  process.exit(2);
}
