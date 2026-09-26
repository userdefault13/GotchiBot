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
  formatAbraCartLine,
} from "./cartridge-sepolia.mjs";
import { loadMeta, saveMeta } from "./identity.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WALLET_PATH = `${ROOT}/sessions/.wallet.json`;
const PORT = Number(process.env.GOTCHIBOT_MINT_PORT ?? 8789);
const CHAIN_ID = 84532;
const CHAIN_HEX = "0x14a34";
const CONCIERGE = "https://www.aarcadeghst.com/concierge/terminal";

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

/**
 * Detect cartridge chain id from env (84532 Sepolia default; 8453 Base mainnet).
 * @param {{ chainId?: number|string, cfg?: object }} [opts]
 */
export function detectCartridgeChainId(opts = {}) {
  if (opts.cfg?.chainId != null) return Number(opts.cfg.chainId);
  if (opts.chainId != null) return Number(opts.chainId);
  const e = String(process.env.GOTCHIBOT_CARTRIDGE_CHAIN || "").toLowerCase();
  if (e === "8453" || e === "base" || e === "mainnet") return 8453;
  if (e === "84532" || e === "sepolia" || e === "base-sepolia") return 84532;
  return 84532;
}

function repoChainConfigPath(chainId) {
  return Number(chainId) === 8453
    ? resolve(ROOT, "config/cartridgeChain.base.json")
    : resolve(ROOT, "config/cartridgeChain.base-sepolia.json");
}

/**
 * Load chain config. Repo file always wins over any upstream AarcadeGh-t copy
 * (bindAbi / events / fees live in this repo). Pass `cfg` to inject for tests
 * so nothing depends on ../AarcadeGh-t existing.
 *
 * @param {{ cfg?: object, chainId?: number|string, skipUpstream?: boolean }} [opts]
 */
export function loadChainConfig(opts = {}) {
  if (opts.cfg && typeof opts.cfg === "object") {
    return { ...opts.cfg };
  }
  const chainId = detectCartridgeChainId(opts);
  let upstream = {};
  if (!opts.skipUpstream && Number(chainId) === 84532) {
    try {
      upstream = JSON.parse(
        readFileSync(resolve(ROOT, "../AarcadeGh-t/config/cartridgeChain.base-sepolia.json"), "utf8"),
      );
    } catch {
      /* optional */
    }
  }
  let repo = {};
  try {
    repo = JSON.parse(readFileSync(repoChainConfigPath(chainId), "utf8"));
  } catch {
    /* missing */
  }
  // Repo wins — bind-related keys must not be shadowed by upstream.
  return { ...upstream, ...repo };
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

function mintConfig(opts = {}) {
  const cfg = loadChainConfig(opts);
  const chainId = Number(cfg.chainId || detectCartridgeChainId(opts));
  const usdc =
    process.env.USDC_BASE_SEPOLIA ||
    process.env.VITE_USDC_BASE_SEPOLIA ||
    cfg.usdcToken ||
    "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  const ghst =
    process.env.GHST_BASE_SEPOLIA ||
    process.env.VITE_GHST_BASE_SEPOLIA ||
    cfg.ghstToken ||
    "0xe97f36a00058aa7dfc4e85d23532c3f70453a7ae";
  return {
    ...cfg,
    chainId,
    rpc:
      chainId === 8453
        ? process.env.BASE_RPC || "https://mainnet.base.org"
        : process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org",
    consoleDiamond: process.env.CARTRIDGE_CONSOLE_DIAMOND || cfg.consoleDiamond || "",
    cartridgeDiamond: process.env.CARTRIDGE_DIAMOND || cfg.cartridgeDiamond || "",
    l1AavegotchiDiamond:
      process.env.L1_AAVEGOTCHI_DIAMOND || cfg.l1AavegotchiDiamond || "",
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
    starterBindFeeWei: cfg.starterBindFeeWei || "5000000000000000000",
    starterBindFee: cfg.starterBindFee || "5000000",
    usdcToken: cfg.usdcToken || usdc,
    usdc,
    ghst,
    signingEnabled: cfg.signingEnabled !== false && chainId !== 8453,
  };
}

const MAINNET_DISABLED = Object.freeze({
  ok: false,
  code: "MAINNET_DISABLED",
  error:
    "Base mainnet bind is disabled — pending AarcadeGh-t PR #28 (feature/cartridge-chain-provider)",
});

const ERC20_APPROVE_ABI = Object.freeze({
  type: "function",
  name: "approve",
  stateMutability: "nonpayable",
  inputs: [
    { name: "spender", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  outputs: [{ name: "", type: "bool" }],
});

/**
 * Fallback human-readable view ABIs when chain config lacks `views.*` fragments.
 * Prefer config/cartridgeChain.*.json `views` (confirmed by Aarcadeghst CoS).
 */
const PREFLIGHT_CART_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function portalStatus(uint256 cartridgeId) view returns (uint8)",
  "function heroIds(uint256 cartridgeId) view returns (bytes32[])",
  "function lineAPaid(uint256 cartridgeId) view returns (bool)",
];
const PREFLIGHT_L1_ABI = ["function ownerOf(uint256 tokenId) view returns (address)"];

/**
 * Resolve a preflight view ABI from chain config `views.<name>` JSON fragment.
 * Falls back to PREFLIGHT_CART_ABI strings only when the config lacks that fragment.
 */
function resolvePreflightViewAbi(cfg, functionName) {
  const views = cfg?.views && typeof cfg.views === "object" ? cfg.views : null;
  const frag = views?.[functionName];
  if (frag && typeof frag === "object") return [frag];
  return PREFLIGHT_CART_ABI;
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
  if (String(meta.cartridgeId || "").startsWith("sim-") && !patch.cartridgeId) {
    patch.legacySimCartridgeId = meta.cartridgeId;
  }
  // New Sepolia nest install: drop sim/OpenClaw session→hero history so avatar
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
<style>
  body{font-family:-apple-system,sans-serif;background:#141220;color:#eee;display:flex;
       align-items:center;justify-content:center;min-height:100vh;margin:0;padding:1rem}
  .card{background:#1e1b2e;padding:2rem 2.5rem;border-radius:16px;max-width:520px;width:100%}
  h2{margin:0 0 .5rem}
  .hint{color:#888;font-size:.85rem;line-height:1.4}
  .legs{margin:1rem 0;padding:0;list-style:none}
  .legs li{padding:.5rem 0;border-bottom:1px solid #2a2640;font-size:.9rem}
  button{background:#8b5cf6;color:#fff;border:0;border-radius:10px;padding:.9rem 2rem;
         font-size:1rem;cursor:pointer;width:100%;margin-top:.75rem}
  button:hover{background:#7c3aed}
  button:disabled{opacity:.5;cursor:not-allowed}
  .status{margin-top:1rem;font-size:.9rem;line-height:1.4;color:#a78bfa;min-height:1.4em}
  .ok{color:#4ade80}.err{color:#f87171}
</style></head>
<body><div class="card">
  <h2>Mint sealed cartridge</h2>
  <p class="hint">Base Sepolia · MetaMask will ask you to switch chain, approve spend, then mint.
  GotchiBot never sees your private key.</p>
  <ul class="legs" id="legs"></ul>
  <button type="button" id="go">Connect &amp; mint</button>
  <div class="status" id="status"></div>
</div>
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
        res.end(renderMintPage(plan));
        return;
      }
      if (req.url === "/callback" && req.method === "POST") {
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

/**
 * Resolve bindOwned / bindStarter JSON ABI fragment from per-chain config.
 * Missing fragment → callers return ABI_MISSING without opening a page.
 * @param {"owned"|"starter"|"bindOwned"|"bindStarter"} kind
 * @param {{ cfg?: object, chainId?: number }} [opts]
 * @returns {object|null} ethers JSON ABI fragment
 */
export function resolveBindAbi(kind, opts = {}) {
  const k = String(kind || "").toLowerCase();
  const cfg = opts.cfg || loadChainConfig(opts);
  const bindAbi = cfg.bindAbi && typeof cfg.bindAbi === "object" ? cfg.bindAbi : {};
  if (k === "owned" || k === "bindowned") {
    return bindAbi.bindOwned && typeof bindAbi.bindOwned === "object" ? bindAbi.bindOwned : null;
  }
  if (k === "starter" || k === "bindstarter") {
    return bindAbi.bindStarter && typeof bindAbi.bindStarter === "object" ? bindAbi.bindStarter : null;
  }
  return null;
}

/** Finite positive ms for bind sign page; opts > env > 5 min. Pure, never throws. */
export function resolveBindPageTimeoutMs(opts = {}, env = process.env) {
  const asPositiveMs = (v) => {
    if (v == null || v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  };
  return (
    asPositiveMs(opts.pageTimeoutMs) ??
    asPositiveMs(env?.GOTCHIBOT_BIND_PAGE_TIMEOUT_MS) ??
    5 * 60 * 1000
  );
}

function abiMissingResult(kind) {
  const label = kind === "starter" ? "bindStarter" : "bindOwned";
  return {
    ok: false,
    code: "ABI_MISSING",
    error: `not available: ${label} ABI missing — add bindAbi.${label} to config/cartridgeChain.*.json or mint at ${CONCIERGE}`,
  };
}

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

/**
 * Confirmed by Aarcadeghst CoS from ChainCartridgeProvider.ts bindStarter:
 * keccak256(toUtf8Bytes(lowercase name)); 0x+32-byte hex unchanged.
 * Re-exported from hero-mint-readback for a single encoding path.
 */
export async function encodeTemplateId(id, ethersLib = null) {
  const { encodeTemplateId: enc } = await import("./hero-mint-readback.mjs");
  const ethers = ethersLib || (await getEthers());
  return enc(id, ethers);
}

/**
 * Encode bind calldata from a per-chain JSON ABI fragment via ethers.Interface.
 */
export async function encodeBindCalldata(
  kind,
  fragment,
  { cartridgeId, sourceTokenId, templateId, collateral, paymentToken, maxAmount } = {},
  ethersLib = null,
) {
  const ethers = ethersLib || (await getEthers());
  if (!fragment || typeof fragment !== "object") {
    throw new Error("unsupported bind ABI fragment: missing JSON fragment");
  }
  const iface = new ethers.Interface([fragment]);
  const name = fragment.name || (String(kind).includes("starter") ? "bindStarter" : "bindOwned");

  if (name === "bindOwned") {
    if (cartridgeId == null || sourceTokenId == null) {
      throw new Error("unsupported bind ABI fragment: cartridgeId and sourceTokenId required");
    }
    return {
      to: null,
      data: iface.encodeFunctionData("bindOwned", [BigInt(cartridgeId), BigInt(sourceTokenId)]),
      functionName: "bindOwned",
      value: 0n,
    };
  }

  if (name === "bindStarter") {
    if (cartridgeId == null) {
      throw new Error("unsupported bind ABI fragment: cartridgeId required");
    }
    // Collateral is not checked on-chain — only forwarded to FeeSplitter.
    // AarcadeGh-t client defaults to address(0); this repo prefers a real collateral
    // token address when available (fall back to address(0) when missing/invalid).
    const coll = collateral == null || collateral === "" ? ZERO_ADDR : String(collateral);
    if (typeof ethers.isAddress === "function" && !ethers.isAddress(coll)) {
      throw new Error(`unsupported bind ABI fragment: collateral must be a valid address (${coll})`);
    }
    const { encodeTemplateId: encTid } = await import("./hero-mint-readback.mjs");
    const tid = encTid(templateId, ethers);
    const inputs = fragment.inputs || [];
    if (inputs.length === 3) {
      return {
        to: null,
        data: iface.encodeFunctionData("bindStarter", [BigInt(cartridgeId), tid, coll]),
        functionName: "bindStarter",
        templateIdBytes32: tid,
      };
    }
    if (inputs.length === 5) {
      const pay = paymentToken || ZERO_ADDR;
      const max = maxAmount != null ? BigInt(maxAmount) : 0n;
      return {
        to: null,
        data: iface.encodeFunctionData("bindStarter", [BigInt(cartridgeId), tid, coll, pay, max]),
        functionName: "bindStarter",
        templateIdBytes32: tid,
      };
    }
    throw new Error(
      `unsupported bind ABI fragment: bindStarter expects 3 (Sepolia) or 5 (mainnet) inputs, got ${inputs.length}`,
    );
  }

  throw new Error(`unsupported bind ABI fragment: unknown function ${name}`);
}

/**
 * Pure plan builder for Base mainnet starter (approve USDC → bindStarter).
 * Never auto-run; signingEnabled is false. Used by tests + docs only.
 */
export async function buildMainnetStarterPlan(
  { cartridgeId, templateId, collateral, cfg: cfgIn } = {},
  ethersLib = null,
) {
  const cfg = mintConfig({ cfg: cfgIn, chainId: 8453 });
  const ethers = ethersLib || (await getEthers());
  const diamond = cfg.cartridgeDiamond;
  const usdc = cfg.usdcToken || cfg.usdc;
  const fee = BigInt(cfg.starterBindFee || "5000000");
  const fragment = resolveBindAbi("starter", { cfg });
  if (!fragment) {
    return { ok: false, code: "ABI_MISSING", error: "bindStarter fragment missing in mainnet config" };
  }
  const encoded = await encodeBindCalldata(
    "starter",
    fragment,
    {
      cartridgeId,
      templateId,
      collateral,
      paymentToken: usdc,
      maxAmount: fee,
    },
    ethers,
  );
  const approveIface = new ethers.Interface([ERC20_APPROVE_ABI]);
  const approveData = approveIface.encodeFunctionData("approve", [diamond, fee]);
  return {
    ok: true,
    chainId: 8453,
    fee,
    usdcToken: usdc,
    cartridgeDiamond: diamond,
    note: "allowance check then approve; user-initiated, one tx at a time via the same MetaMask sign page",
    txs: [
      {
        to: usdc,
        data: approveData,
        label: "approve USDC (spender=cartridgeDiamond)",
        value: 0n,
      },
      {
        to: diamond,
        data: encoded.data,
        label: "bindStarter",
        value: 0n,
        paymentToken: usdc,
        maxAmount: fee,
      },
    ],
  };
}

function weiToHex(wei) {
  const n = typeof wei === "bigint" ? wei : BigInt(wei || 0);
  return "0x" + n.toString(16);
}

/**
 * Default readContract via ethers JsonRpcProvider (production only).
 * Tests must inject readContract — never hit live RPC in tests.
 */
async function defaultReadContract(rpcUrl) {
  const ethers = await getEthers();
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  return async function readContract({ address, abi, functionName, args = [] }) {
    const c = new ethers.Contract(address, abi, provider);
    return c[functionName](...args);
  };
}

/**
 * Read-only preflight before opening the MetaMask bind page.
 * Inject `readContract({ address, abi, functionName, args })` — tests must mock it.
 *
 * @returns {{ ok:true, checks:object[] } | { ok:false, code:"PREFLIGHT", checks:object[], error:string }}
 */
export async function runBindPreflight(opts = {}) {
  const {
    kind, // "owned" | "starter"
    expectWallet,
    cartridgeId,
    sourceTokenId = null,
    cfg: cfgIn = null,
    readContract: readIn = null,
    ethersLib = null,
  } = opts;
  const cfg = mintConfig({ cfg: cfgIn });
  const checks = [];
  const fail = (code, message) => {
    checks.push({ name: code, status: "failed", message });
    return {
      ok: false,
      code: "PREFLIGHT",
      checks,
      error: message,
    };
  };

  const readContract =
    typeof readIn === "function"
      ? readIn
      : await defaultReadContract(cfg.rpc);

  const diamond = cfg.cartridgeDiamond;
  const want = String(expectWallet || "").toLowerCase();

  // 1. sender owns the cartridge
  try {
    const owner = String(
      await readContract({
        address: diamond,
        abi: resolvePreflightViewAbi(cfg, "ownerOf"),
        functionName: "ownerOf",
        args: [BigInt(cartridgeId)],
      }),
    ).toLowerCase();
    if (owner !== want) {
      return fail(
        "ownerOf",
        `cartridge #${cartridgeId} owner is ${owner}, expected wallet ${want}`,
      );
    }
    checks.push({ name: "ownerOf", status: "passed", message: `wallet owns cartridge #${cartridgeId}` });
  } catch (e) {
    return fail("ownerOf", `ownerOf failed: ${e?.message || e}`);
  }

  // 2. portalStatus: 0 LEGACY / 2 OPEN ok; only 1 SEALED blocks bind
  // (LibCartridgeAppStorage PORTAL_*; GotchiBotNestFacet open)
  try {
    const status = Number(
      await readContract({
        address: diamond,
        abi: resolvePreflightViewAbi(cfg, "portalStatus"),
        functionName: "portalStatus",
        args: [BigInt(cartridgeId)],
      }),
    );
    if (status === 1) {
      return fail(
        "portalStatus",
        `cartridge #${cartridgeId} is SEALED — it must be opened (GotchiBotNestFacet open) first`,
      );
    }
    checks.push({
      name: "portalStatus",
      status: "passed",
      message: `portalStatus=${status} (not sealed)`,
    });
  } catch (e) {
    return fail("portalStatus", `portalStatus failed: ${e?.message || e}`);
  }

  // 3. lineAPaid — true when mint fee is 0 or Line A is paid (GameRulesFacet)
  try {
    const paid = await readContract({
      address: diamond,
      abi: resolvePreflightViewAbi(cfg, "lineAPaid"),
      functionName: "lineAPaid",
      args: [BigInt(cartridgeId)],
    });
    if (!paid) {
      return fail(
        "lineAPaid",
        'Line A unpaid — bind would revert "Cartridge: LINE_A_UNPAID"',
      );
    }
    checks.push({
      name: "lineAPaid",
      status: "passed",
      message: "Line A paid (or mint fee is 0)",
    });
  } catch (e) {
    return fail("lineAPaid", `lineAPaid failed: ${e?.message || e}`);
  }

  // 4. bindOwned extras
  if (String(kind) === "owned") {
    const l1 = cfg.l1AavegotchiDiamond;
    if (!l1) {
      return fail("l1OwnerOf", "l1AavegotchiDiamond missing from chain config");
    }
    try {
      const l1Owner = String(
        await readContract({
          address: l1,
          abi: PREFLIGHT_L1_ABI,
          functionName: "ownerOf",
          args: [BigInt(sourceTokenId)],
        }),
      ).toLowerCase();
      if (l1Owner !== want) {
        return fail(
          "l1OwnerOf",
          `L1 gotchi #${sourceTokenId} owner is ${l1Owner}, expected ${want}`,
        );
      }
      checks.push({
        name: "l1OwnerOf",
        status: "passed",
        message: `wallet owns L1 gotchi #${sourceTokenId}`,
      });
    } catch (e) {
      return fail("l1OwnerOf", `L1 ownerOf failed: ${e?.message || e}`);
    }

    const ethers = ethersLib || (await getEthers());
    const { ownedHeroIdBytes32 } = await import("./hero-mint-readback.mjs");
    const expectedHero = ownedHeroIdBytes32(sourceTokenId, ethers);
    try {
      const ids = await readContract({
        address: diamond,
        abi: resolvePreflightViewAbi(cfg, "heroIds"),
        functionName: "heroIds",
        args: [BigInt(cartridgeId)],
      });
      const list = Array.from(ids || []).map((x) => String(x).toLowerCase());
      if (list.includes(String(expectedHero).toLowerCase())) {
        return fail(
          "alreadyBound",
          `owned hero for token #${sourceTokenId} already bound on cartridge #${cartridgeId}`,
        );
      }
      checks.push({
        name: "alreadyBound",
        status: "passed",
        message: "deterministic owned heroId not yet in heroIds",
      });
    } catch (e) {
      return fail("alreadyBound", `heroIds failed: ${e?.message || e}`);
    }
  }

  return { ok: true, checks };
}

function printPreflightChecks(checks) {
  for (const c of checks || []) {
    const tag =
      c.status === "passed" ? "✓" : c.status === "skipped" ? "·" : "✗";
    console.log(`  ${tag} preflight ${c.name}: ${c.message}`);
  }
}

function costLineForBind(kind, cfg) {
  if (String(kind) === "starter" && Number(cfg.chainId) === 84532) {
    return "5 Sepolia test ETH (placeholder fee)";
  }
  return "Free (gas only)";
}

async function openBindSignPage({
  expectWallet,
  diamond,
  data,
  label,
  value = null,
  costLine = null,
  chainId = CHAIN_ID,
  auto = true,
  pageTimeoutMs,
}) {
  freePort();
  const chainHex =
    Number(chainId) === 8453 ? "0x2105" : CHAIN_HEX;
  const timeoutMs = resolveBindPageTimeoutMs({ pageTimeoutMs }, process.env);
  const timeoutMin = Math.max(1, Math.round(timeoutMs / 60000));
  const plan = {
    expectWallet: String(expectWallet || "").toLowerCase(),
    diamond,
    data,
    label: label || "bind",
    value: value != null && BigInt(value) > 0n ? weiToHex(value) : null,
    costLine: costLine || "Free (gas only)",
    chainId: Number(chainId),
    chainHex,
  };
  console.log(`  Cost: ${plan.costLine || "Free (gas only)"}`);
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
      console.log(`\n  Opening MetaMask ${plan.label} page → ${url}`);
      console.log("  Confirm in the browser, then return here.\n");
      if (auto) openBrowser(url);
    });

    setTimeout(() => {
      if (!settled) finish({ ok: false, error: `${plan.label} timed out (${timeoutMin} min)` });
    }, timeoutMs);
  });
}

function renderBindPage(plan) {
  const planJson = JSON.stringify(plan);
  const chainName = Number(plan.chainId) === 8453 ? "Base" : "Base Sepolia";
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${plan.label} — GotchiBot</title>
<style>
  body{font-family:-apple-system,sans-serif;background:#141220;color:#eee;display:flex;
       align-items:center;justify-content:center;min-height:100vh;margin:0;padding:1rem}
  .card{background:#1e1b2e;padding:2rem 2.5rem;border-radius:16px;max-width:480px;width:100%}
  h2{margin:0 0 .5rem}
  .hint{color:#888;font-size:.85rem;line-height:1.4}
  .cost{margin:.75rem 0;padding:.75rem 1rem;background:#2a2540;border-radius:10px;font-size:.95rem}
  button{background:#8b5cf6;color:#fff;border:0;border-radius:10px;padding:.9rem 2rem;
         font-size:1rem;cursor:pointer;width:100%;margin-top:.75rem}
  button:hover{background:#7c3aed}
  button:disabled{opacity:.5;cursor:not-allowed}
  .status{margin-top:1rem;font-size:.9rem;line-height:1.4;color:#a78bfa;min-height:1.4em}
  .ok{color:#4ade80}.err{color:#f87171}
</style></head>
<body><div class="card">
  <h2>${plan.label}</h2>
  <p class="hint">${chainName} · MetaMask will ask you to switch chain, then submit this one bind tx only.</p>
  <div class="cost"><strong>Cost:</strong> ${plan.costLine || "Free (gas only)"}</div>
  <button type="button" id="go">Connect &amp; sign</button>
  <div class="status" id="status"></div>
</div>
<script type="module">
const PLAN = ${planJson};
const CHAIN_HEX = PLAN.chainHex || '${CHAIN_HEX}';

function friendlyError(e) {
  const msg = String(e?.message || e || '');
  if (/user rejected|rejected the request|4001/i.test(msg)) return 'Cancelled in wallet.';
  if (/metamask extension not found/i.test(msg)) return 'Install MetaMask in Chrome/Brave, reload, retry.';
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
    status.textContent = 'Confirm ' + PLAN.label + ' in MetaMask…';
    const txParams = { from, to: PLAN.diamond, data: PLAN.data, chainId: CHAIN_HEX };
    if (PLAN.value) txParams.value = PLAN.value;
    const txHash = await eth.request({
      method: 'eth_sendTransaction',
      params: [txParams],
    });
    status.className = 'status ok';
    status.textContent = 'Submitted · ' + txHash;
    await postDone({ ok: true, txHash });
  } catch (e) {
    status.className = 'status err';
    status.textContent = friendlyError(e);
    await postDone({ ok: false, error: friendlyError(e) });
    btn.disabled = false;
  }
};
</script></body></html>`;
}

async function maybePreflight(opts, kind) {
  // Run when readContract injected, or when opening a real page (no signTx).
  const hasSignTx = typeof opts.signTx === "function";
  const hasRead = typeof opts.readContract === "function";
  if (opts.skipPreflight === true) return { ok: true, checks: [] };
  if (hasSignTx && !hasRead) return { ok: true, checks: [] };
  const pf = await runBindPreflight({
    kind,
    expectWallet: opts.expectWallet,
    cartridgeId: opts.cartridgeId,
    sourceTokenId: opts.sourceTokenId,
    cfg: opts.cfg,
    readContract: opts.readContract,
    ethersLib: opts.ethersLib,
  });
  if (opts.printPreflight !== false) printPreflightChecks(pf.checks);
  return pf;
}

/**
 * MetaMask bindOwned on cartridgeDiamond. Never uses --private-key.
 * Base mainnet (8453) → MAINNET_DISABLED (no page).
 */
export async function runBindOwned(opts = {}) {
  try {
    const cfg = mintConfig(opts);
    if (Number(cfg.chainId) === 8453 || cfg.signingEnabled === false) {
      return { ...MAINNET_DISABLED };
    }

    const { expectWallet, cartridgeId, sourceTokenId, signTx = null, openSignPage = null } = opts;
    const fragment = resolveBindAbi("owned", { cfg });
    if (!fragment) return abiMissingResult("owned");

    const diamond = cfg.cartridgeDiamond;
    if (!diamond) {
      return { ok: false, code: "CONFIG", error: "cartridgeDiamond missing from chain config" };
    }
    if (cartridgeId == null || sourceTokenId == null) {
      return { ok: false, code: "ARGS", error: "cartridgeId and sourceTokenId required" };
    }

    const pf = await maybePreflight(opts, "owned");
    if (!pf.ok) return pf;

    const encoded = await encodeBindCalldata(
      "owned",
      fragment,
      { cartridgeId, sourceTokenId },
      opts.ethersLib || null,
    );
    const costLine = costLineForBind("owned", cfg);
    const plan = {
      to: diamond,
      chainId: Number(cfg.chainId) || CHAIN_ID,
      data: encoded.data,
      expectWallet: String(expectWallet || "").toLowerCase(),
      label: "bindOwned",
      functionName: encoded.functionName,
      value: 0n,
      costLine,
    };

    if (typeof signTx === "function") {
      if (opts.printCost !== false) console.log(`  Cost: ${costLine}`);
      const out = await signTx(plan);
      return {
        ok: Boolean(out?.ok),
        txHash: out?.txHash || null,
        error: out?.error || null,
        code: out?.ok ? null : out?.code || "SIGN",
      };
    }
    if (typeof openSignPage === "function") {
      if (opts.printCost !== false) console.log(`  Cost: ${costLine}`);
      const out = await openSignPage(plan);
      return {
        ok: Boolean(out?.ok),
        txHash: out?.txHash || null,
        error: out?.error || null,
      };
    }
    return openBindSignPage({
      expectWallet: plan.expectWallet,
      diamond,
      data: plan.data,
      label: "bindOwned",
      value: null,
      costLine,
      chainId: plan.chainId,
      pageTimeoutMs: opts.pageTimeoutMs,
    });
  } catch (e) {
    const msg = String(e?.message || e);
    const code = /unsupported bind ABI fragment/i.test(msg) ? "ABI_UNSUPPORTED" : "ERROR";
    return { ok: false, code, error: msg };
  }
}

/**
 * MetaMask bindStarter on cartridgeDiamond (Sepolia: payable 5 test ETH).
 * Base mainnet → MAINNET_DISABLED. No USDC approve on Sepolia.
 */
export async function runBindStarter(opts = {}) {
  try {
    const cfg = mintConfig(opts);
    if (Number(cfg.chainId) === 8453 || cfg.signingEnabled === false) {
      return { ...MAINNET_DISABLED };
    }

    const {
      expectWallet,
      cartridgeId,
      templateId,
      collateral,
      signTx = null,
      openSignPage = null,
    } = opts;
    const fragment = resolveBindAbi("starter", { cfg });
    if (!fragment) return abiMissingResult("starter");

    const diamond = cfg.cartridgeDiamond;
    if (!diamond) {
      return { ok: false, code: "CONFIG", error: "cartridgeDiamond missing from chain config" };
    }
    if (cartridgeId == null) {
      return { ok: false, code: "ARGS", error: "cartridgeId required" };
    }

    const pf = await maybePreflight({ ...opts, sourceTokenId: null }, "starter");
    if (!pf.ok) return pf;

    const feeWei = BigInt(cfg.starterBindFeeWei || "5000000000000000000");
    const encoded = await encodeBindCalldata(
      "starter",
      fragment,
      { cartridgeId, templateId, collateral },
      opts.ethersLib || null,
    );
    const costLine = costLineForBind("starter", cfg);
    const plan = {
      to: diamond,
      chainId: Number(cfg.chainId) || CHAIN_ID,
      data: encoded.data,
      expectWallet: String(expectWallet || "").toLowerCase(),
      label: "bindStarter",
      functionName: encoded.functionName,
      value: feeWei,
      costLine,
    };

    if (typeof signTx === "function") {
      if (opts.printCost !== false) console.log(`  Cost: ${costLine}`);
      const out = await signTx(plan);
      return {
        ok: Boolean(out?.ok),
        txHash: out?.txHash || null,
        error: out?.error || null,
        code: out?.ok ? null : out?.code || "SIGN",
      };
    }
    if (typeof openSignPage === "function") {
      if (opts.printCost !== false) console.log(`  Cost: ${costLine}`);
      const out = await openSignPage(plan);
      return {
        ok: Boolean(out?.ok),
        txHash: out?.txHash || null,
        error: out?.error || null,
      };
    }
    return openBindSignPage({
      expectWallet: plan.expectWallet,
      diamond,
      data: plan.data,
      label: "bindStarter",
      value: feeWei,
      costLine,
      chainId: plan.chainId,
      pageTimeoutMs: opts.pageTimeoutMs,
    });
  } catch (e) {
    const msg = String(e?.message || e);
    const code = /unsupported bind ABI fragment/i.test(msg) ? "ABI_UNSUPPORTED" : "ERROR";
    return { ok: false, code, error: msg };
  }
}

function renderOpenPage(plan) {
  const planJson = JSON.stringify(plan);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Open sealed GotchiBot cart</title>
<style>
  body{font-family:-apple-system,sans-serif;background:#141220;color:#eee;display:flex;
       align-items:center;justify-content:center;min-height:100vh;margin:0;padding:1rem}
  .card{background:#1e1b2e;padding:2rem 2.5rem;border-radius:16px;max-width:480px;width:100%}
  h2{margin:0 0 .5rem}
  .hint{color:#888;font-size:.85rem;line-height:1.4}
  button{background:#8b5cf6;color:#fff;border:0;border-radius:10px;padding:.9rem 2rem;
         font-size:1rem;cursor:pointer;width:100%;margin-top:.75rem}
  button:hover{background:#7c3aed}
  button:disabled{opacity:.5;cursor:not-allowed}
  .status{margin-top:1rem;font-size:.9rem;line-height:1.4;color:#a78bfa;min-height:1.4em}
  .ok{color:#4ade80}.err{color:#f87171}
</style></head>
<body><div class="card">
  <h2>Open sealed cartridge</h2>
  <p class="hint">Base Sepolia · MetaMask will ask you to switch chain, then call
  <code>open(#${plan.cartridgeId})</code>. After this you can bind a gotchi as orch.</p>
  <button type="button" id="go">Connect &amp; open</button>
  <div class="status" id="status"></div>
</div>
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`usage: cartridge-mint-sepolia.mjs --product abra|gotchibot|bundle [--tier …] [--pay usdc|ghst] [--quote] [--json]
       cartridge-mint-sepolia.mjs --open [cartridgeId]
bindOwned / bindStarter: per-chain JSON fragments in config/cartridgeChain.base-sepolia.json
  (Sepolia: bindOwned free; bindStarter payable 5 Sepolia test ETH placeholder — old Sep 4 facet).
  Base mainnet fragments in config/cartridgeChain.base.json — signing DISABLED (MAINNET_DISABLED)
  pending AarcadeGh-t PR #28. Concierge: ${CONCIERGE}`);
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
