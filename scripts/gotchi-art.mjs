#!/usr/bin/env node
/**
 * Terminal gotchi ASCII — recolored from AarcadeGh-t collateral JSON.
 *
 * Solid blocks (█ ▓ ▀ ▄ …) → collateral primaryColor
 * Lighter dots / hatch (▒ ░) → collateral secondaryColor
 *
 * Body color is collateral JSON only — never agent status (working/assigned).
 *
 * usage: node scripts/gotchi-art.mjs [--inverted] [--no-color] [--no-rarity] [idle|running]
 *        node scripts/gotchi-art.mjs --color --no-rarity --hero owned-22899
 *        node scripts/gotchi-art.mjs --thumb --collateral wbtc --haunt 2
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { call, loadMeta } from "./identity.mjs";
import {
  findCollateralColors,
  hexNormalize,
  persistHeroCollateral,
  resolveHeroColors,
  starterSpiritFromHeroId,
  tokenIdFromHeroId,
} from "./collateral-resolve.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const RARITY_COLOR = {
  common: "9CA3AF",
  uncommon: "4CAF50",
  rare: "2196F3",
  legendary: "9C27B0",
  mythical: "FF5252",
};

/** Glyphs treated as solid body (primary). */
const PRIMARY_CHARS = "█▓▀▄■▪◉●";
/** Glyphs treated as lighter fill / dots (secondary). */
const SECONDARY_CHARS = "▒░∙·˚*";

function rarityBand(traits) {
  const dist = (traits ?? [])
    .slice(0, 6)
    .reduce((sum, t) => sum + Math.abs(Math.round(Number(t) || 0) - 50), 0);
  if (dist >= 250) return "mythical";
  if (dist >= 200) return "legendary";
  if (dist >= 150) return "rare";
  if (dist >= 100) return "uncommon";
  return "common";
}

function colorEnabled() {
  if (process.argv.includes("--no-color")) return false;
  if (process.argv.includes("--color")) return true;
  if (process.env.NO_COLOR) return false;
  return Boolean(process.stdout.isTTY);
}

function paint(text, hex) {
  const h = hexNormalize(hex);
  if (!h) return text;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

function recolorAscii(art, { primary, secondary, useColor }) {
  if (!useColor || (!primary && !secondary)) return art;
  const primarySet = new Set([...PRIMARY_CHARS]);
  const secondarySet = new Set([...SECONDARY_CHARS]);

  return art
    .split("\n")
    .map((line) => {
      let out = "";
      for (const ch of line) {
        if (primary && primarySet.has(ch)) out += paint(ch, primary);
        else if (secondary && secondarySet.has(ch)) out += paint(ch, secondary);
        else out += ch;
      }
      return out;
    })
    .join("\n");
}

const EYE_GLYPHS = [
  [41, "Θ"],
  [33, "δ"],
  [25, "@"],
  [17, "0"],
  [9, "O"],
  [1, "o"],
];

function eyeGlyph(shape) {
  for (const [min, glyph] of EYE_GLYPHS) {
    if (shape >= min) return glyph;
  }
  return "o";
}

function eyeBlockFive(glyph, primary, useColor) {
  const innerStr = `${glyph}${glyph}`.padEnd(3, "·").slice(0, 3);
  const mid = useColor && primary ? paint(innerStr, primary) : innerStr;
  return `█${mid}█`;
}

function applyEyeGlyph(art, glyph, primary, useColor) {
  let eyeRowCount = 0;
  const eyeBlock = eyeBlockFive(glyph, primary, useColor);
  return art
    .split("\n")
    .map((line) => {
      if (/█████\s+█████/.test(line.replace(/\x1b\[[0-9;]*m/g, ""))) {
        eyeRowCount += 1;
        if (eyeRowCount === 2) {
          return line.replace(/█████/g, eyeBlock);
        }
      }
      return line;
    })
    .join("\n");
}

function argValue(args, flag) {
  const i = args.indexOf(flag);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith("--")) return args[i + 1];
  return null;
}

async function loadCartridgeHero(heroId) {
  const meta = loadMeta();
  if (!meta?.cartridgeId || !existsSync(`${ROOT}/sessions/.identity.json`)) return null;
  try {
    const r = await call(`/cartridges/${meta.cartridgeId}`);
    if (!r.ok) return null;
    const s = r.data.cartridge ?? r.data;
    const roster = s.cAavegotchis ?? [];
    return (
      roster.find((h) => h.id === heroId) ||
      roster.find((h) => String(h.sourceTokenId) === String(tokenIdFromHeroId(heroId) || "")) ||
      roster.find((h) => h.id === meta.activeHeroId) ||
      s.activeCAavegotchi ||
      roster[0] ||
      null
    );
  } catch {
    return null;
  }
}

async function enrichFromWallet(hero) {
  const tokenId = hero.sourceTokenId || tokenIdFromHeroId(hero.id);
  if (!tokenId) return hero;
  try {
    const { fetchWalletGotchiById, readWalletFile } = await import("./onboarding-lib.mjs");
    const w = readWalletFile();
    const address = typeof w === "string" ? w : w?.address;
    if (!address) return hero;
    const g = await fetchWalletGotchiById(address, tokenId);
    if (!g) return hero;
    return {
      ...hero,
      sourceTokenId: tokenId,
      collateral: g.collateral || hero.collateral,
      collateralAddress: g.collateral || hero.collateralAddress,
      hauntId: g.hauntId ?? hero.hauntId,
      name: g.name || hero.name,
    };
  } catch {
    return hero;
  }
}

async function heroIdentity() {
  const args = process.argv.slice(2);
  let pin = argValue(args, "--hero");
  if (!pin) {
    try {
      pin = readFileSync(`${ROOT}/sessions/.pin`, "utf8").trim();
    } catch {}
  }
  const meta = loadMeta();
  if (!pin) pin = meta?.activeHeroId || null;

  let hero = (await loadCartridgeHero(pin)) || { id: pin };
  if (pin && hero.id !== pin && tokenIdFromHeroId(pin)) {
    hero = { ...hero, id: pin, sourceTokenId: tokenIdFromHeroId(pin) };
  }
  if (!hero.id && pin) hero.id = pin;

  let colors = resolveHeroColors(hero, hero.id);
  if (!colors?.primary && tokenIdFromHeroId(hero.id)) {
    hero = await enrichFromWallet(hero);
    colors = resolveHeroColors(hero, hero.id);
  }

  const traits = hero.modifiedTraits ?? hero.traits ?? [];
  if (colors?.primary && hero.id) {
    persistHeroCollateral(hero.id, {
      collateral: colors.spirit,
      collateralAddress: hero.collateralAddress || hero.collateral,
      collateralName: colors.name,
      hauntId: colors.hauntId ?? hero.hauntId,
      primary: colors.primary,
      secondary: colors.secondary,
      sourceTokenId: hero.sourceTokenId || tokenIdFromHeroId(hero.id),
    });
  }

  return {
    id: hero.id,
    primary: colors?.primary ?? null,
    secondary: colors?.secondary ?? null,
    cheek: colors?.cheek ?? null,
    collateralName: colors?.name ?? colors?.spirit ?? null,
    glyph: eyeGlyph(Number(traits[4]) || 0),
    rarity: rarityBand(traits),
    hauntId: colors?.hauntId ?? hero.hauntId ?? 1,
    collateral: colors?.spirit ?? null,
  };
}

function colorsFromCli(args) {
  const collateralArg = argValue(args, "--collateral");
  const hauntId = Number(argValue(args, "--haunt")) || 1;
  const heroId = argValue(args, "--hero") || args.find((a) => !a.startsWith("--") && a !== "--thumb") || null;
  if (collateralArg) {
    return findCollateralColors(collateralArg, hauntId) || resolveHeroColors({ id: heroId, collateral: collateralArg, hauntId }, heroId);
  }
  if (heroId) return resolveHeroColors({ id: heroId, hauntId: hauntId || null }, heroId);
  const starter = starterSpiritFromHeroId(heroId);
  if (starter) return findCollateralColors(starter.spirit, starter.hauntId);
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const useColor = colorEnabled() || args.includes("--color") || args.includes("--thumb");

  if (args.includes("--thumb")) {
    const thumbPath = `${ROOT}/assets/gotchi-thumb.ascii`;
    const base = existsSync(thumbPath)
      ? readFileSync(thumbPath, "utf8")
      : "  ▄▄▄▄▄▄\n";
    let colors = colorsFromCli(args);
    const heroId = argValue(args, "--hero") || args.find((a) => /^owned-|starter-/i.test(a)) || null;
    if (!colors?.primary && heroId) {
      const hero = (await loadCartridgeHero(heroId)) || { id: heroId };
      colors = resolveHeroColors(hero, heroId);
      if (!colors?.primary) {
        const enriched = await enrichFromWallet({ ...hero, id: heroId });
        colors = resolveHeroColors(enriched, heroId);
      }
    }
    let art = base;
    if (colors && useColor) {
      art = recolorAscii(base, {
        primary: colors.primary,
        secondary: colors.secondary,
        useColor: true,
      });
    }
    process.stdout.write(art.endsWith("\n") ? art : `${art}\n`);
    return;
  }

  if (args.includes("--ansi-primary")) {
    const i = args.indexOf("--ansi-primary");
    const key = args[i + 1] || "";
    const hauntId = Number(argValue(args, "--haunt")) || 1;
    const colors = findCollateralColors(key, hauntId);
    const hex = colors?.primary;
    if (!hex) {
      process.stdout.write("\x1b[38;5;252m");
      return;
    }
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    process.stdout.write(`\x1b[38;2;${r};${g};${b}m`);
    return;
  }

  const idleArt = readFileSync(`${ROOT}/assets/gotchi-framed.ascii`, "utf8");
  const activeArt = readFileSync(`${ROOT}/assets/gotchi-inverted.ascii`, "utf8");
  // Sprite color is collateral JSON only — never status (working/running).
  const useInverted = process.argv.includes("--inverted");
  const base = useInverted ? activeArt : idleArt;

  let art = base;
  try {
    const id = await heroIdentity();
    if (id) {
      art = applyEyeGlyph(base, id.glyph, id.primary, useColor);
      art = recolorAscii(art, {
        primary: id.primary,
        secondary: id.secondary,
        useColor,
      });
      if (useColor && id.rarity && !process.argv.includes("--no-rarity")) {
        const label = id.collateralName
          ? `${id.rarity.toUpperCase()} · ${id.collateralName}`
          : id.rarity.toUpperCase();
        art += `\n${paint(label, RARITY_COLOR[id.rarity] || id.primary)}`;
      }
    }
  } catch {}

  process.stdout.write(art.endsWith("\n") ? art : `${art}\n`);
}

main().catch(() => {
  const fallback = `${ROOT}/assets/gotchi.ascii`;
  if (existsSync(fallback)) process.stdout.write(readFileSync(fallback, "utf8"));
});
