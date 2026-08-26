#!/usr/bin/env node
import http from "node:http";
import crypto from "node:crypto";
import { writeFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WALLET_PATH = `${ROOT}/sessions/.wallet.json`;

function loadWallet() {
  try { return JSON.parse(readFileSync(WALLET_PATH, "utf8")); } catch { return null; }
}

function saveWallet(w) {
  writeFileSync(WALLET_PATH, JSON.stringify(w, null, 2));
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>GotchiBot wallet connect</title>
<style>
  body{font-family:-apple-system,sans-serif;background:#141220;color:#eee;display:flex;
       align-items:center;justify-content:center;height:100vh;margin:0}
  .card{background:#1e1b2e;padding:2rem 3rem;border-radius:16px;text-align:center;max-width:480px}
  button{background:#8b5cf6;color:#fff;border:0;border-radius:10px;padding:.9rem 2rem;
         font-size:1rem;cursor:pointer}
  button:hover{background:#7c3aed}
  .status{margin-top:1rem;font-family:monospace;word-break:break-all;color:#a78bfa}
</style></head>
<body><div class="card">
  <h2>GotchiBot</h2>
  <p>Connect your wallet to register it as the GotchiBot owner.</p>
  <p style="color:#888;font-size:.85rem">Signing proves ownership only — no transaction, no fee.</p>
  <button onclick="connect()">Connect MetaMask</button>
  <div class="status" id="status"></div>
</div>
<script>
async function connect(){
  const s=document.getElementById('status');
  try{
    if(!window.ethereum){s.textContent='No injected wallet found';return;}
    const accounts=await window.ethereum.request({method:'eth_requestAccounts'});
    const address=accounts[0];
    const nonce=window.__nonce;
    s.textContent='Check MetaMask to sign…';
    const signature=await window.ethereum.request({method:'personal_sign',params:[
      'GotchiBot wallet connect\\nNonce: '+nonce,address]});
    const res=await fetch('/callback',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({address,signature,nonce})});
    const out=await res.json();
    s.textContent=out.ok?'Connected: '+address:'Failed: '+(out.error||'unknown');
  }catch(e){s.textContent='Error: '+e.message;}
}
</script></body></html>`;

const nonce = `0x${crypto.randomBytes(16).toString("hex")}`;
const server = http.createServer((req, res) => {
  if (req.url === "/") {
    res.setHeader("Content-Type", "text/html");
    res.end(PAGE.replace("__nonce", nonce));
    return;
  }
  if (req.url === "/callback" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { address, signature } = JSON.parse(body);
        if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error("bad address");
        if (!/^0x[a-fA-F0-9]{130}$/.test(signature)) throw new Error("bad signature");
        const message = `GotchiBot wallet connect\nNonce: ${nonce}`;
        const recovered = execFileSync(
          "/Users/juliuswong/.foundry/bin/cast",
          ["wallet", "verify", "--address", address.toLowerCase(), message, signature],
          { encoding: "utf8" },
        ).trim();
        if (!/valid|true/i.test(recovered)) throw new Error(`signature invalid: ${recovered}`);
        saveWallet({ address: address.toLowerCase(), verifiedAt: new Date().toISOString() });
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        console.log(`\nconnected: ${address.toLowerCase()}`);
        setTimeout(() => process.exit(0), 500);
      } catch (e) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  res.status(404).end();
});

server.listen(8788, "127.0.0.1", () => {
  const existing = loadWallet();
  if (existing) console.log(`current wallet: ${existing.address}`);
  console.log(`connect at http://localhost:8788 (nonce ${nonce})`);
});
