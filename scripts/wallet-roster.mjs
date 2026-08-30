#!/usr/bin/env node
/**
 * Wallet gotchi list — same path as cockpit / onboarding-gate.
 * fetchWalletGotchis (onboarding-lib.mjs): Envio subgraph, then Base RPC.
 * Never Blockscout. Used by: gotchibot roster --wallet, spawn overlay.
 */
import { readFileSync } from "node:fs";
import { writeWalletGotchiCache } from "./collateral-resolve.mjs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchWalletGotchis } from "./onboarding-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wantJson = process.argv.includes("--json");

function walletAddress() {
  const argIdx = process.argv.indexOf("--wallet");
  const direct = process.argv[argIdx + 1];
  if (direct && /^0x[a-fA-F0-9]{40}$/.test(direct)) return direct.toLowerCase();
  try {
    const w = JSON.parse(readFileSync(`${ROOT}/sessions/.wallet.json`, "utf8"));
    if (w.address) return w.address.toLowerCase();
  } catch {}
  if (wantJson) {
    console.log(JSON.stringify({ error: "no wallet connected", gotchis: [] }));
  } else {
    console.error("no wallet connected — run: gotchibot connect  (or pass --wallet 0x…)");
  }
  process.exit(1);
}

function loadCollateralNames() {
  const map = new Map();
  try {
    const data = JSON.parse(readFileSync(`${ROOT}/assets/collateral-colors.json`, "utf8"));
    for (const c of data.collaterals || []) {
      if (c.collateralType && c.name) {
        map.set(String(c.collateralType).toLowerCase(), String(c.name));
      }
    }
  } catch {}
  return map;
}

function collateralName(addr, names) {
  if (!addr) return null;
  const key = String(addr).toLowerCase();
  if (names.has(key)) return names.get(key);
  if (key.startsWith("0x") && key.length === 42) return `${key.slice(0, 6)}…${key.slice(-4)}`;
  return String(addr);
}

const owner = walletAddress();
const names = loadCollateralNames();
const gotchis = await fetchWalletGotchis(owner);
const rows = gotchis.map((g) => {
  const id = String(g.gotchiId);
  const collName = collateralName(g.collateral, names);
  return {
    gotchiId: id,
    tokenId: id,
    name: g.name || null,
    hauntId: g.hauntId ?? null,
    haunt: g.hauntId != null ? `haunt${g.hauntId}` : null,
    collateral: g.collateral ?? null,
    collateralName: collName,
  };
});

try {
  writeWalletGotchiCache({ owner, source: gotchis.source || null, gotchis: rows });
} catch {}

if (wantJson) {
  console.log(JSON.stringify({ owner, source: gotchis.source || null, gotchis: rows }));
  process.exit(0);
}

console.log(`owner: ${owner}`);
console.log(`${rows.length} gotchi(es) via ${gotchis.source || "subgraph"}`);
for (const g of rows) {
  const name = g.name || `#${g.gotchiId}`;
  const haunt = g.haunt || "haunt?";
  const coll = (g.collateralName || "—").padEnd(10);
  console.log(`  #${g.gotchiId}  ${String(name).padEnd(20)} ${haunt}  ${coll}`);
}
