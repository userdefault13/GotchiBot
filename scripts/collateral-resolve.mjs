#!/usr/bin/env node
/**
 * Resolve AarcadeGh-t collateral colors for a cAavegotchi.
 *
 * Body color comes from assets/collateral-colors.json (primary + secondary),
 * never from agent status. Status stays on the avatar label only.
 *
 * Lookup order:
 *   1. hero.collateralAddress
 *   2. hero.collateral
 *   3. hero.collateralType
 *   4. persisted sessions/.hero-agent-state.json
 *   5. sourceTokenId / owned-<tokenId> → sessions/.wallet-gotchis.json
 *   6. id starter-<spirit>-hN
 *   7. JSON by spirit id (wbtc), name (amWBTC), label (BTC)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = `${ROOT}/sessions`;
const COLORS_PATH = `${ROOT}/assets/collateral-colors.json`;
const AARCADE_COLORS = resolve(ROOT, "../AarcadeGh-t/public/data/aavegotchi_db_collaterals.json");
const WALLET_CACHE = `${SESSIONS}/.wallet-gotchis.json`;
const HERO_STATE = `${SESSIONS}/.hero-agent-state.json`;
const ATOKEN_SPIRITS = new Set([
  "dai", "weth", "aave", "link", "usdt", "usdc", "tusd", "uni", "yfi",
  "wbtc", "wmatic", "matic",
]);

export function libraryNameToSpiritId(name) {
  const raw = String(name || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw === "btc" || raw === "bitcoin" || raw === "wbtc" || raw === "amwbtc") return "wbtc";
  const h2Rest = raw.startsWith("am") ? raw.slice(2) : "";
  const h1Rest = raw.startsWith("ma") ? raw.slice(2) : "";
  const isATokenRest = (rest) => ATOKEN_SPIRITS.has(rest);
  let n = raw;
  if (h2Rest && isATokenRest(h2Rest)) n = h2Rest;
  else if (h1Rest && isATokenRest(h1Rest)) n = h1Rest;
  else if (raw.startsWith("a") && ATOKEN_SPIRITS.has(raw.slice(1))) n = raw.slice(1);
  if (n === "wmatic" || n === "matic") return "matic";
  if (n === "btc" || n === "bitcoin") return "wbtc";
  return n;
}

export function displayCollateralLabel(libraryName, spiritId) {
  const spirit = spiritId || libraryNameToSpiritId(libraryName);
  if (spirit === "matic") return "MATIC";
  if (spirit === "wbtc") return "BTC";
  return String(libraryName || spirit).trim();
}

export function hexNormalize(raw) {
  if (!raw) return null;
  let h = String(raw).trim().replace(/^0x/i, "").replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return h.toLowerCase();
}

export function tokenIdFromHeroId(id) {
  const m = /^owned-(\d+)$/i.exec(String(id || ""));
  return m ? m[1] : null;
}

export function starterSpiritFromHeroId(id) {
  const m = /^starter-([a-z0-9]+)-h(\d+)/i.exec(String(id || ""));
  if (!m) return null;
  return { spirit: m[1].toLowerCase(), hauntId: Number(m[2]) || 1 };
}

function readJson(path, fallback = null) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function packColors(row) {
  if (!row) return null;
  const primary = hexNormalize(row.primaryColor ?? row.primary);
  const secondary = hexNormalize(row.secondaryColor ?? row.secondary);
  if (!primary && !secondary) return null;
  const spirit = libraryNameToSpiritId(row.name || row.spirit || "");
  return {
    name: row.name || null,
    spirit: spirit || null,
    label: displayCollateralLabel(row.name, spirit),
    primary,
    secondary,
    cheek: hexNormalize(row.cheekColor ?? row.cheek),
    hauntId: row.haunt != null ? Number(row.haunt) : (row.hauntId != null ? Number(row.hauntId) : null),
    collateralType: row.collateralType ? String(row.collateralType).toLowerCase() : null,
  };
}

let _table = null;
export function loadCollateralTable() {
  if (_table) return _table;
  const paths = [
    process.env.GOTCHIBOT_COLLATERAL_COLORS,
    COLORS_PATH,
    AARCADE_COLORS,
  ].filter(Boolean);
  for (const p of paths) {
    try {
      if (!existsSync(p)) continue;
      const raw = JSON.parse(readFileSync(p, "utf8"));
      const list = raw.collaterals ?? (Array.isArray(raw) ? raw : []);
      if (list.length) {
        _table = list;
        return _table;
      }
    } catch {}
  }
  _table = [];
  return _table;
}

/**
 * Match JSON row by address, exact name (amWBTC), spirit (wbtc), or label (BTC).
 * Haunt 2 amWBTC vs haunt 1 — prefer matching haunt, then any haunt.
 */
export function findCollateralColors(collateralTypeOrName, hauntId = 1) {
  const list = loadCollateralTable();
  const key = String(collateralTypeOrName || "").trim().toLowerCase();
  if (!key || !list.length) return null;
  const haunt = Number(hauntId) || 1;
  const spirit = libraryNameToSpiritId(key);

  const score = (c) => {
    const addr = String(c.collateralType || "").toLowerCase();
    const name = String(c.name || "").toLowerCase();
    const cSpirit = libraryNameToSpiritId(c.name);
    const label = displayCollateralLabel(c.name, cSpirit).toLowerCase();
    if (addr && addr === key) return 100;
    if (name && name === key) return 90;
    if (cSpirit && spirit && cSpirit === spirit) return 80;
    if (label && (label === key || label === spirit)) return 70;
    if (spirit && name.replace(/[^a-z0-9]/g, "") === spirit) return 60;
    return 0;
  };

  let best = null;
  let bestScore = 0;
  let bestHauntDelta = 99;
  for (const c of list) {
    const s = score(c);
    if (s <= 0) continue;
    const delta = Math.abs((Number(c.haunt) || 1) - haunt);
    if (s > bestScore || (s === bestScore && delta < bestHauntDelta)) {
      best = c;
      bestScore = s;
      bestHauntDelta = delta;
    }
  }
  return packColors(best);
}

export function loadWalletGotchiIndex() {
  const cache = readJson(WALLET_CACHE, null);
  const rows = cache?.gotchis ?? cache?.rows ?? (Array.isArray(cache) ? cache : []);
  const map = new Map();
  for (const g of rows) {
    const id = String(g.gotchiId ?? g.tokenId ?? g.id ?? "");
    if (!id) continue;
    map.set(id, g);
  }
  return map;
}

export function writeWalletGotchiCache({ owner, source, gotchis }) {
  mkdirSync(SESSIONS, { recursive: true });
  const payload = {
    owner: owner || null,
    source: source || null,
    gotchis: (gotchis || []).map((g) => ({
      gotchiId: String(g.gotchiId ?? g.tokenId ?? ""),
      tokenId: String(g.tokenId ?? g.gotchiId ?? ""),
      name: g.name || null,
      hauntId: g.hauntId != null ? Number(g.hauntId) : null,
      collateral: g.collateral ?? null,
      collateralName: g.collateralName ?? null,
    })),
    fetchedAt: new Date().toISOString(),
  };
  writeFileSync(WALLET_CACHE, `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

export function loadHeroState(heroId) {
  const all = readJson(HERO_STATE, {}) || {};
  if (!heroId) return all;
  return all[heroId] || null;
}

/**
 * Merge collateral + colors onto the hero cache without clobbering status.
 */
export function persistHeroCollateral(heroId, info = {}) {
  if (!heroId) return null;
  mkdirSync(SESSIONS, { recursive: true });
  const all = readJson(HERO_STATE, {}) || {};
  const prev = all[heroId] || {};
  const colors = info.primary
    ? info
    : findCollateralColors(
        info.collateralAddress || info.collateral || info.collateralName || info.spirit,
        info.hauntId ?? prev.hauntId ?? 1,
      );
  const next = {
    ...prev,
    ...(info.status ? { status: info.status } : {}),
    collateral: info.collateral || info.spirit || colors?.spirit || prev.collateral || null,
    collateralAddress: info.collateralAddress || prev.collateralAddress || null,
    collateralName: info.collateralName || colors?.name || prev.collateralName || null,
    hauntId: info.hauntId ?? colors?.hauntId ?? prev.hauntId ?? null,
    primary: hexNormalize(info.primary) || colors?.primary || prev.primary || null,
    secondary: hexNormalize(info.secondary) || colors?.secondary || prev.secondary || null,
    sourceTokenId: info.sourceTokenId || prev.sourceTokenId || tokenIdFromHeroId(heroId) || null,
    at: new Date().toISOString(),
  };
  all[heroId] = next;
  writeFileSync(HERO_STATE, `${JSON.stringify(all, null, 2)}\n`);
  return next;
}

function pushUnique(arr, value) {
  if (value == null || value === "") return;
  const v = String(value).trim();
  if (!v) return;
  if (!arr.some((x) => String(x).toLowerCase() === v.toLowerCase())) arr.push(v);
}

function isAddr(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || "").trim());
}

function walletHitForToken(tokenId) {
  if (!tokenId) return null;
  const id = String(tokenId);
  const idx = loadWalletGotchiIndex();
  if (idx.has(id)) return idx.get(id);
  // focus-list / roster may still have a (possibly wrong) collateral; wallet cache wins
  return null;
}

/**
 * Resolve colors for a hero record. Does not use agent status.
 */
export function resolveHeroColors(hero = {}, heroIdArg = null) {
  const heroId = heroIdArg || hero.id || null;
  const persisted = heroId ? loadHeroState(heroId) : null;
  const starter = starterSpiritFromHeroId(heroId);
  const tokenId =
    hero.sourceTokenId ||
    persisted?.sourceTokenId ||
    tokenIdFromHeroId(heroId) ||
    null;
  const walletHit = walletHitForToken(tokenId);

  const hauntHint =
    Number(hero.hauntId ?? walletHit?.hauntId ?? persisted?.hauntId ?? starter?.hauntId) ||
    (tokenId ? 2 : 1);

  const keys = [];
  // Addresses first (unique, never the sim default "dai").
  if (isAddr(hero.collateralAddress)) pushUnique(keys, hero.collateralAddress);
  if (isAddr(hero.collateral)) pushUnique(keys, hero.collateral);
  if (isAddr(hero.collateralType)) pushUnique(keys, hero.collateralType);
  if (isAddr(persisted?.collateralAddress)) pushUnique(keys, persisted.collateralAddress);
  // Wallet roster by token id (owned-22899 → amWBTC). Beats a stale "dai" on the sim hero.
  if (walletHit) {
    pushUnique(keys, walletHit.collateral);
    pushUnique(keys, walletHit.collateralName);
  }
  // Persisted spirit/name (survives switch / status)
  pushUnique(keys, persisted?.collateral);
  pushUnique(keys, persisted?.collateralName);
  // starter-<spirit>-hN
  if (starter) pushUnique(keys, starter.spirit);
  // Non-address hero.collateral last (cartridge bind-owned often defaults owned-* to "dai")
  if (hero.collateral && !isAddr(hero.collateral)) pushUnique(keys, hero.collateral);
  if (hero.collateralType && !isAddr(hero.collateralType)) pushUnique(keys, hero.collateralType);

  let colors = null;
  let usedKey = null;
  for (const k of keys) {
    const hit = findCollateralColors(k, hauntHint);
    if (hit?.primary) {
      colors = hit;
      usedKey = k;
      break;
    }
  }

  // Last-ditch: if this is an owned gotchi and we still have nothing, do not
  // invent BTC — leave null so the caller can fetch wallet data.

  if (colors && heroId) {
    persistHeroCollateral(heroId, {
      collateral: colors.spirit || usedKey,
      collateralAddress:
        (usedKey && /^0x[a-f0-9]{40}$/i.test(usedKey) ? usedKey : null) ||
        walletHit?.collateral ||
        hero.collateralAddress ||
        persisted?.collateralAddress,
      collateralName: colors.name,
      hauntId: colors.hauntId ?? hauntHint,
      primary: colors.primary,
      secondary: colors.secondary,
      sourceTokenId: tokenId,
    });
  }

  return {
    ...colors,
    usedKey,
    hauntId: colors?.hauntId ?? hauntHint,
    sourceTokenId: tokenId,
    heroId,
  };
}

export function resolveThumbCollateral(id, rosterCollateral, hauntId) {
  const starter = starterSpiritFromHeroId(id);
  const hero = {
    id,
    collateral: rosterCollateral || null,
    hauntId: hauntId || starter?.hauntId || null,
  };
  const colors = resolveHeroColors(hero, id);
  return {
    collateral: colors?.spirit || colors?.usedKey || rosterCollateral || starter?.spirit || "",
    hauntId: colors?.hauntId || hauntId || starter?.hauntId || 1,
    primary: colors?.primary || null,
    secondary: colors?.secondary || null,
    name: colors?.name || null,
  };
}

function printCli() {
  const args = process.argv.slice(2);
  const heroIdx = args.indexOf("--hero");
  const heroId = heroIdx >= 0 ? args[heroIdx + 1] : args.find((a) => !a.startsWith("--"));
  const collIdx = args.indexOf("--collateral");
  const hauntIdx = args.indexOf("--haunt");
  const hero = {
    id: heroId || null,
    collateral: collIdx >= 0 ? args[collIdx + 1] : null,
    hauntId: hauntIdx >= 0 ? Number(args[hauntIdx + 1]) || null : null,
  };
  const colors = resolveHeroColors(hero, heroId);
  if (args.includes("--json")) {
    console.log(JSON.stringify(colors, null, 2));
    return;
  }
  const spirit = colors?.spirit || colors?.usedKey || "";
  const haunt = colors?.hauntId ?? "";
  const primary = colors?.primary || "";
  const secondary = colors?.secondary || "";
  const name = colors?.name || "";
  console.log(`${spirit}\t${haunt}\t${primary}\t${secondary}\t${name}`);
}

if (isMainModule(import.meta.url)) printCli();
