#!/usr/bin/env node
/**
 * Enable / status for user-owned Hub (Tailscale MagicDNS on install record).
 * Writes sessions/.hub.json for remote-lib (path override: GOTCHIBOT_HUB_PIN).
 * writeHubPin preserves desk pairing fields (deskId/deskToken/…) across Arcade refreshes.
 *
 * Hub metadata (enable / arcade-status / chat-store) → www (soloApiBase).
 * Chat bodies → deskApiBase (user Hub), not this script.
 *
 *   gotchibot hub enable <tailscaleHost>
 *   gotchibot hub pin | arcade-status
 *   gotchibot hub chat-store --kind local|atlas|none [--db-name GotchiBot] [--atlas-host …]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { isMainModule } from "./is-main.mjs";
import { infraHeaders, soloApiBase, hasInstallToken, hubPinPath } from "./infra-client.mjs";
import {
  hasAbra,
  resolveCastBin,
  abraInstallHint,
} from "./platform.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = `${ROOT}/sessions`;
const HUB_PIN = `${SESSIONS}/.hub.json`;
const WALLET_PATH = `${SESSIONS}/.wallet.json`;
const INSTALL_ID_PATH = `${SESSIONS}/.install-id`;
const SIGN_PORT = Number(process.env.GOTCHIBOT_HUB_SIGN_PORT ?? 8790);

function readWallet() {
  try {
    return JSON.parse(readFileSync(WALLET_PATH, "utf8")).address?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

function readInstallId() {
  if (!existsSync(INSTALL_ID_PATH)) {
    throw new Error("no install id — run: gotchibot infra register");
  }
  return readFileSync(INSTALL_ID_PATH, "utf8").trim();
}

function buildEnableMessage(wallet, installId, tailscaleHost) {
  return [
    "Enable GotchiBot Hub",
    `wallet: ${wallet}`,
    `installId: ${installId}`,
    `tailscaleHost: ${tailscaleHost}`,
    `kind: owned`,
  ].join("\n");
}

function writeHubPin(hub, installId, extras = {}) {
  const pinPath = hubPinPath();
  mkdirSync(dirname(pinPath), { recursive: true });
  let prev = {};
  try {
    prev = JSON.parse(readFileSync(pinPath, "utf8"));
  } catch {
    /* no prior pin */
  }
  const pin = {
    kind: hub.kind || "owned",
    enabled: Boolean(hub.enabled),
    tailscaleHost: hub.tailscaleHost,
    enabledAt: hub.enabledAt,
    chatStore: hub.chatStore || prev.chatStore || null,
    deskApiBase: extras.deskApiBase || prev.deskApiBase || null,
    // Preserve desk pairing across Arcade enable/status/chat-store refreshes
    deskId: extras.deskId ?? prev.deskId ?? undefined,
    deskToken: extras.deskToken ?? prev.deskToken ?? undefined,
    deskName: extras.deskName ?? prev.deskName ?? undefined,
    pairedAt: extras.pairedAt ?? prev.pairedAt ?? undefined,
    installId,
    writtenAt: new Date().toISOString(),
  };
  // Drop undefined so we don't wipe fields with JSON null-ish noise
  for (const k of ["deskId", "deskToken", "deskName", "pairedAt"]) {
    if (pin[k] === undefined) delete pin[k];
  }
  writeFileSync(pinPath, `${JSON.stringify(pin, null, 2)}\n`, { mode: 0o600 });
  return pin;
}

function readHubPin() {
  try {
    return JSON.parse(readFileSync(HUB_PIN, "utf8"));
  } catch {
    return null;
  }
}

/** Arcade metadata — www (may rewrite to home for hub routes). */
async function api(method, path, { body } = {}) {
  const base = soloApiBase();
  const headers = { ...infraHeaders(), "Content-Type": "application/json" };
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

function castSign(message) {
  const cast = resolveCastBin();
  if (!cast) throw new Error("cast not found — install foundry or use browser sign");
  const r = spawnSync(cast, ["wallet", "sign", "--message", message], {
    encoding: "utf8",
    env: process.env,
  });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || "cast sign failed");
  const sig = String(r.stdout || "").trim();
  if (!/^0x[0-9a-fA-F]+$/.test(sig)) throw new Error("cast did not return a signature");
  return sig;
}

/** Minimal browser sign page (same pattern as infra-token). */
function browserSign(message, wallet) {
  return new Promise((resolvePromise, reject) => {
    const html = `<!doctype html><meta charset=utf-8><title>Enable Hub</title>
<body style="font-family:system-ui;max-width:40rem;margin:2rem auto;padding:0 1rem">
<h1>Enable GotchiBot Hub</h1>
<p>Wallet <code>${wallet}</code></p>
<pre id=msg style="white-space:pre-wrap;background:#111;color:#eee;padding:1rem"></pre>
<button id=go>Sign with MetaMask</button>
<p id=st></p>
<script>
const MESSAGE = ${JSON.stringify(message)};
const WALLET = ${JSON.stringify(wallet)};
document.getElementById('msg').textContent = MESSAGE;
document.getElementById('go').onclick = async () => {
  const st = document.getElementById('st');
  try {
    const eth = window.ethereum;
    if (!eth) throw new Error('No MetaMask');
    const accs = await eth.request({ method: 'eth_requestAccounts' });
    if ((accs[0]||'').toLowerCase() !== WALLET) throw new Error('Switch to '+WALLET);
    const signature = await eth.request({ method: 'personal_sign', params: [MESSAGE, accs[0]] });
    await fetch('/done', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ signature }) });
    st.textContent = 'Signed — you can close this tab.';
  } catch (e) { st.textContent = e.message || e; }
};
</script></body>`;
    const server = http.createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
        return;
      }
      if (req.method === "POST" && req.url === "/done") {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        try {
          const { signature } = JSON.parse(raw);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true}');
          server.close();
          resolvePromise(signature);
        } catch (e) {
          res.writeHead(400);
          res.end("bad");
          reject(e);
        }
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(SIGN_PORT, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${SIGN_PORT}/`;
      console.log(`Open to sign: ${url}`);
      if (process.platform === "darwin") spawnSync("open", [url], { stdio: "ignore" });
    });
    setTimeout(() => {
      server.close();
      reject(new Error("sign timeout"));
    }, 5 * 60 * 1000);
  });
}

async function cmdEnable(host) {
  const wallet = readWallet();
  const installId = readInstallId();
  if (!wallet) throw new Error("no wallet — gotchibot connect");
  const message = buildEnableMessage(wallet, installId, host);
  let signature;
  if (process.env.GOTCHIBOT_HUB_SIGN === "cast") {
    signature = castSign(message);
  } else {
    try {
      signature = await browserSign(message, wallet);
    } catch {
      console.log("Browser sign failed — trying cast…");
      signature = castSign(message);
    }
  }
  const result = await api("POST", "/api/gotchibot/hub/enable", {
    body: { wallet, installId, tailscaleHost: host, message, signature },
  });
  const pin = writeHubPin(result.hub, installId);
  console.log(`Hub enabled (owned): ${pin.tailscaleHost}`);
  console.log(`  pin → sessions/.hub.json`);
  console.log(`  Next: ./scripts/gotchibot db wizard   # BYO Mongo`);
  console.log(`  Then: ./scripts/gotchibot db pin-desk # deskApiBase → this Hub`);
  return result;
}

async function cmdStatus() {
  if (!hasInstallToken()) {
    throw new Error("GOTCHIBOT_INFRA_TOKEN required — abra run gotchibot -- …");
  }
  const result = await api("GET", "/api/gotchibot/hub/status");
  console.log(JSON.stringify(result, null, 2));
  if (result.hub?.enabled && result.hub.tailscaleHost) {
    writeHubPin(result.hub, result.installId);
    console.log("updated sessions/.hub.json");
  }
  return result;
}

async function cmdPin() {
  return cmdStatus();
}

function parseChatStoreArgs(argv) {
  const out = { kind: null, dbName: null, atlasHost: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--kind" || a === "-k") out.kind = argv[++i];
    else if (a === "--db-name" || a === "--dbName") out.dbName = argv[++i];
    else if (a === "--atlas-host" || a === "--atlasHostHint") out.atlasHost = argv[++i];
    else if (!a.startsWith("-") && !out.kind) out.kind = a;
    else if (a.startsWith("-")) throw new Error(`unknown flag ${a}`);
  }
  return out;
}

async function cmdChatStore(argv) {
  if (!hasInstallToken()) {
    throw new Error("GOTCHIBOT_INFRA_TOKEN required — abra run gotchibot -- …");
  }
  const args = parseChatStoreArgs(argv);
  const kind = String(args.kind || "").toLowerCase();
  if (!["local", "atlas", "none"].includes(kind)) {
    throw new Error("usage: gotchibot hub chat-store --kind local|atlas|none [--db-name …] [--atlas-host …]");
  }
  const chatStore = {
    kind,
    dbName: args.dbName || (kind === "none" ? null : "GotchiBot"),
    atlasHostHint: args.atlasHost || null,
  };
  const result = await api("POST", "/api/gotchibot/hub/chat-store", {
    body: { chatStore },
  });
  if (result.hub) {
    writeHubPin(result.hub, result.installId || readInstallId());
  }
  console.log(JSON.stringify(result, null, 2));
  console.log("Arcade chatStore metadata updated (no URI stored).");
  return result;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help") {
    console.log(
      "usage: gotchibot hub enable <tailscaleHost>|pin|arcade-status|chat-store --kind local|atlas|none",
    );
    process.exit(cmd ? 0 : 2);
  }
  try {
    if (cmd === "enable") {
      const host = rest[0];
      if (!host) throw new Error("usage: gotchibot hub enable <MagicDNS|100.x>");
      await cmdEnable(host);
    } else if (cmd === "status" || cmd === "arcade-status" || cmd === "pin") {
      await cmdStatus();
    } else if (cmd === "chat-store" || cmd === "chatstore") {
      await cmdChatStore(rest);
    } else {
      console.error(`unknown hub command: ${cmd}`);
      process.exit(2);
    }
  } catch (e) {
    console.error(e.message || e);
    if (e.body?.expectedMessage) {
      console.error("expected message:\n" + e.body.expectedMessage);
    }
    if (!hasAbra()) console.error(abraInstallHint());
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}

export { readHubPin, writeHubPin, buildEnableMessage };
