#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchWalletGotchis } from "./onboarding-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function walletAddress() {
  const argIdx = process.argv.indexOf("--wallet");
  const direct = process.argv[argIdx + 1];
  if (direct && /^0x[a-fA-F0-9]{40}$/.test(direct)) return direct.toLowerCase();
  try {
    const w = JSON.parse(readFileSync(`${ROOT}/sessions/.wallet.json`, "utf8"));
    if (w.address) return w.address.toLowerCase();
  } catch {}
  console.error("no wallet connected — run: gotchibot connect  (or pass --wallet 0x…)");
  process.exit(1);
}

const owner = walletAddress();
console.log(`owner: ${owner}`);

const gotchis = await fetchWalletGotchis(owner);
console.log(`${gotchis.length} gotchi(es) via subgraph`);
for (const g of gotchis) {
  const name = g.name || `#${g.gotchiId}`;
  const haunt = g.hauntId ? `haunt${g.hauntId}` : "haunt?";
  const coll = g.collateral ? String(g.collateral).slice(0, 10).padEnd(10) : "—".padEnd(10);
  console.log(`  #${g.gotchiId}  ${name.padEnd(20)} ${haunt}  ${coll}`);
}
