#!/usr/bin/env node
/**
 * Sepolia checkpointSave(cartridgeId, stateHash, stateUri) via MetaMask or cast.
 *
 *   node scripts/chat-checkpoint-onchain.mjs
 *   # reads sessions/.chat-sync-checkpoint.json (+ .identity.json)
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { isMainModule } from "./is-main.mjs";
import { resolveCastBin } from "./platform.mjs";
import { isPublicSafeStateUri } from "./chat-state-uri.mjs";
import { PORTS } from "./lib/ports.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PIN = `${ROOT}/sessions/.chat-sync-checkpoint.json`;
const IDENTITY = `${ROOT}/sessions/.identity.json`;
const WALLET = `${ROOT}/sessions/.wallet.json`;
const SIGN_PORT = Number(process.env.GOTCHIBOT_CHECKPOINT_SIGN_PORT ?? PORTS.CHECKPOINT_SIGN);
export const CHAIN_ID = 84532;

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadDiamond() {
  const candidates = [
    resolve(ROOT, "config/cartridgeChain.base-sepolia.json"),
    resolve(ROOT, "../AarcadeGh-t/config/cartridgeChain.base-sepolia.json"),
  ];
  for (const p of candidates) {
    try {
      const j = loadJson(p);
      if (j.cartridgeDiamond) return j;
    } catch {
      /* next */
    }
  }
  return { cartridgeDiamond: process.env.CARTRIDGE_DIAMOND || "" };
}

function ensureHex32(hash) {
  let h = String(hash || "").trim();
  if (!h.startsWith("0x")) h = `0x${h}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(h)) {
    throw new Error(`stateHash must be bytes32, got ${h.slice(0, 20)}…`);
  }
  return h;
}

async function browserSend({ wallet, diamond, cartridgeId, stateHash, stateUri }) {
  const rpc = process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org";
  return new Promise((resolvePromise, reject) => {
    const html = `<!doctype html><meta charset=utf-8><title>Chat sync checkpoint</title>
<body style="font-family:system-ui;max-width:42rem;margin:2rem auto;padding:0 1rem;background:#0a0018;color:#eee">
<h1>Checkpoint chat sync (Base Sepolia)</h1>
<p>Wallet <code>${wallet}</code></p>
<p>Cartridge <code>${cartridgeId}</code></p>
<p>stateUri <code style="word-break:break-all">${stateUri}</code></p>
<p>stateHash <code>${stateHash}</code></p>
<button id=go style="padding:.6rem 1rem;font-size:1rem">Sign &amp; send checkpointSave</button>
<p id=st></p>
<script type="module">
const DIAMOND = ${JSON.stringify(diamond)};
const CART = ${JSON.stringify(String(cartridgeId))};
const HASH = ${JSON.stringify(stateHash)};
const URI = ${JSON.stringify(stateUri)};
const WANT = ${JSON.stringify(wallet.toLowerCase())};
const CHAIN = "0x" + (84532).toString(16);
const RPC = ${JSON.stringify(rpc)};
const ABI = ["function checkpointSave(uint256 cartridgeId, bytes32 stateHash, string stateUri)"];

document.getElementById('go').onclick = async () => {
  const st = document.getElementById('st');
  try {
    const eth = window.ethereum;
    if (!eth) throw new Error('No MetaMask');
    const accs = await eth.request({ method: 'eth_requestAccounts' });
    if ((accs[0]||'').toLowerCase() !== WANT) throw new Error('Switch MetaMask to '+WANT);
    try {
      await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN }] });
    } catch (e) {
      if (e?.code === 4902) {
        await eth.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: CHAIN,
            chainName: 'Base Sepolia',
            rpcUrls: [RPC],
            nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
            blockExplorerUrls: ['https://sepolia.basescan.org'],
          }],
        });
      } else throw e;
    }
    // Minimal ABI encode without ethers in page: use eth_sendTransaction with data from local helper
    const enc = await fetch('/encode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cartridgeId: CART, stateHash: HASH, stateUri: URI }),
    }).then(r => r.json());
    if (!enc?.data) throw new Error(enc?.error || 'encode failed');
    st.textContent = 'Approve in MetaMask…';
    const txHash = await eth.request({
      method: 'eth_sendTransaction',
      params: [{ from: accs[0], to: DIAMOND, data: enc.data }],
    });
    await fetch('/done', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txHash }),
    });
    st.textContent = 'Sent ' + txHash + ' — you can close this tab.';
  } catch (e) {
    st.textContent = e.message || String(e);
  }
};
</script></body>`;

    let ethersMod;
    const server = http.createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
        return;
      }
      if (req.method === "POST" && req.url === "/encode") {
        let raw = "";
        for await (const c of req) raw += c;
        try {
          if (!ethersMod) {
            try {
              ethersMod = await import("ethers");
            } catch {
              ethersMod = await import(
                resolve(ROOT, "../AarcadeGh-t/node_modules/ethers/lib.esm/index.js")
              );
            }
          }
          const body = JSON.parse(raw);
          const iface = new ethersMod.Interface([
            "function checkpointSave(uint256 cartridgeId, bytes32 stateHash, string stateUri)",
          ]);
          const data = iface.encodeFunctionData("checkpointSave", [
            BigInt(body.cartridgeId),
            body.stateHash,
            body.stateUri,
          ]);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data }));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message || String(e) }));
        }
        return;
      }
      if (req.method === "POST" && req.url === "/done") {
        let raw = "";
        for await (const c of req) raw += c;
        try {
          const { txHash } = JSON.parse(raw);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true}');
          server.close();
          resolvePromise({ txHash });
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
      console.log(`Open MetaMask checkpoint: ${url}`);
      if (process.platform === "darwin") spawnSync("open", [url], { stdio: "ignore" });
    });
    setTimeout(() => {
      server.close();
      reject(new Error("checkpoint send timeout (5m)"));
    }, 5 * 60 * 1000);
  });
}

function castSend({ diamond, cartridgeId, stateHash, stateUri }) {
  const cast = resolveCastBin();
  if (!cast) throw new Error("cast not found");
  const rpc = process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org";
  const args = [
    "send",
    diamond,
    "checkpointSave(uint256,bytes32,string)",
    String(cartridgeId),
    stateHash,
    stateUri,
    "--rpc-url",
    rpc,
    "--chain",
    String(CHAIN_ID),
  ];
  // Interactive cast wallet (user unlocks) — never pass --private-key from us.
  console.log("Running cast send (approve wallet / unlock as needed)…");
  const r = spawnSync(cast, args, { encoding: "utf8", stdio: "inherit", env: process.env });
  if (r.status !== 0) throw new Error("cast send failed");
  return { ok: true, via: "cast" };
}

export async function runChatCheckpointOnchain(opts = {}) {
  if (!existsSync(PIN)) {
    throw new Error("no sessions/.chat-sync-checkpoint.json — run chats checkpoint-prompt first");
  }
  const pin = loadJson(PIN);
  const meta = existsSync(IDENTITY) ? loadJson(IDENTITY) : {};
  const walletDoc = existsSync(WALLET) ? loadJson(WALLET) : {};
  const wallet = String(walletDoc.address || "").toLowerCase();
  const cartridgeId = opts.cartridgeId || meta.cartridgeId;
  if (!cartridgeId) throw new Error("no cartridgeId in sessions/.identity.json");
  if (!wallet) throw new Error("no wallet — gotchibot connect");

  const stateHash = ensureHex32(opts.stateHash || pin.contentHash);
  const stateUri = String(opts.stateUri || pin.stateUri || "").trim();
  if (!stateUri) throw new Error("stateUri missing on pin");
  if (!isPublicSafeStateUri(stateUri)) {
    throw new Error(
      "stateUri must be an opaque gotchibot-hub://<id> — re-run: gotchibot chats snapshot",
    );
  }

  const chain = loadDiamond();
  const diamond = String(process.env.CARTRIDGE_DIAMOND || chain.cartridgeDiamond || "").trim();
  if (!diamond) throw new Error("cartridgeDiamond missing in chain config");

  let result;
  if (process.env.GOTCHIBOT_CHECKPOINT_SEND === "cast") {
    result = castSend({ diamond, cartridgeId, stateHash, stateUri });
  } else {
    try {
      result = await browserSend({ wallet, diamond, cartridgeId, stateHash, stateUri });
    } catch (e) {
      console.log(`Browser send failed (${e.message}) — trying cast…`);
      result = castSend({ diamond, cartridgeId, stateHash, stateUri });
    }
  }

  const out = {
    ...pin,
    onChain: {
      chainId: CHAIN_ID,
      diamond,
      cartridgeId: String(cartridgeId),
      stateHash,
      stateUri,
      ...result,
      at: new Date().toISOString(),
    },
  };
  writeFileSync(PIN, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, ...out.onChain }, null, 2));
  return out;
}

async function main() {
  try {
    await runChatCheckpointOnchain();
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
