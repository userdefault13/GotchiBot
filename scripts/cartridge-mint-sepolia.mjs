#!/usr/bin/env node
/**
 * Mint sealed Abra / GotchiBot ACART on Base Sepolia via MetaMask (local page).
 *
 *   node scripts/cartridge-mint-sepolia.mjs --product gotchibot --tier standard --pay usdc
 *   node scripts/cartridge-mint-sepolia.mjs --product abra --pay usdc
 *   node scripts/cartridge-mint-sepolia.mjs --product bundle --tier silver --pay usdc
 *   node scripts/cartridge-mint-sepolia.mjs --quote --product gotchibot
 *
 * Signer is MetaMask only — no host private key.
 */
import http from "node:http";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { isMainModule } from "./is-main.mjs";
import {
  readGotchiBotCartridgeSepolia,
  readAbraCartridgeSepolia,
  readSepoliaHeroes,
  formatAbraCartLine,
} from "./cartridge-sepolia.mjs";
import { loadMeta, saveMeta } from "./identity.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WALLET_PATH = `${ROOT}/sessions/.wallet.json`;
const AARCADE_ASSETS = resolve(ROOT, "assets/aarcade");
const PORT = Number(process.env.GOTCHIBOT_MINT_PORT ?? 8789);
const CHAIN_ID = 84532;
const CHAIN_HEX = "0x14a34";
const CONCIERGE = "https://www.aarcadeghst.com/concierge/terminal";

/** Shared AarcadeGh-t chrome: Pixelar + ghost-mask bg (same as aarcadeghst.com body::before). */
function aarcadePageStyles() {
  return `
@font-face {
  font-display: swap;
  font-family: Pixelar;
  font-style: normal;
  font-weight: 400;
  src: url('/assets/PixelarRegular.woff2') format('woff2');
}
*, *::before, *::after { box-sizing: border-box; }
html { background: #1a0a2e; min-height: 100%; }
body {
  margin: 0;
  min-height: 100vh;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.25rem;
  font-family: 'Pixelar', monospace;
  color: #fff;
  background: #1a0a2e;
  image-rendering: pixelated;
  -webkit-font-smoothing: none;
}
body::before {
  content: '';
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background-color: #ffffff;
  -webkit-mask-image: url('/assets/bg.svg');
  mask-image: url('/assets/bg.svg');
  -webkit-mask-repeat: repeat;
  mask-repeat: repeat;
  -webkit-mask-size: 307px 326px;
  mask-size: 307px 326px;
  opacity: 0.12;
}
.shell { position: relative; z-index: 1; width: min(100%, 520px); }
.card {
  background: #12032e;
  border: 4px solid #8b57ff;
  box-shadow: 0 6px 0 0 #5a2d9e;
  border-radius: 6px;
  padding: 1.5rem 1.75rem 1.75rem;
  color: #e9e0ff;
}
.kicker {
  margin: 0 0 0.35rem;
  color: #d8b4fe;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 1rem;
  font-family: 'Pixelar', monospace;
}
h2 {
  margin: 0 0 0.65rem;
  color: #fff;
  text-transform: uppercase;
  line-height: 1.15;
  font-size: 1.85rem;
  font-family: 'Pixelar', monospace;
  font-weight: 400;
}
.hint, p.hint {
  margin: 0;
  color: #c4b5fd;
  font-size: 1.15rem;
  line-height: 1.45;
  font-family: 'Pixelar', monospace;
}
.hint code, code {
  font-family: 'Pixelar', monospace;
  color: #f9a8d4;
  font-size: 1.05em;
}
.legs { margin: 1rem 0 0; padding: 0; list-style: none; }
.legs li {
  padding: 0.65rem 0;
  border-bottom: 1px solid rgba(139, 87, 255, 0.35);
  font-size: 1.1rem;
  color: #e9e0ff;
  font-family: 'Pixelar', monospace;
  line-height: 1.35;
}
.legs li b { color: #fff; font-weight: 400; text-transform: uppercase; }
button, .btn {
  display: block;
  width: 100%;
  margin-top: 1.1rem;
  padding: 0.85rem 1.25rem;
  border: 3px solid #3a0d8a;
  border-radius: 4px;
  background: #6d18f8;
  color: #fff;
  font-family: 'Pixelar', monospace;
  font-size: 1.35rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  cursor: pointer;
  image-rendering: pixelated;
  box-shadow: 0 3px 0 0 #3a0d8a;
}
button:hover:not(:disabled), .btn:hover:not(:disabled) { background: #7c3aed; }
button:active:not(:disabled) { transform: translateY(2px); box-shadow: 0 1px 0 0 #3a0d8a; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.status {
  margin-top: 1rem;
  min-height: 1.4em;
  font-size: 1.15rem;
  line-height: 1.4;
  color: #d8b4fe;
  font-family: 'Pixelar', monospace;
}
.status.ok { color: #4ade80; }
.status.err { color: #f9a8d4; }
`.trim();
}

function tryServeAarcadeAsset(pathname, res) {
  const map = {
    "/assets/bg.svg": { file: "bg.svg", type: "image/svg+xml" },
    "/assets/PixelarRegular.woff2": { file: "PixelarRegular.woff2", type: "font/woff2" },
  };
  const hit = map[pathname];
  if (!hit) return false;
  const full = resolve(AARCADE_ASSETS, hit.file);
  if (!full.startsWith(AARCADE_ASSETS)) return false;
  try {
    const buf = readFileSync(full);
    res.writeHead(200, {
      "Content-Type": hit.type,
      "Cache-Control": "public, max-age=86400",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(buf);
    return true;
  } catch {
    return false;
  }
}

const TIER_ENUM = { golden: 0, silver: 1, standard: 2 };
const GBOT_LICENSE_ABI = [
  "function usdcPrice(uint8 tier) view returns (uint256)",
  "function goldenGhstWei() view returns (uint256)",
  "function silverGhstWei() view returns (uint256)",
  "function standardGhstWei() view returns (uint256)",
];
const ABRA_LICENSE_ABI = [
  "function usdcPrice() view returns (uint256)",
  "function ghstPriceWei() view returns (uint256)",
  "function remainingThisMonth() view returns (uint256)",
];

function loadChainConfig() {
  const candidates = [
    resolve(ROOT, "../AarcadeGh-t/config/cartridgeChain.base-sepolia.json"),
    resolve(ROOT, "config/cartridgeChain.base-sepolia.json"),
  ];
  for (const p of candidates) {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      /* next */
    }
  }
  return {};
}

async function getEthers() {
  try {
    return await import("ethers");
  } catch {
    return await import(resolve(ROOT, "../AarcadeGh-t/node_modules/ethers/lib.esm/index.js"));
  }
}

function readWallet() {
  try {
    const w = JSON.parse(readFileSync(WALLET_PATH, "utf8"));
    return w.address ? String(w.address).toLowerCase() : null;
  } catch {
    return null;
  }
}

function mintConfig() {
  const cfg = loadChainConfig();
  const usdc =
    process.env.USDC_BASE_SEPOLIA ||
    process.env.VITE_USDC_BASE_SEPOLIA ||
    "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  const ghst =
    process.env.GHST_BASE_SEPOLIA ||
    process.env.VITE_GHST_BASE_SEPOLIA ||
    cfg.ghstToken ||
    "0xe97f36a00058aa7dfc4e85d23532c3f70453a7ae";
  return {
    chainId: CHAIN_ID,
    rpc: process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org",
    consoleDiamond: process.env.CARTRIDGE_CONSOLE_DIAMOND || cfg.consoleDiamond || "",
    cartridgeDiamond: process.env.CARTRIDGE_DIAMOND || cfg.cartridgeDiamond || "",
    gotchiBotLicense:
      process.env.GOTCHIBOT_LICENSE_NFT ||
      process.env.VITE_GOTCHIBOT_LICENSE_NFT ||
      cfg.gotchiBotLicense ||
      "",
    abraLicense:
      process.env.ABRA_LICENSE_NFT ||
      process.env.VITE_ABRA_LICENSE_NFT ||
      cfg.abraLicense ||
      "",
    gotchiBotMinter:
      process.env.GOTCHIBOT_CARTRIDGE_MINTER ||
      process.env.VITE_GOTCHIBOT_CARTRIDGE_MINTER ||
      cfg.gotchiBotCartridgeMinter ||
      "",
    abraMinter:
      process.env.ABRA_CARTRIDGE_MINTER ||
      process.env.VITE_ABRA_CARTRIDGE_MINTER ||
      cfg.abraCartridgeMinter ||
      "",
    l1AavegotchiDiamond: cfg.l1AavegotchiDiamond || process.env.L1_AAVEGOTCHI_DIAMOND || "",
    usdc,
    ghst,
  };
}

function parseArgs(argv) {
  const out = {
    product: "gotchibot",
    tier: "standard",
    pay: "usdc",
    quote: false,
    json: false,
    open: false,
    cartridgeId: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--product" || a === "-p") out.product = String(argv[++i] || "").toLowerCase();
    else if (a === "--tier" || a === "-t") out.tier = String(argv[++i] || "").toLowerCase();
    else if (a === "--pay") out.pay = String(argv[++i] || "").toLowerCase();
    else if (a === "--quote") out.quote = true;
    else if (a === "--json") out.json = true;
    else if (a === "--open") {
      out.open = true;
      const next = argv[i + 1];
      if (next && !String(next).startsWith("-")) {
        out.cartridgeId = String(argv[++i]);
      }
    } else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function askYes(prompt) {
  return new Promise((resolveAsk) => {
    if (!process.stdin.isTTY) {
      resolveAsk(true);
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (ans) => {
      rl.close();
      resolveAsk(String(ans || "").trim().toUpperCase() === "YES");
    });
  });
}

/** After mint (or when already sealed): YES → MetaMask open(cartridgeId). */
export async function promptAndOpenSealedCart(wallet, cartridgeId, { autoYes = false } = {}) {
  const id = String(cartridgeId || "");
  if (!wallet || !id) return { ok: false, error: "missing wallet or cartridgeId" };
  console.log(`\n  GotchiBot cart #${id} is sealed.`);
  console.log("  Open unlocks bind / orch. MetaMask will call open(uint256).");
  const yes = autoYes || (await askYes("\n  Type YES to open MetaMask open-cart, anything else skips: "));
  if (!yes) {
    console.log(`  · Skipped open — Concierge later: ${CONCIERGE}`);
    return { ok: false, skipped: true };
  }
  const opened = await runOpenSealedCart({
    expectWallet: wallet,
    cartridgeId: id,
  });
  if (opened?.ok) {
    console.log(`  ✓ Opened GotchiBot cart #${id}`);
    const snap = await refreshDeskMeta(wallet);
    return { ok: true, txHash: opened.txHash || null, snap };
  }
  console.log(`  · Open failed: ${opened?.error || "unknown"}`);
  console.log(`  · Retry: node scripts/cartridge-mint-sepolia.mjs --open ${id}`);
  console.log(`  · Or Concierge: ${CONCIERGE}`);
  return { ok: false, error: opened?.error || "open failed" };
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

function freePort() {
  if (process.platform === "win32") return;
  spawnSync("bash", ["-c", `lsof -ti:${PORT} | xargs kill -9 2>/dev/null || true`], {
    stdio: "ignore",
  });
}

function formatUsdc(n) {
  return `${Number(n) / 1e6} USDC`;
}

function formatGhst(ethers, n) {
  return `${ethers.formatEther(n)} GHST`;
}

export async function quoteMint({ product, tier, pay }) {
  const cfg = mintConfig();
  const ethers = await getEthers();
  const provider = new ethers.JsonRpcProvider(cfg.rpc, CHAIN_ID);
  const legs = [];

  if (product === "abra" || product === "bundle") {
    if (!cfg.abraLicense) throw new Error("ABRA_LICENSE_NFT / abraLicense not configured");
    if (!cfg.abraMinter) {
      throw new Error(
        `Abra cartridge minter missing — set ABRA_CARTRIDGE_MINTER or config abraCartridgeMinter (or mint at ${CONCIERGE})`,
      );
    }
    const lic = new ethers.Contract(cfg.abraLicense, ABRA_LICENSE_ABI, provider);
    const usdcPrice = await lic.usdcPrice();
    const ghstPriceWei = await lic.ghstPriceWei();
    const spend = pay === "usdc" ? usdcPrice : ghstPriceWei;
    if (pay === "ghst" && spend === 0n) throw new Error("Abra GHST price not set");
    legs.push({
      product: "abra",
      minter: cfg.abraMinter,
      token: pay === "usdc" ? cfg.usdc : cfg.ghst,
      spend: spend.toString(),
      spendLabel: pay === "usdc" ? formatUsdc(usdcPrice) : formatGhst(ethers, ghstPriceWei),
      call: pay === "usdc" ? "mintWithUsdc()" : "mintWithGhst()",
      data:
        pay === "usdc"
          ? new ethers.Interface(["function mintWithUsdc()"]).encodeFunctionData("mintWithUsdc", [])
          : new ethers.Interface(["function mintWithGhst()"]).encodeFunctionData("mintWithGhst", []),
    });
  }

  if (product === "gotchibot" || product === "bundle") {
    if (!cfg.gotchiBotLicense) throw new Error("GOTCHIBOT_LICENSE_NFT / gotchiBotLicense not configured");
    if (!cfg.gotchiBotMinter) {
      throw new Error(
        `GotchiBot cartridge minter missing — set GOTCHIBOT_CARTRIDGE_MINTER or config gotchiBotCartridgeMinter (or mint at ${CONCIERGE})`,
      );
    }
    if (!(tier in TIER_ENUM)) throw new Error(`tier must be golden|silver|standard (got ${tier})`);
    const tierIdx = TIER_ENUM[tier];
    const lic = new ethers.Contract(cfg.gotchiBotLicense, GBOT_LICENSE_ABI, provider);
    const usdcPrice = await lic.usdcPrice(tierIdx);
    const ghstPriceWei =
      tier === "golden"
        ? await lic.goldenGhstWei()
        : tier === "silver"
          ? await lic.silverGhstWei()
          : await lic.standardGhstWei();
    const spend = pay === "usdc" ? usdcPrice : ghstPriceWei;
    if (pay === "ghst" && spend === 0n) throw new Error("GotchiBot GHST price not set");
    const iface = new ethers.Interface([
      "function mintWithUsdc(uint8 tier)",
      "function mintWithGhst(uint8 tier)",
    ]);
    legs.push({
      product: "gotchibot",
      tier,
      tierIdx,
      minter: cfg.gotchiBotMinter,
      token: pay === "usdc" ? cfg.usdc : cfg.ghst,
      spend: spend.toString(),
      spendLabel: pay === "usdc" ? formatUsdc(usdcPrice) : formatGhst(ethers, ghstPriceWei),
      call: pay === "usdc" ? `mintWithUsdc(${tierIdx})` : `mintWithGhst(${tierIdx})`,
      data:
        pay === "usdc"
          ? iface.encodeFunctionData("mintWithUsdc", [tierIdx])
          : iface.encodeFunctionData("mintWithGhst", [tierIdx]),
    });
  }

  return { cfg, pay, product, tier, legs };
}

async function ownershipSkip(wallet, product) {
  const skip = [];
  if (product === "abra" || product === "bundle") {
    const abra = await readAbraCartridgeSepolia(wallet);
    if (abra.cartridgeId) skip.push({ product: "abra", cartridgeId: abra.cartridgeId });
  }
  if (product === "gotchibot" || product === "bundle") {
    const gbot = await readGotchiBotCartridgeSepolia(wallet);
    if (gbot.cartridgeId) skip.push({ product: "gotchibot", cartridgeId: gbot.cartridgeId });
  }
  return skip;
}

export async function refreshDeskMeta(wallet) {
  const gbot = await readGotchiBotCartridgeSepolia(wallet);
  const abra = await readAbraCartridgeSepolia(wallet);
  const patch = {
    owner: wallet,
    cartridgeSource: "sepolia",
    cartridgeId: gbot.cartridgeId || null,
    abraCartridgeId: abra.cartridgeId || null,
    abraVerified: Boolean(abra.verified),
  };
  const meta = loadMeta() || {};
  // New Sepolia nest install: drop OpenClaw session→hero history so avatar
  // gallery doesn't preload old fleet thumbs.
  const nestHeroes = new Set((gbot.heroes || []).map((id) => String(id)));
  const cartChanged =
    patch.cartridgeId && String(meta.cartridgeId || "") !== String(patch.cartridgeId);
  const ownerChanged =
    Boolean(meta.owner) &&
    Boolean(wallet) &&
    String(meta.owner).toLowerCase() !== String(wallet).toLowerCase();
  if (patch.cartridgeId) {
    patch.sessionHeroes = {};
    if (meta.activeHeroId && !nestHeroes.has(String(meta.activeHeroId))) {
      patch.activeHeroId = null;
    }
  }
  saveMeta(patch);
  // Fresh cart or cart transferred to a new wallet → drop inherited project pointer.
  // (Dossiers stay on disk; cart gameState.projects cleared via checkpoint project --clear.)
  if (cartChanged || ownerChanged) {
    try {
      const { clearCurrentProject } = await import("./project-context.mjs");
      clearCurrentProject();
    } catch {
      /* optional */
    }
    try {
      const { clearAllPackWearables } = await import("./pack-wearable.mjs");
      clearAllPackWearables("transfer");
    } catch {
      /* optional */
    }
  }
  return { gbot, abra, line: formatAbraCartLine(abra) };
}

function renderMintPage(plan) {
  const planJson = JSON.stringify(plan);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>GotchiBot sealed mint</title>
<style>${aarcadePageStyles()}</style></head>
<body><div class="shell"><div class="card">
  <p class="kicker">AarcadeGh-t · Base Sepolia</p>
  <h2>Mint sealed cartridge</h2>
  <p class="hint">MetaMask will ask you to switch chain, approve spend, then mint.
  GotchiBot never sees your private key.</p>
  <ul class="legs" id="legs"></ul>
  <button type="button" id="go">Connect &amp; mint</button>
  <div class="status" id="status"></div>
</div></div>
<script>
const PLAN = ${planJson};
const CHAIN_ID = ${CHAIN_ID};
const CHAIN_HEX = '${CHAIN_HEX}';
const MAX_UINT = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
const ERC20_APPROVE = '0x095ea7b3'; // approve(address,uint256)

function friendlyError(e) {
  const msg = String(e?.message || e || '');
  if (/user rejected|rejected the request|4001/i.test(msg)) return 'Cancelled in wallet.';
  if (/metamask extension not found/i.test(msg)) return 'Install MetaMask in Chrome/Brave, reload, retry.';
  return msg || 'Unknown error';
}

function pickWallet() {
  if (window.ethereum?.isMetaMask) return window.ethereum;
  if (window.ethereum) return window.ethereum;
  return null;
}

function padAddr(a) { return a.toLowerCase().replace(/^0x/, '').padStart(64, '0'); }
function encodeApprove(spender) {
  return ERC20_APPROVE + padAddr(spender) + MAX_UINT.slice(2);
}

async function ensureChain(provider) {
  const id = await provider.request({ method: 'eth_chainId' });
  if (parseInt(id, 16) === CHAIN_ID) return;
  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: CHAIN_HEX }],
    });
  } catch (e) {
    if (e?.code === 4902) {
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: CHAIN_HEX,
          chainName: 'Base Sepolia',
          nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
          rpcUrls: ['https://sepolia.base.org'],
          blockExplorerUrls: ['https://sepolia.basescan.org'],
        }],
      });
    } else throw e;
  }
}

async function ethCall(provider, from, to, data) {
  return provider.request({
    method: 'eth_call',
    params: [{ from, to, data }, 'latest'],
  });
}

async function ensureAllowance(provider, from, token, spender, needHex) {
  const sel = '0xdd62ed3e'; // allowance(owner,spender)
  const data = sel + padAddr(from) + padAddr(spender);
  const raw = await ethCall(provider, from, token, data);
  const have = BigInt(raw || '0x0');
  const need = BigInt(needHex);
  if (have >= need) return null;
  const txHash = await provider.request({
    method: 'eth_sendTransaction',
    params: [{ from, to: token, data: encodeApprove(spender) }],
  });
  return txHash;
}

async function waitReceipt(provider, hash) {
  for (let i = 0; i < 90; i++) {
    const r = await provider.request({ method: 'eth_getTransactionReceipt', params: [hash] });
    if (r && r.blockNumber) return r;
    await new Promise((x) => setTimeout(x, 2000));
  }
  throw new Error('Timed out waiting for tx ' + hash);
}

async function run() {
  const btn = document.getElementById('go');
  const s = document.getElementById('status');
  btn.disabled = true;
  s.className = 'status';
  try {
    const provider = pickWallet();
    if (!provider) throw new Error('No wallet extension found');
    s.textContent = 'Requesting accounts…';
    const accounts = await provider.request({ method: 'eth_requestAccounts' });
    const from = accounts[0];
    if (!from) throw new Error('No account');
    if (PLAN.expectWallet && from.toLowerCase() !== PLAN.expectWallet.toLowerCase()) {
      throw new Error('Wrong wallet — desk expects ' + PLAN.expectWallet + ', MetaMask has ' + from);
    }
    s.textContent = 'Switching to Base Sepolia…';
    await ensureChain(provider);

    const results = [];
    for (const leg of PLAN.legs) {
      s.textContent = 'Approving ' + leg.product + ' spend (' + leg.spendLabel + ')…';
      const approveHash = await ensureAllowance(provider, from, leg.token, leg.minter, leg.spend);
      if (approveHash) {
        s.textContent = 'Waiting approve ' + approveHash.slice(0, 10) + '…';
        await waitReceipt(provider, approveHash);
      }
      s.textContent = 'Minting ' + leg.product + ' (' + leg.call + ')…';
      const mintHash = await provider.request({
        method: 'eth_sendTransaction',
        params: [{ from, to: leg.minter, data: leg.data }],
      });
      s.textContent = 'Waiting mint ' + mintHash.slice(0, 10) + '…';
      const receipt = await waitReceipt(provider, mintHash);
      if (receipt.status && parseInt(receipt.status, 16) === 0) {
        throw new Error(leg.product + ' mint reverted — check Basescan ' + mintHash);
      }
      results.push({ product: leg.product, txHash: mintHash });
    }

    s.textContent = 'Saving…';
    const res = await fetch('/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, address: from, results }),
    });
    if (!res.ok) throw new Error('Server ' + res.status);
    const out = await res.json();
    if (!out.ok) throw new Error(out.error || 'save failed');
    s.className = 'status ok';
    s.textContent = 'Minted! Return to GotchiBot tmux.';
  } catch (e) {
    s.className = 'status err';
    s.textContent = friendlyError(e);
    btn.disabled = false;
    try {
      await fetch('/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: String(e?.message || e) }),
      });
    } catch {}
  }
}

document.getElementById('legs').innerHTML = PLAN.legs.map((l) =>
  '<li><b>' + l.product + (l.tier ? ' · ' + l.tier : '') + '</b> — ' + l.spendLabel +
  '<br><span class="hint">' + l.minter.slice(0,10) + '… · ' + l.call + '</span></li>'
).join('');
document.getElementById('go').addEventListener('click', () => { run(); });
</script></body></html>`;
}

function runMintServer(plan) {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        server.close();
      } catch {}
      resolvePromise(result);
    };

    const server = http.createServer((req, res) => {
      const u = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
      }
      if (tryServeAarcadeAsset(u.pathname, res)) return;
      if (u.pathname === "/" || u.pathname === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderMintPage(plan));
        return;
      }
      if (u.pathname === "/callback" && req.method === "POST") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try {
            const data = JSON.parse(body || "{}");
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            if (data.ok) finish({ ok: true, ...data });
            else finish({ ok: false, error: data.error || "mint cancelled" });
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: e.message }));
            finish({ ok: false, error: e.message });
          }
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    freePort();
    server.on("error", (e) => {
      if (!settled) reject(e);
    });
    server.listen(PORT, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${PORT}`;
      console.log(`\n  Opening MetaMask mint page → ${url}`);
      console.log("  Approve in the browser, then return here.\n");
      openBrowser(url);
    });

    setTimeout(() => {
      if (!settled) finish({ ok: false, error: "mint timed out (10 min)" });
    }, 10 * 60 * 1000);
  });
}

export async function runCartridgeMint(opts) {
  const { product, tier, pay, quote, json } = opts;
  if (!["abra", "gotchibot", "bundle"].includes(product)) {
    throw new Error("product must be abra|gotchibot|bundle");
  }
  if (!["usdc", "ghst"].includes(pay)) throw new Error("pay must be usdc|ghst");

  const wallet = readWallet();
  if (!wallet) throw new Error("No wallet — run ./scripts/gotchibot connect first");

  const skip = await ownershipSkip(wallet, product);
  let effectiveProduct = product;
  let quoteData = await quoteMint({ product, tier, pay });

  if (skip.length) {
    for (const s of skip) {
      console.log(`  · skip ${s.product} — already owned #${s.cartridgeId}`);
    }
    if (product === "bundle") {
      const haveAbra = skip.some((s) => s.product === "abra");
      const haveGbot = skip.some((s) => s.product === "gotchibot");
      if (haveAbra && haveGbot) {
        const snap = await refreshDeskMeta(wallet);
        if (snap.gbot?.portalStatus === 1 && snap.gbot?.cartridgeId) {
          const opened = await promptAndOpenSealedCart(wallet, snap.gbot.cartridgeId);
          if (opened?.ok && opened.snap) {
            return { ok: true, skipped: skip, snap: opened.snap, opened: true, message: "both carts owned · opened" };
          }
        }
        return { ok: true, skipped: skip, snap, message: "both carts already owned" };
      }
      if (haveAbra) effectiveProduct = "gotchibot";
      else if (haveGbot) effectiveProduct = "abra";
      quoteData = await quoteMint({ product: effectiveProduct, tier, pay });
    } else if (skip.some((s) => s.product === product)) {
      const snap = await refreshDeskMeta(wallet);
      if (product === "gotchibot" && snap.gbot?.portalStatus === 1 && snap.gbot?.cartridgeId) {
        const opened = await promptAndOpenSealedCart(wallet, snap.gbot.cartridgeId);
        if (opened?.ok && opened.snap) {
          return { ok: true, skipped: skip, snap: opened.snap, opened: true, message: "gotchibot already owned · opened" };
        }
      }
      return { ok: true, skipped: skip, snap, message: `${product} already owned` };
    }
  }

  if (quote || json) {
    const out = { wallet, ...quoteData, skipped: skip };
    if (json) console.log(JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    else {
      console.log(`  wallet   ${wallet}`);
      console.log(`  product  ${effectiveProduct} · pay ${pay}${tier && effectiveProduct !== "abra" ? ` · tier ${tier}` : ""}`);
      for (const leg of quoteData.legs) {
        console.log(`  · ${leg.product}${leg.tier ? `/${leg.tier}` : ""}  ${leg.spendLabel}  → ${leg.minter}`);
      }
    }
    if (quote) return out;
  }

  if (!quoteData.legs.length) throw new Error("nothing to mint");

  console.log(`  Mint plan (${effectiveProduct}, ${pay}):`);
  for (const leg of quoteData.legs) {
    console.log(`  · ${leg.product}${leg.tier ? `/${leg.tier}` : ""}  ${leg.spendLabel}`);
  }

  const result = await runMintServer({
    expectWallet: wallet,
    legs: quoteData.legs,
    pay,
    product: effectiveProduct,
  });

  if (!result.ok) throw new Error(result.error || "mint failed");

  const snap = await refreshDeskMeta(wallet);
  mkdirSync(`${ROOT}/sessions`, { recursive: true });
  writeFileSync(
    `${ROOT}/sessions/.last-sealed-mint.json`,
    JSON.stringify({ at: new Date().toISOString(), wallet, results: result.results, snap }, null, 2),
  );

  console.log("\n  ✓ Mint complete");
  for (const r of result.results || []) console.log(`    ${r.product}  ${r.txHash}`);
  console.log(`  gotchibot cart  ${snap.gbot.cartridgeId || "(none)"}`);
  console.log(`  abra cart       ${snap.line}`);

  // Sealed GotchiBot cart → YES prompt → MetaMask open before bind.
  const gbotId = snap.gbot?.cartridgeId || null;
  let status = snap.gbot?.portalStatus;
  if (gbotId && status !== 2) {
    try {
      const again = await readGotchiBotCartridgeSepolia(wallet);
      status = again.portalStatus;
    } catch {
      /* keep */
    }
  }
  if (gbotId && status === 1) {
    const opened = await promptAndOpenSealedCart(wallet, gbotId);
    if (opened?.ok && opened.snap) {
      return { ok: true, results: result.results, snap: opened.snap, opened: true };
    }
    return { ok: true, results: result.results, snap, opened: false };
  }

  return { ok: true, results: result.results, snap };
}

/**
 * MetaMask page: GotchiBotNestFacet.open(cartridgeId) on Base Sepolia.
 */
export async function runOpenSealedCart({ expectWallet, cartridgeId, auto = true } = {}) {
  const cfg = mintConfig();
  const diamond = cfg.cartridgeDiamond;
  if (!diamond) throw new Error("cartridgeDiamond missing from chain config");
  if (!cartridgeId) throw new Error("cartridgeId required to open");

  freePort();
  const plan = {
    expectWallet: String(expectWallet || "").toLowerCase(),
    cartridgeId: String(cartridgeId),
    diamond,
  };

  return new Promise((resolve) => {
    let settled = false;
    const finish = (out) => {
      if (settled) return;
      settled = true;
      try {
        server.close();
      } catch {
        /* ignore */
      }
      resolve(out);
    };

    const server = http.createServer((req, res) => {
      const u = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
      if (tryServeAarcadeAsset(u.pathname, res)) return;
      if (u.pathname === "/" || u.pathname === "/open") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderOpenPage(plan));
        return;
      }
      if (u.pathname === "/done" && req.method === "POST") {
        let body = "";
        req.on("data", (c) => {
          body += c;
        });
        req.on("end", () => {
          try {
            const j = JSON.parse(body || "{}");
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            finish({ ok: Boolean(j.ok), txHash: j.txHash || null, error: j.error || null });
          } catch (e) {
            res.writeHead(400);
            res.end("bad json");
            finish({ ok: false, error: String(e?.message || e) });
          }
        });
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });

    server.listen(PORT, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${PORT}/open`;
      console.log(`\n  Opening MetaMask open-cart page → ${url}`);
      console.log("  Confirm open in the browser, then return here.\n");
      if (auto) openBrowser(url);
    });

    setTimeout(() => {
      if (!settled) finish({ ok: false, error: "open timed out (5 min)" });
    }, 5 * 60 * 1000);
  });
}

function renderOpenPage(plan) {
  const planJson = JSON.stringify(plan);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Open sealed GotchiBot cart</title>
<style>${aarcadePageStyles()}</style></head>
<body><div class="shell"><div class="card">
  <p class="kicker">AarcadeGh-t · Base Sepolia</p>
  <h2>Open sealed cartridge</h2>
  <p class="hint">MetaMask will ask you to switch chain, then call
  <code>open(#${plan.cartridgeId})</code>. After this you can bind a gotchi as orch.</p>
  <button type="button" id="go">Connect &amp; open</button>
  <div class="status" id="status"></div>
</div></div>
<script type="module">
const PLAN = ${planJson};
const CHAIN_ID = ${CHAIN_ID};
const CHAIN_HEX = '${CHAIN_HEX}';

function friendlyError(e) {
  const msg = String(e?.message || e || '');
  if (/user rejected|rejected the request|4001/i.test(msg)) return 'Cancelled in wallet.';
  if (/metamask extension not found/i.test(msg)) return 'Install MetaMask in Chrome/Brave, reload, retry.';
  if (/!sealed/i.test(msg)) return 'Cart is not sealed (already open?).';
  return msg || 'Unknown error';
}

function pickWallet() {
  if (window.ethereum?.isMetaMask) return window.ethereum;
  if (window.ethereum) return window.ethereum;
  throw new Error('MetaMask extension not found');
}

async function ensureChain(eth) {
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_HEX }] });
  } catch (e) {
    if (e?.code === 4902) {
      await eth.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: CHAIN_HEX,
          chainName: 'Base Sepolia',
          nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
          rpcUrls: ['https://sepolia.base.org'],
          blockExplorerUrls: ['https://sepolia.basescan.org'],
        }],
      });
    } else throw e;
  }
}

async function postDone(payload) {
  await fetch('/done', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
}

document.getElementById('go').onclick = async () => {
  const status = document.getElementById('status');
  const btn = document.getElementById('go');
  btn.disabled = true;
  status.className = 'status';
  status.textContent = 'Connecting…';
  try {
    const eth = pickWallet();
    await ensureChain(eth);
    const accounts = await eth.request({ method: 'eth_requestAccounts' });
    const from = String(accounts[0] || '').toLowerCase();
    if (PLAN.expectWallet && from !== PLAN.expectWallet) {
      throw new Error('Wrong wallet — desk expects ' + PLAN.expectWallet + ', MetaMask has ' + from);
    }
    status.textContent = 'Confirm open in MetaMask…';
    // open(uint256) selector
    const { BrowserProvider, Contract } = await import('https://cdn.jsdelivr.net/npm/ethers@6.13.4/+esm');
    const provider = new BrowserProvider(eth);
    const signer = await provider.getSigner();
    const abi = ['function open(uint256 cartridgeId)'];
    const c = new Contract(PLAN.diamond, abi, signer);
    const tx = await c.open(BigInt(PLAN.cartridgeId));
    status.textContent = 'Waiting for confirmation…';
    const receipt = await tx.wait();
    status.className = 'status ok';
    status.textContent = 'Opened · ' + (receipt?.hash || tx.hash);
    await postDone({ ok: true, txHash: receipt?.hash || tx.hash });
  } catch (e) {
    status.className = 'status err';
    status.textContent = friendlyError(e);
    await postDone({ ok: false, error: friendlyError(e) });
    btn.disabled = false;
  }
};
</script></body></html>`;
}

/**
 * MetaMask page: CAavegotchiFacet.bindOwned(cartridgeId, sourceTokenId) on Base Sepolia.
 */
export async function runBindOwned({
  expectWallet,
  cartridgeId,
  sourceTokenId,
  auto = true,
} = {}) {
  const cfg = mintConfig();
  const diamond = cfg.cartridgeDiamond;
  if (!diamond) throw new Error("cartridgeDiamond missing from chain config");
  if (!cartridgeId) throw new Error("cartridgeId required to bind");
  if (!sourceTokenId) throw new Error("sourceTokenId required to bind");

  // Preflight: bindOwned needs L1 (or Sepolia Mock L1) ownerOf on this chain.
  try {
    const ethers = await getEthers();
    const rpc = process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org";
    const provider = new ethers.JsonRpcProvider(rpc);
    const l1Cfg = String(cfg.l1AavegotchiDiamond || "").trim();
    if (!l1Cfg || l1Cfg === ethers.ZeroAddress) {
      return {
        ok: false,
        error:
          "No l1AavegotchiDiamond in config — set Mock L1 (Sepolia) or real Base diamond. Or use bindStarter (collateral).",
      };
    }
    const code = await provider.getCode(l1Cfg);
    if (!code || code === "0x") {
      return {
        ok: false,
        error:
          "l1AavegotchiDiamond has no code on this chain — bindOwned will revert. Check config or use bindStarter.",
      };
    }
  } catch {
    /* continue to MetaMask; page friendlyError covers call failures */
  }

  freePort();
  const plan = {
    expectWallet: String(expectWallet || "").toLowerCase(),
    cartridgeId: String(cartridgeId),
    sourceTokenId: String(sourceTokenId),
    diamond,
  };

  return new Promise((resolve) => {
    let settled = false;
    const finish = (out) => {
      if (settled) return;
      settled = true;
      try {
        server.close();
      } catch {
        /* ignore */
      }
      resolve(out);
    };

    const server = http.createServer((req, res) => {
      const u = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
      if (tryServeAarcadeAsset(u.pathname, res)) return;
      if (u.pathname === "/" || u.pathname === "/bind") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderBindPage(plan));
        return;
      }
      if (u.pathname === "/done" && req.method === "POST") {
        let body = "";
        req.on("data", (c) => {
          body += c;
        });
        req.on("end", () => {
          try {
            const j = JSON.parse(body || "{}");
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            finish({ ok: Boolean(j.ok), txHash: j.txHash || null, error: j.error || null });
          } catch (e) {
            res.writeHead(400);
            res.end("bad json");
            finish({ ok: false, error: String(e?.message || e) });
          }
        });
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });

    server.listen(PORT, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${PORT}/bind`;
      console.log(`\n  Opening MetaMask bind page → ${url}`);
      console.log("  Confirm bindOwned in the browser, then return here.\n");
      if (auto) openBrowser(url);
    });

    setTimeout(() => {
      if (!settled) finish({ ok: false, error: "bind timed out (5 min)" });
    }, 5 * 60 * 1000);
  });
}

function renderBindPage(plan) {
  const planJson = JSON.stringify(plan);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Bind gotchi into cart</title>
<style>${aarcadePageStyles()}</style></head>
<body><div class="shell"><div class="card">
  <p class="kicker">AarcadeGh-t · Base Sepolia</p>
  <h2>Bind owned gotchi</h2>
  <p class="hint">MetaMask will ask you to switch chain, then call
  <code>bindOwned(#${plan.cartridgeId}, #${plan.sourceTokenId})</code>
  — adds owned-${plan.sourceTokenId} to the cart roster (#${plan.cartridgeId}).</p>
  <button type="button" id="go">Connect &amp; bind</button>
  <div class="status" id="status"></div>
</div></div>
<script type="module">
const PLAN = ${planJson};
const CHAIN_HEX = '${CHAIN_HEX}';

function friendlyError(e) {
  const msg = String(e?.message || e || '');
  if (/user rejected|rejected the request|4001/i.test(msg)) return 'Cancelled in wallet.';
  if (/metamask extension not found/i.test(msg)) return 'Install MetaMask in Chrome/Brave, reload, retry.';
  if (/!owner/i.test(msg)) return 'Wallet does not own that gotchi.';
  if (/bound/i.test(msg)) return 'Already bound on this cart.';
  if (/!open|sealed|requireOpen|SEALED/i.test(msg)) return 'Cart must be open before bind.';
  if (/LINE_A_UNPAID/i.test(msg)) return 'Cart Line A unpaid — finish mint first.';
  if (/missing revert data|CALL_EXCEPTION|estimateGas/i.test(msg)) {
    return 'bindOwned reverted — check Mock L1 ownership (ownerOf) for this token id, or use Mint collateral cAavegotchi.';
  }
  // Truncate giant ethers dumps
  if (msg.length > 220) return msg.slice(0, 200) + '…';
  return msg || 'Unknown error';
}

function pickWallet() {
  if (window.ethereum?.isMetaMask) return window.ethereum;
  if (window.ethereum) return window.ethereum;
  throw new Error('MetaMask extension not found');
}

async function ensureChain(eth) {
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_HEX }] });
  } catch (e) {
    if (e?.code === 4902) {
      await eth.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: CHAIN_HEX,
          chainName: 'Base Sepolia',
          nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
          rpcUrls: ['https://sepolia.base.org'],
          blockExplorerUrls: ['https://sepolia.basescan.org'],
        }],
      });
    } else throw e;
  }
}

async function postDone(payload) {
  await fetch('/done', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
}

document.getElementById('go').onclick = async () => {
  const status = document.getElementById('status');
  const btn = document.getElementById('go');
  btn.disabled = true;
  status.className = 'status';
  status.textContent = 'Connecting…';
  try {
    const eth = pickWallet();
    await ensureChain(eth);
    const accounts = await eth.request({ method: 'eth_requestAccounts' });
    const from = String(accounts[0] || '').toLowerCase();
    if (PLAN.expectWallet && from !== PLAN.expectWallet) {
      throw new Error('Wrong wallet — desk expects ' + PLAN.expectWallet + ', MetaMask has ' + from);
    }
    status.textContent = 'Confirm bindOwned in MetaMask…';
    const { BrowserProvider, Contract } = await import('https://cdn.jsdelivr.net/npm/ethers@6.13.4/+esm');
    const provider = new BrowserProvider(eth);
    const signer = await provider.getSigner();
    const abi = ['function bindOwned(uint256 cartridgeId, uint256 sourceTokenId)'];
    const c = new Contract(PLAN.diamond, abi, signer);
    const tx = await c.bindOwned(BigInt(PLAN.cartridgeId), BigInt(PLAN.sourceTokenId));
    status.textContent = 'Waiting for confirmation…';
    const receipt = await tx.wait();
    status.className = 'status ok';
    status.textContent = 'Bound · ' + (receipt?.hash || tx.hash);
    await postDone({ ok: true, txHash: receipt?.hash || tx.hash });
  } catch (e) {
    status.className = 'status err';
    status.textContent = friendlyError(e);
    await postDone({ ok: false, error: friendlyError(e) });
    btn.disabled = false;
  }
};
</script></body></html>`;
}

const BIND_ABI = [
  "function bindOwned(uint256 cartridgeId, uint256 sourceTokenId)",
  "function bindOwnedBatch(uint256 cartridgeId, uint256[] sourceTokenIds)",
];

function bindRevertReason(e) {
  const msg = String(e?.shortMessage || e?.reason || e?.message || e || "");
  if (/!owner/i.test(msg)) return "wallet does not own it on Mock L1";
  if (/Cartridge: bound/i.test(msg)) return "already bound on this cart";
  if (/!open|sealed/i.test(msg)) return "cart must be open before bind";
  if (/LINE_A_UNPAID/i.test(msg)) return "cart Line A unpaid";
  return msg.length > 120 ? `${msg.slice(0, 117)}…` : msg || "reverted";
}

/**
 * Dry-run each bindOwned from the wallet so one bad id cannot sink an atomic batch.
 * Also probes whether the diamond has bindOwnedBatch (one tx, no wallet batching needed).
 */
export async function preflightOwnedBinds({ wallet, cartridgeId, tokenIds, onProgress = () => {} }) {
  const cfg = mintConfig();
  const ethers = await getEthers();
  const provider = new ethers.JsonRpcProvider(cfg.rpc);
  const iface = new ethers.Interface(BIND_ABI);
  const cart = BigInt(cartridgeId);
  const call = async (data) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await provider.call({ from: wallet, to: cfg.cartridgeDiamond, data });
      } catch (e) {
        const reverted = e?.code === "CALL_EXCEPTION" || /revert/i.test(String(e?.message || ""));
        if (reverted || attempt >= 3) throw Object.assign(e, { reverted });
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
  };
  const ok = [];
  const rejected = [];
  for (let i = 0; i < tokenIds.length; i++) {
    const id = tokenIds[i];
    onProgress(`Checking binds on Base Sepolia ${i + 1}/${tokenIds.length}…`);
    try {
      await call(iface.encodeFunctionData("bindOwned", [cart, BigInt(id)]));
      ok.push(id);
    } catch (e) {
      if (e.reverted) rejected.push({ tokenId: id, error: bindRevertReason(e) });
      else ok.push(id);
    }
  }
  let contractBatch = false;
  if (ok.length > 1) {
    try {
      await call(iface.encodeFunctionData("bindOwnedBatch", [cart, ok.map((id) => BigInt(id))]));
      contractBatch = true;
    } catch {
      /* diamond without bindOwnedBatch */
    }
  }
  return { ok, rejected, contractBatch };
}

/**
 * One MetaMask page for many bindOwned: bindOwnedBatch tx when the diamond has it, else an
 * EIP-5792 wallet_sendCalls batch (one confirm), else one tx per id without reopening pages.
 */
export async function runBindOwnedBatch({
  expectWallet,
  cartridgeId,
  tokenIds,
  contractBatch = false,
  onProgress = () => {},
  auto = true,
} = {}) {
  const cfg = mintConfig();
  const diamond = cfg.cartridgeDiamond;
  if (!diamond) throw new Error("cartridgeDiamond missing from chain config");
  if (!cartridgeId) throw new Error("cartridgeId required to bind");
  if (!tokenIds?.length) return { ok: true, mode: null, bound: [], failed: [], txHashes: [] };

  freePort();
  const plan = {
    expectWallet: String(expectWallet || "").toLowerCase(),
    cartridgeId: String(cartridgeId),
    tokenIds: tokenIds.map(String),
    diamond,
    contractBatch: Boolean(contractBatch),
  };

  return new Promise((resolve) => {
    let settled = false;
    const finish = (out) => {
      if (settled) return;
      settled = true;
      try {
        server.close();
      } catch {
        /* ignore */
      }
      resolve(out);
    };
    const readJson = (req, cb) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        try {
          cb(JSON.parse(body || "{}"));
        } catch {
          cb(null);
        }
      });
    };

    const server = http.createServer((req, res) => {
      const u = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
      if (tryServeAarcadeAsset(u.pathname, res)) return;
      if (u.pathname === "/" || u.pathname === "/bind-batch") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderBindBatchPage(plan));
        return;
      }
      if (u.pathname === "/progress" && req.method === "POST") {
        readJson(req, (j) => {
          if (j?.text) onProgress(String(j.text).slice(0, 120));
          res.writeHead(204);
          res.end();
        });
        return;
      }
      if (u.pathname === "/done" && req.method === "POST") {
        readJson(req, (j) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          if (!j) return finish({ ok: false, mode: null, bound: [], failed: [], txHashes: [], error: "bad json" });
          finish({
            ok: Boolean(j.ok),
            mode: j.mode || null,
            bound: Array.isArray(j.bound) ? j.bound.map(String) : [],
            failed: Array.isArray(j.failed) ? j.failed : [],
            txHashes: Array.isArray(j.txHashes) ? j.txHashes : [],
            error: j.error || null,
          });
        });
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });

    server.listen(PORT, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${PORT}/bind-batch`;
      onProgress(`Confirm in the browser — ${url}`);
      if (auto) openBrowser(url);
    });

    setTimeout(() => {
      if (!settled) finish({ ok: false, mode: null, bound: [], failed: [], txHashes: [], error: "bind timed out" });
    }, (10 + tokenIds.length) * 60 * 1000);
  });
}

function renderBindBatchPage(plan) {
  const planJson = JSON.stringify(plan);
  const n = plan.tokenIds.length;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Bind ${n} gotchis into cart</title>
<style>${aarcadePageStyles()}</style></head>
<body><div class="shell"><div class="card">
  <p class="kicker">AarcadeGh-t · Base Sepolia</p>
  <h2>Bind ${n} owned gotchis</h2>
  <p class="hint">${
    plan.contractBatch
      ? `One transaction: <code>bindOwnedBatch(#${plan.cartridgeId}, [${n} ids])</code>.`
      : `One MetaMask batch of ${n} <code>bindOwned</code> calls when your wallet supports it (MetaMask may offer a one-time smart account switch). Otherwise one confirm per gotchi, on this page.`
  }</p>
  <button type="button" id="go">Connect &amp; bind all</button>
  <div class="status" id="status"></div>
</div></div>
<script type="module">
const PLAN = ${planJson};
const CHAIN_HEX = '${CHAIN_HEX}';

function friendlyError(e) {
  const msg = String(e?.shortMessage || e?.message || e || '');
  if (/user rejected|rejected the request|4001/i.test(msg)) return 'Cancelled in wallet.';
  if (/metamask extension not found/i.test(msg)) return 'Install MetaMask in Chrome/Brave, reload, retry.';
  if (/!owner/i.test(msg)) return 'Wallet does not own that gotchi.';
  if (/bound/i.test(msg)) return 'Already bound on this cart.';
  if (/!open|sealed/i.test(msg)) return 'Cart must be open before bind.';
  if (/LINE_A_UNPAID/i.test(msg)) return 'Cart Line A unpaid — finish mint first.';
  return msg.length > 220 ? msg.slice(0, 200) + '…' : msg || 'Unknown error';
}
const rejected = (e) => e?.code === 4001 || e?.code === 'ACTION_REJECTED' || /user rejected|rejected the request/i.test(String(e?.message || ''));
const unsupported = (e) => [4200, -32601, 5700, 5710, 5750].includes(e?.code) || /not supported|unsupported|does not exist/i.test(String(e?.message || ''));

function pickWallet() {
  if (window.ethereum) return window.ethereum;
  throw new Error('MetaMask extension not found');
}

async function ensureChain(eth) {
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_HEX }] });
  } catch (e) {
    if (e?.code !== 4902) throw e;
    await eth.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: CHAIN_HEX,
        chainName: 'Base Sepolia',
        nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
        rpcUrls: ['https://sepolia.base.org'],
        blockExplorerUrls: ['https://sepolia.basescan.org'],
      }],
    });
  }
}

const post = (path, payload) =>
  fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).catch(() => {});
const status = document.getElementById('status');
const say = (text) => { status.textContent = text; post('/progress', { text }); };

async function atomicSupported(eth, from) {
  try {
    const caps = await eth.request({ method: 'wallet_getCapabilities', params: [from, [CHAIN_HEX]] });
    const c = caps?.[CHAIN_HEX] || caps?.[String(parseInt(CHAIN_HEX, 16))] || {};
    return c.atomic?.status === 'supported' || c.atomic?.status === 'ready' || c.atomicBatch?.supported === true;
  } catch {
    return false;
  }
}

async function waitForCalls(eth, id) {
  for (let i = 0; i < 300; i++) {
    const r = await eth.request({ method: 'wallet_getCallsStatus', params: [id] });
    const s = r?.status;
    if (s === 200 || s === 'CONFIRMED') {
      const receipts = r.receipts || [];
      if (receipts.some((x) => x.status === '0x0' || x.status === 0)) throw new Error('batch reverted on-chain');
      return [...new Set(receipts.map((x) => x.transactionHash).filter(Boolean))];
    }
    if (typeof s === 'number' && s >= 400) throw new Error('batch failed (status ' + s + ')');
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error('batch still pending after 10 min — check MetaMask activity');
}

document.getElementById('go').onclick = async () => {
  const btn = document.getElementById('go');
  btn.disabled = true;
  status.className = 'status';
  const ids = PLAN.tokenIds;
  try {
    say('Connecting…');
    const eth = pickWallet();
    await ensureChain(eth);
    const accounts = await eth.request({ method: 'eth_requestAccounts' });
    const from = String(accounts[0] || '').toLowerCase();
    if (PLAN.expectWallet && from !== PLAN.expectWallet) {
      throw new Error('Wrong wallet — desk expects ' + PLAN.expectWallet + ', MetaMask has ' + from);
    }
    const { BrowserProvider, Contract, Interface } = await import('https://cdn.jsdelivr.net/npm/ethers@6.13.4/+esm');
    const iface = new Interface(${JSON.stringify(BIND_ABI)});
    const signer = await new BrowserProvider(eth).getSigner();
    const c = new Contract(PLAN.diamond, iface, signer);
    const cart = BigInt(PLAN.cartridgeId);

    if (PLAN.contractBatch) {
      say('Confirm bindOwnedBatch (' + ids.length + ' gotchis) in MetaMask…');
      const tx = await c.bindOwnedBatch(cart, ids.map((id) => BigInt(id)));
      say('Waiting for confirmation…');
      const receipt = await tx.wait();
      status.className = 'status ok';
      say('Bound ' + ids.length + ' · ' + (receipt?.hash || tx.hash));
      return post('/done', { ok: true, mode: 'contract', bound: ids, failed: [], txHashes: [receipt?.hash || tx.hash] });
    }

    if (await atomicSupported(eth, from)) {
      try {
        say('Confirm the batch of ' + ids.length + ' binds in MetaMask…');
        const res = await eth.request({
          method: 'wallet_sendCalls',
          params: [{
            version: '2.0.0',
            from,
            chainId: CHAIN_HEX,
            atomicRequired: true,
            calls: ids.map((id) => ({ to: PLAN.diamond, data: iface.encodeFunctionData('bindOwned', [cart, BigInt(id)]), value: '0x0' })),
          }],
        });
        say('Waiting for the batch to confirm…');
        const hashes = await waitForCalls(eth, typeof res === 'string' ? res : res?.id);
        status.className = 'status ok';
        say('Bound ' + ids.length + ' in one batch');
        return post('/done', { ok: true, mode: 'batch', bound: ids, failed: [], txHashes: hashes });
      } catch (e) {
        if (rejected(e) || !unsupported(e)) throw e;
      }
    }

    const bound = [];
    const failed = [];
    const txHashes = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      try {
        say('Confirm ' + (i + 1) + '/' + ids.length + ': bindOwned #' + id + ' in MetaMask…');
        const tx = await c.bindOwned(cart, BigInt(id));
        const receipt = await tx.wait();
        bound.push(id);
        txHashes.push(receipt?.hash || tx.hash);
      } catch (e) {
        if (rejected(e)) {
          ids.slice(i).forEach((rest) => failed.push({ tokenId: rest, error: 'cancelled in wallet' }));
          break;
        }
        failed.push({ tokenId: id, error: friendlyError(e) });
      }
    }
    status.className = failed.length ? 'status err' : 'status ok';
    say('Bound ' + bound.length + '/' + ids.length + (failed.length ? ' · ' + failed.length + ' failed' : ''));
    await post('/done', { ok: bound.length > 0, mode: 'sequential', bound, failed, txHashes });
  } catch (e) {
    status.className = 'status err';
    status.textContent = friendlyError(e);
    await post('/done', { ok: false, mode: null, bound: [], failed: [], txHashes: [], error: friendlyError(e) });
    btn.disabled = false;
  }
};
</script></body></html>`;
}

/**
 * Bind many wallet-owned gotchis to the desk cart with as few MetaMask confirms as possible.
 * @returns {{ mode, bound: string[], failed: {tokenId, error}[], txHashes: string[] }}
 */
export async function bindOwnedBatchToDesk(tokenIds, { onProgress = () => {} } = {}) {
  const { wallet, cartridgeId } = deskTarget();
  const ids = [...new Set((tokenIds || []).map(String))];
  const pre = await preflightOwnedBinds({ wallet, cartridgeId, tokenIds: ids, onProgress });
  let res = { mode: null, bound: [], failed: [], txHashes: [], error: null };
  if (pre.ok.length) {
    res = await runBindOwnedBatch({
      expectWallet: wallet,
      cartridgeId,
      tokenIds: pre.ok,
      contractBatch: pre.contractBatch,
      onProgress,
    });
    if (!res.bound.length && !res.failed.length) {
      res.failed = pre.ok.map((tokenId) => ({ tokenId, error: res.error || "not bound" }));
    }
  }
  if (res.bound.length) await refreshDeskMeta(wallet).catch(() => {});
  return { mode: res.mode, bound: res.bound, failed: [...pre.rejected, ...res.failed], txHashes: res.txHashes };
}

/**
 * MetaMask page: CAavegotchiFacet.bindStarter(cartridgeId, templateId, collateral) payable 5 ETH.
 */
export async function runBindStarter({
  expectWallet,
  cartridgeId,
  templateId,
  collateral = "0x0000000000000000000000000000000000000000",
  auto = true,
} = {}) {
  const cfg = mintConfig();
  const diamond = cfg.cartridgeDiamond;
  if (!diamond) throw new Error("cartridgeDiamond missing from chain config");
  if (!cartridgeId) throw new Error("cartridgeId required to bind starter");
  if (!templateId) throw new Error("templateId required to bind starter");

  freePort();
  const plan = {
    expectWallet: String(expectWallet || "").toLowerCase(),
    cartridgeId: String(cartridgeId),
    templateId: String(templateId),
    collateral: String(collateral || "0x0000000000000000000000000000000000000000"),
    diamond,
    feeEth: "5",
  };

  return new Promise((resolve) => {
    let settled = false;
    const finish = (out) => {
      if (settled) return;
      settled = true;
      try {
        server.close();
      } catch {
        /* ignore */
      }
      resolve(out);
    };

    const server = http.createServer((req, res) => {
      const u = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
      if (tryServeAarcadeAsset(u.pathname, res)) return;
      if (u.pathname === "/" || u.pathname === "/bind-starter") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderBindStarterPage(plan));
        return;
      }
      if (u.pathname === "/done" && req.method === "POST") {
        let body = "";
        req.on("data", (c) => {
          body += c;
        });
        req.on("end", () => {
          try {
            const j = JSON.parse(body || "{}");
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            finish({ ok: Boolean(j.ok), txHash: j.txHash || null, error: j.error || null });
          } catch (e) {
            res.writeHead(400);
            res.end("bad json");
            finish({ ok: false, error: String(e?.message || e) });
          }
        });
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });

    server.listen(PORT, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${PORT}/bind-starter`;
      console.log(`\n  Opening MetaMask bindStarter page → ${url}`);
      console.log("  Confirm bindStarter (5 ETH) in the browser, then return here.\n");
      if (auto) openBrowser(url);
    });

    setTimeout(() => {
      if (!settled) finish({ ok: false, error: "bindStarter timed out (5 min)" });
    }, 5 * 60 * 1000);
  });
}

function deskTarget() {
  const meta = loadMeta() || {};
  const wallet = String(meta.owner || readWallet() || "").toLowerCase();
  if (!wallet) throw new Error("No wallet — run ./scripts/gotchibot connect first");
  const cartridgeId = meta.cartridgeId ? String(meta.cartridgeId) : null;
  if (!cartridgeId) throw new Error(`No GotchiBot cart on file — mint one: ${CONCIERGE}`);
  return { wallet, cartridgeId };
}

async function deskHeroIds(cartridgeId) {
  return (await readSepoliaHeroes(cartridgeId)).heroes.map((h) => String(h.id));
}

/** Bind a wallet-owned gotchi to the desk cart (MetaMask bindOwned). @returns `owned-<tokenId>` */
export async function bindOwnedToDesk(sourceTokenId) {
  const { wallet, cartridgeId } = deskTarget();
  const tokenId = String(sourceTokenId);
  const bound = await runBindOwned({ expectWallet: wallet, cartridgeId, sourceTokenId: tokenId });
  if (!bound?.ok) throw new Error(`bindOwned #${tokenId}: ${bound?.error || "cancelled"}`);
  await refreshDeskMeta(wallet).catch(() => {});
  return `owned-${tokenId}`;
}

/**
 * Mint a $5 starter cAavegotchi on the desk cart (MetaMask bindStarter).
 * @param {{ id: string, libraryName?: string, hauntId?: number, collateralType?: string }} option
 *   a starter collateral from loadBaseStarterCollaterals()
 * @returns {Promise<string>} the new hero id
 */
export async function bindStarterToDesk(option) {
  if (!option?.id) throw new Error("starter collateral required");
  const { wallet, cartridgeId } = deskTarget();
  const collateral = String(option.collateralType || "").startsWith("0x")
    ? String(option.collateralType)
    : "0x0000000000000000000000000000000000000000";
  const before = new Set(await deskHeroIds(cartridgeId));
  const bound = await runBindStarter({ expectWallet: wallet, cartridgeId, templateId: option.id, collateral });
  if (!bound?.ok) throw new Error(`bindStarter ${option.id}: ${bound?.error || "cancelled"}`);
  await refreshDeskMeta(wallet).catch(() => {});
  const fresh = (await deskHeroIds(cartridgeId)).filter((id) => !before.has(id));
  if (!fresh.length) {
    throw new Error(`bindStarter confirmed (${bound.txHash || "no tx"}) but no new hero on cart ${cartridgeId}`);
  }
  const heroId = fresh[fresh.length - 1];
  try {
    const { persistHeroCollateral, findCollateralColors } = await import("./collateral-resolve.mjs");
    const colors = findCollateralColors(collateral !== "0x0000000000000000000000000000000000000000" ? collateral : option.id, option.hauntId || 1);
    persistHeroCollateral(heroId, {
      collateral: option.id,
      collateralAddress: collateral,
      collateralName: colors?.name || option.libraryName || null,
      hauntId: option.hauntId || 1,
      primary: colors?.primary,
      secondary: colors?.secondary,
    });
  } catch {
    /* thumb colors are cosmetic */
  }
  return heroId;
}

function renderBindStarterPage(plan) {
  const planJson = JSON.stringify(plan);
  const collShort =
    plan.collateral && plan.collateral !== "0x0000000000000000000000000000000000000000"
      ? `${plan.collateral.slice(0, 8)}…`
      : "zero address";
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Mint collateral cAavegotchi</title>
<style>${aarcadePageStyles()}</style></head>
<body><div class="shell"><div class="card">
  <p class="kicker">AarcadeGh-t · Base Sepolia</p>
  <h2>Mint collateral cAavegotchi</h2>
  <p class="hint">MetaMask will call
  <code>bindStarter(#${plan.cartridgeId}, ${plan.templateId}, ${collShort})</code>
  with <code>${plan.feeEth} ETH</code> — adds a starter cGotchi to the cart roster.</p>
  <button type="button" id="go">Connect &amp; mint</button>
  <div class="status" id="status"></div>
</div></div>
<script type="module">
const PLAN = ${planJson};
const CHAIN_HEX = '${CHAIN_HEX}';

function friendlyError(e) {
  const msg = String(e?.message || e || '');
  if (/user rejected|rejected the request|4001/i.test(msg)) return 'Cancelled in wallet.';
  if (/metamask extension not found/i.test(msg)) return 'Install MetaMask in Chrome/Brave, reload, retry.';
  if (/bind fee|insufficient funds/i.test(msg)) return 'Need 5 ETH on Base Sepolia for starter bind fee.';
  if (/!open|sealed|requireOpen/i.test(msg)) return 'Cart must be open before bind.';
  return msg || 'Unknown error';
}

function pickWallet() {
  if (window.ethereum?.isMetaMask) return window.ethereum;
  if (window.ethereum) return window.ethereum;
  throw new Error('MetaMask extension not found');
}

async function ensureChain(eth) {
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_HEX }] });
  } catch (e) {
    if (e?.code === 4902) {
      await eth.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: CHAIN_HEX,
          chainName: 'Base Sepolia',
          nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
          rpcUrls: ['https://sepolia.base.org'],
          blockExplorerUrls: ['https://sepolia.basescan.org'],
        }],
      });
    } else throw e;
  }
}

async function postDone(payload) {
  await fetch('/done', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
}

document.getElementById('go').onclick = async () => {
  const status = document.getElementById('status');
  const btn = document.getElementById('go');
  btn.disabled = true;
  status.className = 'status';
  status.textContent = 'Connecting…';
  try {
    const eth = pickWallet();
    await ensureChain(eth);
    const accounts = await eth.request({ method: 'eth_requestAccounts' });
    const from = String(accounts[0] || '').toLowerCase();
    if (PLAN.expectWallet && from !== PLAN.expectWallet) {
      throw new Error('Wrong wallet — desk expects ' + PLAN.expectWallet + ', MetaMask has ' + from);
    }
    status.textContent = 'Confirm bindStarter (5 ETH) in MetaMask…';
    const { BrowserProvider, Contract, id, parseEther } = await import('https://cdn.jsdelivr.net/npm/ethers@6.13.4/+esm');
    const provider = new BrowserProvider(eth);
    const signer = await provider.getSigner();
    const abi = ['function bindStarter(uint256 cartridgeId, bytes32 templateId, address collateral) payable'];
    const c = new Contract(PLAN.diamond, abi, signer);
    const tx = await c.bindStarter(
      BigInt(PLAN.cartridgeId),
      id(PLAN.templateId),
      PLAN.collateral,
      { value: parseEther(PLAN.feeEth) }
    );
    status.textContent = 'Waiting for confirmation…';
    const receipt = await tx.wait();
    status.className = 'status ok';
    status.textContent = 'Minted · ' + (receipt?.hash || tx.hash);
    await postDone({ ok: true, txHash: receipt?.hash || tx.hash });
  } catch (e) {
    status.className = 'status err';
    status.textContent = friendlyError(e);
    await postDone({ ok: false, error: friendlyError(e) });
    btn.disabled = false;
  }
};
</script></body></html>`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`usage: cartridge-mint-sepolia.mjs --product abra|gotchibot|bundle [--tier …] [--pay usdc|ghst] [--quote] [--json]
       cartridge-mint-sepolia.mjs --open [cartridgeId]
Concierge fallback: ${CONCIERGE}`);
    process.exit(0);
  }
  try {
    if (args.open) {
      const wallet = readWallet();
      if (!wallet) throw new Error("No wallet — run ./scripts/gotchibot connect first");
      let id = args.cartridgeId;
      if (!id) {
        const gbot = await readGotchiBotCartridgeSepolia(wallet);
        id = gbot.cartridgeId ? String(gbot.cartridgeId) : null;
        if (!id) throw new Error("No GotchiBot cart for this wallet");
        if (gbot.portalStatus === 2) {
          console.log(`  Cart #${id} already open`);
          process.exit(0);
        }
      }
      const out = await promptAndOpenSealedCart(wallet, id);
      if (args.json) console.log(JSON.stringify(out, null, 2));
      process.exit(out.ok ? 0 : 1);
    }
    const out = await runCartridgeMint(args);
    if (args.json && !args.quote) console.log(JSON.stringify(out, null, 2));
    process.exit(out.ok ? 0 : 1);
  } catch (e) {
    console.error(`\n  ✗ ${e.message || e}`);
    console.error(`  Concierge: ${CONCIERGE}\n`);
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
