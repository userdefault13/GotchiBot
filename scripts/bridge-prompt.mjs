#!/usr/bin/env node
/**
 * Desk → Hub Claude bridge.
 *
 * From the MacBook (Desk):
 *   abra run gotchibot -- ./scripts/gotchibot bridge "hello"
 *   ./scripts/gotchibot bridge "…"          # if REMOTE_* already in env
 *
 * Flow:
 *   Desk SSH → Hub POST :45678/prompt → VS Code Claude terminal (+ optional -p)
 *   → Hub POSTs result → Desk :45679 → this script prints the response (--wait)
 */
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RECEIVER_DEFAULT = process.env.GOTCHIBOT_RECEIVER_URL || "http://127.0.0.1:45679";
const BRIDGE_LOCAL = process.env.GOTCHIBOT_BRIDGE_URL || "http://127.0.0.1:45678/prompt";

function usage() {
  console.error(`usage:
  bridge-prompt.mjs [--host auto|imac|local] [--wait|--no-wait] [--timeout SEC]
                    [--id <id>] [--url <url>] [--receiver <url>] [--json] <prompt…>
  bridge-prompt.mjs --check [--host auto|imac|local]

Desk (MBP) default: --host auto (SSH to Hub) + --wait (poll local receiver).
Hub (iMac) local:   --host local --no-wait`);
  process.exit(2);
}

const args = process.argv.slice(2);
let id = `gb-${randomUUID().slice(0, 8)}`;
let host = "auto";
let url = BRIDGE_LOCAL;
let receiverUrl = RECEIVER_DEFAULT;
let jsonOut = false;
let check = false;
let wait = true;
let timeoutSec = 180;
const promptParts = [];

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--id") id = args[++i] || id;
  else if (a === "--url") url = args[++i] || url;
  else if (a === "--receiver") receiverUrl = args[++i] || receiverUrl;
  else if (a === "--host") host = (args[++i] || host).toLowerCase();
  else if (a === "--timeout") timeoutSec = Number(args[++i]) || timeoutSec;
  else if (a === "--json") jsonOut = true;
  else if (a === "--check") check = true;
  else if (a === "--wait") wait = true;
  else if (a === "--no-wait") wait = false;
  else if (a === "-h" || a === "--help") usage();
  else promptParts.push(a);
}

const prompt = promptParts.join(" ").trim();

async function loadRemote() {
  return import(join(__dirname, "remote-lib.mjs"));
}

function resolveHostMode(mode) {
  if (mode === "local" || mode === "imac") return mode;
  // auto: if REMOTE_HOST is set (abra), prefer Hub; else try local then Hub
  if (process.env.REMOTE_HOST || process.env.GOTCHIBOT_REMOTE_HOST) return "imac";
  return "auto";
}

async function postLocal(promptUrl, body) {
  const res = await fetch(promptUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  return { res, text };
}

async function postViaSsh(body) {
  const { assertRemoteReady, materializeKey, runSsh } = await loadRemote();
  const cfg = assertRemoteReady();
  const mat = materializeKey(cfg.key);
  try {
    // Write body to temp on remote via stdin-safe python
    const b64 = Buffer.from(body, "utf8").toString("base64");
    const remote = `python3 -c "import base64,urllib.request; d=base64.b64decode('${b64}'); r=urllib.request.Request('http://127.0.0.1:45678/prompt',data=d,headers={'Content-Type':'application/json'},method='POST'); print(urllib.request.urlopen(r,timeout=15).read().decode())"`;
    const r = runSsh(cfg, mat.path, remote, { stdio: "pipe", timeout: 30000 });
    if (r.status !== 0) {
      const err = (r.stderr || r.stdout || `ssh exit ${r.status}`).toString().trim();
      throw new Error(err || "ssh bridge POST failed");
    }
    const text = String(r.stdout || "").trim();
    return { res: { ok: true, status: 202 }, text };
  } finally {
    mat.dispose();
  }
}

async function checkLocalBridge() {
  try {
    await fetch(url.replace(/\/prompt$/, "/") || "http://127.0.0.1:45678/", {
      method: "GET",
      signal: AbortSignal.timeout(3000),
    });
    return { ok: true, where: "local", url };
  } catch {
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(3000),
      });
      return { ok: true, where: "local", url, note: "reachable" };
    } catch (e) {
      return { ok: false, where: "local", error: e?.message || String(e) };
    }
  }
}

async function checkHubBridge() {
  try {
    const { assertRemoteReady, materializeKey, runSsh } = await loadRemote();
    const cfg = assertRemoteReady();
    const mat = materializeKey(cfg.key);
    try {
      const remote = `python3 -c "import urllib.request; urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:45678/prompt',data=b'{}',headers={'Content-Type':'application/json'},method='POST'),timeout=5); print('ok')"`;
      const r = runSsh(cfg, mat.path, remote, { stdio: "pipe", timeout: 20000 });
      const out = String(r.stdout || "").trim();
      // 400 missing prompt still means server up
      return { ok: r.status === 0 || /ok|missing|400|invalid/i.test(out + String(r.stderr || "")), where: "imac", raw: out };
    } finally {
      mat.dispose();
    }
  } catch (e) {
    return { ok: false, where: "imac", error: e?.message || String(e) };
  }
}

async function checkReceiver() {
  try {
    const r = await fetch(`${receiverUrl.replace(/\/$/, "")}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, ...j };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

function ensureLocalReceiver() {
  const health = `${receiverUrl.replace(/\/$/, "")}/health`;
  try {
    const ping = spawnSync("curl", ["-sf", "--max-time", "2", health], { encoding: "utf8" });
    if (ping.status === 0) return true;
  } catch {
    /* fall through */
  }
  const candidates = [
    join(process.env.HOME || "", "Dev/gotchibot-bridge/mbp-receiver/receiver.js"),
    join(process.env.HOME || "", "dev/gotchibot-bridge/mbp-receiver/receiver.js"),
  ];
  const script = candidates.find((p) => existsSync(p));
  if (!script) return false;
  const child = spawn(process.execPath, [script], {
    cwd: dirname(script),
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  spawnSync("sleep", ["0.7"]);
  const ping2 = spawnSync("curl", ["-sf", "--max-time", "2", health], { encoding: "utf8" });
  return ping2.status === 0;
}

async function waitForResult(resultId) {
  const base = receiverUrl.replace(/\/$/, "");
  const deadline = Date.now() + timeoutSec * 1000;
  let lastErr;
  let receiverNudge = 0;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/result/${encodeURIComponent(resultId)}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (r.status === 200) return await r.json();
      if (r.status !== 404) {
        lastErr = `receiver HTTP ${r.status}`;
      }
    } catch (e) {
      lastErr = e?.message || String(e);
      if (receiverNudge < 2) {
        receiverNudge += 1;
        ensureLocalReceiver();
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timeout after ${timeoutSec}s waiting for id=${resultId}${lastErr ? ` (${lastErr})` : ""}`);
}

async function main() {
  const mode = resolveHostMode(host);

  if (check) {
    const receiver = await checkReceiver();
    let bridge;
    if (mode === "local") bridge = await checkLocalBridge();
    else if (mode === "imac") bridge = await checkHubBridge();
    else {
      bridge = await checkLocalBridge();
      if (!bridge.ok) bridge = await checkHubBridge();
    }
    const out = { bridge, receiver };
    console.log(JSON.stringify(out, null, jsonOut ? 0 : 2));
    if (!bridge.ok || !receiver.ok) process.exit(1);
    return;
  }

  if (!prompt) usage();

  const body = JSON.stringify({ id, prompt });
  let accepted;
  let usedHost = mode;

  try {
    if (mode === "local") {
      const { res, text } = await postLocal(url, body);
      if (!res.ok) {
        console.error(`bridge rejected (${res.status}): ${text.slice(0, 300)}`);
        process.exit(1);
      }
      accepted = JSON.parse(text);
    } else if (mode === "imac") {
      const { text } = await postViaSsh(body);
      accepted = JSON.parse(text);
      usedHost = "imac";
    } else {
      // auto: local first, then Hub SSH
      try {
        const { res, text } = await postLocal(url, body);
        if (!res.ok) throw new Error(`local ${res.status}`);
        accepted = JSON.parse(text);
        usedHost = "local";
      } catch {
        const { text } = await postViaSsh(body);
        accepted = JSON.parse(text);
        usedHost = "imac";
      }
    }
  } catch (e) {
    console.error(`bridge POST failed: ${e?.message || e}`);
    console.error("Is VS Code open on the Hub (iMac) with gotchibot-bridge active?");
    console.error("From Desk use: abra run gotchibot -- ./scripts/gotchibot bridge \"…\"");
    process.exit(1);
  }

  if (jsonOut && !wait) {
    console.log(JSON.stringify({ ok: true, id, host: usedHost, accepted }));
    return;
  }

  if (!wait) {
    console.log(`accepted id=${id} host=${usedHost} → waiting disabled; check Desk receiver`);
    return;
  }

  if (!ensureLocalReceiver()) {
    console.error("Desk receiver not reachable on :45679 — start: node ~/Dev/gotchibot-bridge/mbp-receiver/receiver.js");
    process.exit(1);
  }

  if (!jsonOut) {
    console.error(`accepted id=${id} host=${usedHost}; waiting up to ${timeoutSec}s for Claude…`);
  }

  let result;
  try {
    result = await waitForResult(id);
  } catch (e) {
    console.error(e?.message || e);
    console.error(`Start Desk receiver: node ~/Dev/gotchibot-bridge/mbp-receiver/receiver.js`);
    console.error(`And set Hub extension runHeadlessCli=true so text forwards to Desk.`);
    process.exit(1);
  }

  if (jsonOut) {
    console.log(JSON.stringify({ ok: !!result.ok, id, host: usedHost, result }));
  } else {
    const text = String(result.response ?? "").trimEnd();
    console.log(text);
  }
  if (result.ok === false) process.exit(1);
}

await main();
