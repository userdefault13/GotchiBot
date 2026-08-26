#!/usr/bin/env node
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { call, loadMeta } from "./identity.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CAST = "/Users/juliuswong/.foundry/bin/cast";
const BASE_DIAMOND = "0xA99c4B08201F2913Db8D28e71d020c4298F29dBF";
const POLYGON_DIAMOND = "0x86935F11C86623deC8a25696E1C19a8659CbF95d";
const RPC_BASE = process.env.GOTCHIBOT_BASE_RPC ?? "https://mainnet.base.org";
const SIG = "previewAavegotchi(uint256,address,int16[6],uint16[16])";

const COLLATERAL_KEYS = {
  dai: "aDAI", weth: "aWETH", aave: "aAAVE", link: "aLINK",
  usdt: "aUSDT", usdc: "aUSDC", tusd: "aTUSD", uni: "aUNI",
  yfi: "aYFI", wbtc: "amWBTC", matic: "amWMATIC",
};
const COLLATERAL_ADDRESSES = {
  aDAI: "0xE0b22E0037B130A9F56bBb537684E6fA18192341",
  aWETH: "0x20d3922b4a1a8560e1ac99fba4fade0c849e2142",
  aAAVE: "0x823cd4264c1b951c9209ad0deaea9988fe8429bf",
  aLINK: "0x98ea609569bd25119707451ef982b90e3eb719cd",
  aUSDT: "0xDAE5F1590db13E3B40423B5b5c5fbf175515910b",
  aUSDC: "0x9719d867A500Ef117cC201206B8ab51e794d3F82",
  aTUSD: "0xF4b8888427b00d7caf21654408B7CBA2eCf4EbD9",
  aUNI: "0x8c8bdBe9CeE455732525086264a4Bf9Cf821C498",
  aYFI: "0xe20f7d1f0eC39C4d5DB01f53554F2EF54c71f613",
  amWBTC: "0x5c2ed810328349100A66B82b78a1791B101C9D61",
  amWMATIC: "0x8dF3aad3a84da6b69A4DA8aeC3eA40d9091B2Ac4",
};

function collateralAddress(name) {
  const key = COLLATERAL_KEYS[String(name ?? "").toLowerCase()];
  return key ? COLLATERAL_ADDRESSES[key] : null;
}

function previewOnChain(diamond, rpcUrl, hauntId, collateralAddr, traits, equipped) {
  const hex = execFileSync(CAST, [
    "call", diamond, SIG,
    String(hauntId || 1),
    collateralAddr,
    `[${traits.join(",")}]`,
    `[${equipped.join(",")}]`,
    "--rpc-url", rpcUrl,
  ], { encoding: "utf8" }).trim();
  if (!hex.startsWith("0x")) throw new Error("unexpected call output");
  const raw = hex.slice(2);
  const dataLen = parseInt(raw.slice(64, 128), 16);
  const svgHex = raw.slice(128, 128 + dataLen * 2);
  return Buffer.from(svgHex, "hex").toString("utf8");
}

export function normalizeSvg(svg) {
  const styleMatch = /<style>([\s\S]*?)<\/style>/i.exec(svg);
  if (!styleMatch) return svg;
  const rules = [...styleMatch[1].matchAll(/\.([a-zA-Z-]+)\s*\{([^}]+)\}/g)];
  const hidden = new Set();

  const rewriteTag = (m0, tag, attrs, selfClose, className, extraStyle) => {
    const clsMatch = /\bclass="([^"]*)"/i.exec(attrs);
    let next = attrs;
    if (clsMatch) {
      const keep = clsMatch[1].split(/\s+/).filter((c) => c && c !== className);
      next = next.replace(clsMatch[0], keep.length ? `class="${keep.join(" ")}"` : "");
    }
    return `<${tag}${next}${extraStyle}${selfClose}>`;
  };

  for (const [, className, decls] of rules) {
    const isHidden = /display\s*:\s*none/.test(decls);
    if (isHidden) hidden.add(className);
    const fill = !isHidden ? /(?:^|;)\s*fill\s*:\s*([^;}]+)/i.exec(decls)?.[1]?.trim() : null;
    const extra = isHidden ? ' style="display:none"' : "";
    svg = svg.replace(
      new RegExp(`<([a-z][a-z0-9]*)([^>]*\\bclass="[^"]*\\b${className}\\b[^"]*"[^>]*?)(/?)>`, "gi"),
      (m0, tag, attrs, selfClose) => rewriteTag(m0, tag, attrs, selfClose, className, extra),
    );
  }

  svg = svg.replace(
    /<g([^>]*)\bclass="gotchi-bg(?!-rh)([^"]*)"([^>]*)>/gi,
    (_m, pre, _c, post) => `<g${pre} class="gotchi-bg"${post} style="display:none">`,
  );
  svg = svg.replace(/<style>[\s\S]*?<\/style>/i, "");
  return svg;
}

async function loadHero(heroId) {
  const meta = loadMeta();
  if (!meta?.cartridgeId) throw new Error("no cartridge — run: gotchibot init");
  const r = await call(`/cartridges/${meta.cartridgeId}`);
  if (!r.ok) throw new Error(`cartridge fetch failed: ${JSON.stringify(r.data).slice(0, 120)}`);
  const s = r.data.cartridge ?? r.data;
  const roster = s.cAavegotchis ?? [];
  const hero = heroId ? roster.find((h) => h.id === heroId) : s.activeCAavegotchi ?? roster[0];
  if (!hero) throw new Error(`hero not found (roster: ${roster.map((h) => h.id).join(", ") || "empty"})`);
  return hero;
}

async function main() {
  const heroId = process.argv[2];
  const hero = await loadHero(heroId);

  const idCollateral = /^starter-([a-z]+)-h\d/.exec(hero.id ?? "")?.[1];
  const collateralName = hero.collateral ?? idCollateral;
  const collateralAddr = collateralAddress(collateralName);
  if (!collateralAddr) throw new Error(`unknown collateral: ${hero.collateral}`);
  const traits = (hero.modifiedTraits ?? hero.traits ?? []).map((t) =>
    Math.max(-128, Math.min(127, Math.round(Number(t) || 0)))
  );
  while (traits.length < 6) traits.push(50);
  const equipped = Array.isArray(hero.equippedWearables)
    ? hero.equippedWearables.map((w) => Math.round(Number(w) || 0))
    : new Array(16).fill(0);
  while (equipped.length < 16) equipped.push(0);

  let svg;
  try {
    svg = previewOnChain(BASE_DIAMOND, RPC_BASE, hero.hauntId ?? 1, collateralAddr, traits, equipped);
  } catch (e) {
    console.error(`base rpc failed (${String(e.message).split("\n")[0]}), trying polygon…`);
    svg = previewOnChain(POLYGON_DIAMOND, process.env.GOTCHIBOT_POLYGON_RPC ?? "https://polygon-rpc.com", hero.hauntId ?? 1, collateralAddr, traits, equipped);
  }
  if (!svg || svg.length < 80) throw new Error("empty preview svg");

  const outDir = `${ROOT}/sessions/.avatars`;
  mkdirSync(outDir, { recursive: true });
  const out = `${outDir}/${hero.id}.svg`;
  writeFileSync(out, normalizeSvg(svg));

  console.log(JSON.stringify({ hero: hero.id, traits, out, bytes: svg.length }));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
