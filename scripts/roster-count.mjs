#!/usr/bin/env node
/**
 * Print wallet gotchi + cartridge cAavegotchi counts for the tmux status bar.
 * Caches under sessions/.roster-cache.json (default TTL 5m).
 *
 * usage:
 *   node scripts/roster-count.mjs           # "gotchis:23 cAave:1"
 *   node scripts/roster-count.mjs --json
 *   node scripts/roster-count.mjs --refresh
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchWalletGotchis, fetchCartridgeHeroes, readWalletFile } from "./onboarding-lib.mjs";
import { loadMeta } from "./identity.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = `${ROOT}/sessions/.roster-cache.json`;
const TTL_MS = Number(process.env.GOTCHIBOT_ROSTER_TTL_MS || 5 * 60 * 1000);
const json = process.argv.includes("--json");
const force = process.argv.includes("--refresh");

function readCache() {
  try {
    const c = JSON.parse(readFileSync(CACHE, "utf8"));
    if (!force && c.fetchedAt && Date.now() - Date.parse(c.fetchedAt) < TTL_MS) return c;
  } catch {}
  return null;
}

function writeCache(data) {
  mkdirSync(dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, `${JSON.stringify(data, null, 2)}\n`);
}

async function load() {
  const cached = readCache();
  if (cached) return cached;

  const wallet = readWalletFile();
  const meta = loadMeta();
  if (!wallet) {
    return { wallet: null, gotchis: 0, cAavegotchis: 0, fetchedAt: new Date().toISOString(), error: "no-wallet" };
  }

  const [owned, heroes] = await Promise.all([
    fetchWalletGotchis(wallet).catch(() => []),
    meta.cartridgeId ? fetchCartridgeHeroes(meta.cartridgeId).catch(() => []) : Promise.resolve([]),
  ]);

  const data = {
    wallet,
    cartridgeId: meta.cartridgeId ?? null,
    gotchis: owned.length,
    cAavegotchis: heroes.length,
    fetchedAt: new Date().toISOString(),
  };
  writeCache(data);
  return data;
}

const data = await load();
if (json) {
  console.log(JSON.stringify(data));
} else if (!data.wallet) {
  console.log("gotchis:? cAave:?");
} else {
  console.log(`gotchis:${data.gotchis} cAave:${data.cAavegotchis}`);
}
