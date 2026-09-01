#!/usr/bin/env node
/**
 * GotchiBot install token — register + status (store token in abra only).
 */
import http from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { AUTH_CFG } from "./infra-client.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = `${ROOT}/sessions`;
const WALLET_PATH = `${SESSIONS}/.wallet.json`;
const INSTALL_ID_PATH = `${SESSIONS}/.install-id`;
const SIGN_PORT = Number(process.env.GOTCHIBOT_INFRA_SIGN_PORT ?? 8789);

function readWallet() {
  try {
    return JSON.parse(readFileSync(WALLET_PATH, "utf8")).address?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

function ensureInstallId() {
  mkdirSync(SESSIONS, { recursive: true });
  if (existsSync(INSTALL_ID_PATH)) {
    return readFileSync(INSTALL_ID_PATH, "utf8").trim();
  }
  const id = crypto.randomUUID();
  writeFileSync(INSTALL_ID_PATH, `${id}\n`);
  return id;
}

function buildRegisterMessage(wallet, installId) {
  return ["Register GotchiBot install", `wallet: ${wallet}`, `installId: ${installId}`].join("\n");
}

function castBin() {
  return process.env.CAST_BIN ?? "/Users/juliuswong/.foundry/bin/cast";
}

function hasAbra() {
  return spawnSync("bash", ["-c", "command -v abra"], { encoding: "utf8" }).status === 0;
}

function saveTokenToAbra(token) {
  if (!hasAbra()) {
    console.log("\nStore the token in abracadabra (never in git):");
    console.log("  echo '<token>' | abra set gotchibot GOTCHIBOT_INFRA_TOKEN --stdin");
    return false;
  }
  const r = spawnSync("abra", ["set", "gotchibot", "GOTCHIBOT_INFRA_TOKEN", "--stdin"], {
    input: token,
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (r.status !== 0) {
    console.error("\nCould not save to abra — store manually:");
    console.error("  echo '<token>' | abra set gotchibot GOTCHIBOT_INFRA_TOKEN --stdin");
    return false;
  }
  console.log("    ✓ GOTCHIBOT_INFRA_TOKEN saved in abra (gotchibot project)");
  return true;
}

function openBrowser(url) {
  if (process.env.GOTCHIBOT_NO_BROWSER === "1") return;
  if (process.platform === "darwin") {
    const apps = (process.env.GOTCHIBOT_WALLET_BROWSER || "Google Chrome,Brave Browser,Firefox,Microsoft Edge")
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);
    for (const app of apps) {
      const r = spawnSync("open", ["-a", app, url], { stdio: "ignore" });
      if (r.status === 0) return;
    }
    spawnSync("open", [url], { stdio: "ignore" });
    return;
  }
  if (process.platform === "win32") spawnSync("cmd", ["/c", "start", "", url], { stdio: "ignore" });
  else spawnSync("xdg-open", [url], { stdio: "ignore" });
}

function freePort(port) {
  if (process.platform === "win32") return;
  spawnSync("bash", ["-c", `lsof -ti:${port} | xargs kill -9 2>/dev/null || true`], { stdio: "ignore" });
}

function signMessageCast(wallet, message) {
  return execFileSync(castBin(), ["wallet", "sign", message, "--from", wallet], {
    encoding: "utf8",
    timeout: 60_000,
  }).trim();
}

function renderSignPage(wallet, message) {
  const w = JSON.stringify(wallet);
  const m = JSON.stringify(message);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>GotchiBot — register install</title>
<style>
  body{font-family:-apple-system,sans-serif;background:#141220;color:#eee;display:flex;
       align-items:center;justify-content:center;min-height:100vh;margin:0;padding:1rem}
  .card{background:#1e1b2e;padding:2rem 3rem;border-radius:16px;text-align:center;max-width:520px}
  button{background:#8b5cf6;color:#fff;border:0;border-radius:10px;padding:.9rem 2rem;
         font-size:1rem;cursor:pointer;width:100%;max-width:280px}
  button:hover{background:#7c3aed}
  button:disabled{opacity:.5;cursor:not-allowed}
  .status{margin-top:1rem;font-size:.9rem;line-height:1.4;color:#a78bfa;min-height:1.4em}
  .ok{color:#4ade80}.err{color:#f87171}
  .hint{color:#888;font-size:.85rem;margin-top:.75rem}
  pre{background:#0f0d18;padding:.75rem;border-radius:8px;text-align:left;font-size:.75rem;
      white-space:pre-wrap;word-break:break-word;color:#c4b5fd}
</style></head>
<body><div class="card">
  <h2>Register GotchiBot</h2>
  <p>Sign to prove wallet ownership. No transaction, no fee.</p>
  <p class="hint">Wallet: <code id="wallet"></code></p>
  <pre id="msg"></pre>
  <button type="button" id="sign">Sign message</button>
  <div class="status" id="status"></div>
</div>
<script>
const WALLET = ${w};
const MESSAGE = ${m};
document.getElementById('wallet').textContent = WALLET;
document.getElementById('msg').textContent = MESSAGE;

function toHexUtf8(text) {
  const bytes = new TextEncoder().encode(text);
  return '0x' + [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

function pickWallet() {
  if (window.ethereum?.isMetaMask) return window.ethereum;
  return window.ethereum || null;
}

async function sign() {
  const btn = document.getElementById('sign');
  const s = document.getElementById('status');
  btn.disabled = true;
  s.className = 'status';
  try {
    const provider = pickWallet();
    if (!provider) throw new Error('No wallet extension — use Chrome/Brave with MetaMask.');
    s.textContent = 'Connecting wallet…';
    const accounts = await provider.request({ method: 'eth_requestAccounts' });
    const address = (accounts[0] || '').toLowerCase();
    if (address !== WALLET) {
      throw new Error('Switch to wallet ' + WALLET + ' (got ' + address + ')');
    }
    s.textContent = 'Approve the signature in your wallet…';
    const signature = await provider.request({
      method: 'personal_sign',
      params: [toHexUtf8(MESSAGE), accounts[0]],
    });
    s.textContent = 'Saving…';
    const res = await fetch('/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signature }),
    });
    const out = await res.json();
    if (out.ok) {
      s.className = 'status ok';
      s.textContent = 'Signed! Return to the terminal.';
    } else {
      throw new Error(out.error || 'server error');
    }
  } catch (e) {
    s.className = 'status err';
    s.textContent = String(e?.message || e);
    btn.disabled = false;
  }
}
document.getElementById('sign').addEventListener('click', () => sign());
</script></body></html>`;
}

function signMessageBrowser(wallet, message) {
  return new Promise((resolvePromise, reject) => {
    freePort(SIGN_PORT);
    const url = `http://127.0.0.1:${SIGN_PORT}`;
    let signed = false;

    const server = http.createServer((req, res) => {
      if (req.url === "/" || req.url === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderSignPage(wallet, message));
        return;
      }
      if (req.url === "/callback" && req.method === "POST") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try {
            const { signature } = JSON.parse(body || "{}");
            if (!/^0x[a-fA-F0-9]+$/i.test(signature ?? "")) throw new Error("bad signature");
            let recovered;
            try {
              recovered = execFileSync(
                castBin(),
                ["wallet", "verify", "--address", wallet, message, signature],
                { encoding: "utf8", timeout: 15_000 },
              ).trim();
            } catch (e) {
              throw new Error(`signature verify failed: ${e.message}`);
            }
            if (!/valid|true/i.test(recovered)) throw new Error("signature invalid");
            signed = true;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            resolvePromise(signature);
            setTimeout(() => server.close(), 300);
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    server.on("error", (e) => reject(e));
    server.listen(SIGN_PORT, "127.0.0.1", () => {
      console.log("    open browser → sign with your wallet (Chrome/Brave + MetaMask)");
      console.log(`    ${url}`);
      openBrowser(url);
    });

    const timer = setTimeout(() => {
      if (!signed) {
        server.close();
        reject(new Error("sign timed out — rerun infra register"));
      }
    }, 300_000);

    server.on("close", () => clearTimeout(timer));
    process.on("SIGINT", () => {
      server.close();
      reject(new Error("cancelled"));
    });
  });
}

async function signRegisterMessage(wallet, message, { preferBrowser = true } = {}) {
  if (process.env.GOTCHIBOT_REGISTER_SIGNATURE) {
    return String(process.env.GOTCHIBOT_REGISTER_SIGNATURE).trim();
  }
  if (!preferBrowser) {
    try {
      return signMessageCast(wallet, message);
    } catch {
      /* fall through */
    }
  }
  try {
    return await signMessageBrowser(wallet, message);
  } catch (e) {
    if (preferBrowser) throw e;
    return signMessageCast(wallet, message);
  }
}

async function registerInstall({ saveAbra = true, preferBrowser = true, quiet = false } = {}) {
  const wallet = readWallet();
  if (!wallet) {
    throw new Error("no wallet — run ./scripts/gotchibot connect first");
  }
  const installId = ensureInstallId();
  const message = buildRegisterMessage(wallet, installId);
  if (!quiet) {
    console.log("    signing register message…");
  }
  const signature = await signRegisterMessage(wallet, message, { preferBrowser });
  const registerUrl = process.env.GOTCHIBOT_REGISTER_URL || AUTH_CFG.registerUrl;
  const res = await fetch(registerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ wallet, installId, message, signature }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`register failed HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    throw new Error(`register failed HTTP ${res.status}: ${JSON.stringify(body)}`);
  }
  if (!body.token) throw new Error("register response missing token");
  if (saveAbra) saveTokenToAbra(body.token);
  return { token: body.token, wallet, installId, expiresAt: body.expiresAt ?? null };
}

async function cmdRegister() {
  const args = process.argv.slice(3);
  const saveAbra = !args.includes("--no-save");
  const preferBrowser = !args.includes("--cast");
  try {
    await registerInstall({ saveAbra, preferBrowser });
    console.log("\nInstall registered.");
    if (saveAbra && hasAbra()) {
      console.log("Next: ./scripts/gotchibot init");
    } else if (!saveAbra) {
      console.log("Token printed once — save to abra, then: ./scripts/gotchibot init");
    }
  } catch (e) {
    console.error(e?.message || e);
    process.exit(1);
  }
}

async function cmdStatus() {
  const token = String(process.env.GOTCHIBOT_INFRA_TOKEN || "").trim();
  if (!token) {
    console.log("GOTCHIBOT_INFRA_TOKEN unset — run: ./scripts/gotchibot onboard");
    process.exit(1);
  }
  const statusUrl = process.env.GOTCHIBOT_INSTALL_STATUS_URL || AUTH_CFG.statusUrl;
  const res = await fetch(statusUrl, {
    headers: {
      Accept: "application/json",
      [AUTH_CFG.installTokenHeader || "X-GotchiBot-Install-Token"]: token,
    },
  });
  const body = await res.json();
  console.log(JSON.stringify(body, null, 2));
  process.exit(body.ok ? 0 : 1);
}

function usage() {
  console.error("usage: infra-token.mjs register [--cast] [--no-save] | status");
  process.exit(2);
}

function main() {
  const sub = (process.argv[2] || "").toLowerCase();
  if (sub === "register") return cmdRegister();
  if (sub === "status") return cmdStatus();
  usage();
}

function isDirectRun() {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((e) => {
    console.error(e?.message || e);
    process.exit(1);
  });
}

export { buildRegisterMessage, ensureInstallId, readWallet, registerInstall, saveTokenToAbra, hasAbra };
