#!/usr/bin/env node
import http from "node:http";
import crypto from "node:crypto";
import { writeFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WALLET_PATH = `${ROOT}/sessions/.wallet.json`;
const PORT = Number(process.env.GOTCHIBOT_WALLET_PORT ?? 8788);
const URL = `http://127.0.0.1:${PORT}`;

function saveWallet(w) {
  writeFileSync(WALLET_PATH, JSON.stringify({ ...w, source: "metamask" }, null, 2));
}

function openBrowser(url) {
  if (process.env.GOTCHIBOT_NO_BROWSER === "1") return;
  if (process.platform === "darwin") spawnSync("open", [url], { stdio: "ignore" });
  else if (process.platform === "win32") spawnSync("cmd", ["/c", "start", "", url], { stdio: "ignore" });
  else spawnSync("xdg-open", [url], { stdio: "ignore" });
}

function castBin() {
  return process.env.CAST_BIN ?? "/Users/juliuswong/.foundry/bin/cast";
}

function freePort() {
  if (process.platform === "win32") return;
  spawnSync("bash", ["-c", `lsof -ti:${PORT} | xargs kill -9 2>/dev/null || true`], { stdio: "ignore" });
}

function toHexUtf8(text) {
  const bytes = new TextEncoder().encode(text);
  return `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function renderPage(nonce) {
  const n = JSON.stringify(nonce);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>GotchiBot wallet connect</title>
<style>
  body{font-family:-apple-system,sans-serif;background:#141220;color:#eee;display:flex;
       align-items:center;justify-content:center;min-height:100vh;margin:0;padding:1rem}
  .card{background:#1e1b2e;padding:2rem 3rem;border-radius:16px;text-align:center;max-width:480px}
  button{background:#8b5cf6;color:#fff;border:0;border-radius:10px;padding:.9rem 2rem;
         font-size:1rem;cursor:pointer;width:100%;max-width:280px}
  button:hover{background:#7c3aed}
  button:disabled{opacity:.5;cursor:not-allowed}
  .status{margin-top:1rem;font-size:.9rem;line-height:1.4;color:#a78bfa;min-height:1.4em}
  .ok{color:#4ade80}.err{color:#f87171}
  .hint{color:#888;font-size:.85rem;margin-top:.75rem}
</style></head>
<body><div class="card">
  <h2>GotchiBot</h2>
  <p>Connect your wallet to register it as the GotchiBot owner.</p>
  <p class="hint">Signing proves ownership only — no transaction, no fee.</p>
  <p class="hint">Use Chrome, Brave, or Firefox with the MetaMask extension.</p>
  <button type="button" id="connect">Connect MetaMask</button>
  <div class="status" id="status"></div>
</div>
<script>
const NONCE = ${n};

function provider() {
  return window.ethereum || null;
}

function toHexUtf8(text) {
  const bytes = new TextEncoder().encode(text);
  return '0x' + [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function connect() {
  const btn = document.getElementById('connect');
  const s = document.getElementById('status');
  btn.disabled = true;
  s.className = 'status';
  try {
    const eth = provider();
    if (!eth) {
      s.className = 'status err';
      s.textContent = 'MetaMask not found. Install the extension and open this page in Chrome/Brave/Firefox.';
      btn.disabled = false;
      return;
    }
    s.textContent = 'Requesting accounts…';
    const accounts = await eth.request({ method: 'eth_requestAccounts' });
    const address = accounts[0];
    if (!address) throw new Error('No account returned');
    const message = 'GotchiBot wallet connect\\nNonce: ' + NONCE;
    s.textContent = 'Check MetaMask — approve the signature…';
    const signature = await eth.request({
      method: 'personal_sign',
      params: [toHexUtf8(message), address],
    });
    s.textContent = 'Saving…';
    const res = await fetch('/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, signature, nonce: NONCE }),
    });
    if (!res.ok) throw new Error('Server returned ' + res.status);
    const out = await res.json();
    if (out.ok) {
      s.className = 'status ok';
      s.textContent = 'Connected! Return to GotchiBot tmux.';
    } else {
      s.className = 'status err';
      s.textContent = 'Failed: ' + (out.error || 'unknown');
      btn.disabled = false;
    }
  } catch (e) {
    s.className = 'status err';
    s.textContent = 'Error: ' + (e.message || e);
    btn.disabled = false;
  }
}

document.getElementById('connect').addEventListener('click', connect);
</script></body></html>`;
}

const nonce = `0x${crypto.randomBytes(16).toString("hex")}`;
let connected = false;

function json(res, code, data) {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderPage(nonce));
    return;
  }

  if (req.url === "/callback" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("error", (e) => {
      console.error("  ✗ request error:", e.message);
      json(res, 500, { ok: false, error: e.message });
    });
    req.on("end", () => {
      try {
        const { address, signature } = JSON.parse(body || "{}");
        if (!/^0x[a-fA-F0-9]{40}$/.test(address ?? "")) throw new Error("bad address");
        if (!/^0x[a-fA-F0-9]+$/i.test(signature ?? "")) throw new Error("bad signature");
        const message = `GotchiBot wallet connect\nNonce: ${nonce}`;
        let recovered;
        try {
          recovered = execFileSync(
            castBin(),
            ["wallet", "verify", "--address", address.toLowerCase(), message, signature],
            { encoding: "utf8", timeout: 15_000 },
          ).trim();
        } catch (e) {
          throw new Error(`signature verify failed (${castBin()}): ${e.message}`);
        }
        if (!/valid|true/i.test(recovered)) {
          throw new Error(`signature invalid: ${recovered}`);
        }
        const addr = address.toLowerCase();
        saveWallet({ address: addr, verifiedAt: new Date().toISOString(), connectNonce: nonce });
        connected = true;
        json(res, 200, { ok: true, address: addr });
        console.log(`\n  ✓ Wallet connected: ${addr}`);
        console.log("  Returning to GotchiBot…\n");
        setTimeout(() => process.exit(0), 800);
      } catch (e) {
        console.error(`  ✗ Connect failed: ${e.message}`);
        json(res, 400, { ok: false, error: e.message });
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

freePort();

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`\n  ✗ Port ${PORT} in use. Close other wallet-connect servers.\n`);
  } else {
    console.error(`\n  ✗ Server error: ${e.message}\n`);
  }
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("\n  MetaMask sign-in");
  console.log("  ─────────────────");
  console.log(`  Browser: ${URL}`);
  console.log("  Waiting for signature… (Connect MetaMask → Sign message)\n");
  openBrowser(URL);
});

process.on("SIGINT", () => {
  if (!connected) console.error("\n  ✗ Wallet connect cancelled\n");
  process.exit(connected ? 0 : 130);
});

process.on("uncaughtException", (e) => {
  console.error("  ✗ wallet-connect crashed:", e.message);
  process.exit(1);
});
