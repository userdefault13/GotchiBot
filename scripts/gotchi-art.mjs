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
 *        node scripts/gotchi-art.mjs --kanban --hero starter-dai-h1-1 --color
 *        node scripts/gotchi-art.mjs --roster --hero owned-954 --color
 *        node scripts/gotchi-art.mjs --roster --color --collateral wbtc
 *   --thumb / --kanban = large thumb, plain recolor, regular ▄▄/▀▀ eyes (iMessage + kanban)
 *   --roster           = same art + doubled forehead collateral, eyes left alone (sub-agents)
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";
import { call, loadMeta } from "./identity.mjs";
import {
  collateralCharacter,
  findCollateralColors,
  hexNormalize,
  persistHeroCollateral,
  resolveHeroColors,
  starterSpiritFromHeroId,
  tokenIdFromHeroId,
} from "./collateral-resolve.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Large thumb tombstone shared by iMessage, kanban seats, and avatar roster. */
const THUMB_ASCII = `${ROOT}/assets/gotchi-thumb.ascii`;
const THUMB_FALLBACK =
  "  ▄▀▀▀▀▀▀▄  \n▄▀   ░░   ▀▄\n█  ▄▄  ▄▄ ░█\n█  ▀▀  ▀▀ ░█\n█   ▀▄▄▀  ░█\n█ ▄      ▄░█\n█  ▀▄  ▄▀ ░█\n█ ▀▀    ▀▀░█\n█▄▄▀▀▄▄▀▀▄▄█";
/** @deprecated alias — mini seat file no longer used for kanban/roster */
const KANBAN_ASCII = THUMB_ASCII;
const KANBAN_ASCII_FALLBACK = THUMB_FALLBACK;

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

export function paint(text, hex) {
  const h = hexNormalize(hex);
  if (!h) return text;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

export function recolorAscii(art, { primary, secondary, useColor, markHex = null, markChars = "" }) {
  if (!useColor || (!primary && !secondary && !markHex)) return art;
  const primarySet = new Set([...PRIMARY_CHARS]);
  const secondarySet = new Set([...SECONDARY_CHARS]);
  const markSet = new Set([...(markChars || "")]);

  return art
    .split("\n")
    .map((line) => {
      let out = "";
      for (const ch of line) {
        if (markHex && markSet.has(ch)) out += paint(ch, markHex);
        else if (primary && primarySet.has(ch)) out += paint(ch, primary);
        else if (secondary && secondarySet.has(ch)) out += paint(ch, secondary);
        else out += ch;
      }
      return out;
    })
    .join("\n");
}

/** Replace forehead collateral slot: `#` (legacy single) or `▀▄` (doubled for symmetry). */
export function applyCollateralChar(art, character) {
  const ch = [...String(character || "?")][0] || "?";
  let out = art;
  if (out.includes("▀▄")) out = out.replaceAll("▀▄", `${ch}${ch}`);
  return out.replaceAll("#", ch);
}

/**
 * iMessage + kanban seat thumb: large tombstone, collateral recolor only.
 * Regular ▄▄ / ▀▀ eyes — no trait digits, no forehead spirit.
 * Extra opts (eyeColor/eyeShape) are ignored so older callers stay safe.
 */
export function renderThumbAscii(colors = null, { useColor = true } = {}) {
  const base = existsSync(THUMB_ASCII)
    ? readFileSync(THUMB_ASCII, "utf8").replace(/\s+$/, "")
    : THUMB_FALLBACK;
  if (useColor && (colors?.primary || colors?.secondary)) {
    return recolorAscii(base, {
      primary: colors.primary,
      secondary: colors.secondary,
      useColor: true,
    });
  }
  return base;
}

/** Alias — kanban seats / pstack grid share the plain iMessage thumb. */
export function renderKanbanAscii(colors = null, opts = {}) {
  return renderThumbAscii(colors, opts);
}

/**
 * Avatar "other cAavegotchis" / sub-agent roster tile: same tombstone as
 * iMessage, regular ▄▄/▀▀ eyes (left alone), doubled forehead collateral
 * for symmetry (░░ → UU / ₿₿ / …).
 */
export function renderRosterAscii(colors = null, { useColor = true } = {}) {
  const base = existsSync(THUMB_ASCII)
    ? readFileSync(THUMB_ASCII, "utf8").replace(/\s+$/, "")
    : THUMB_FALLBACK;
  const spirit = colors?.spirit || colors?.usedKey || colors?.name || "";
  const character =
    colors?.character ||
    collateralCharacter(spirit || colors?.label || "?", colors);
  const pair = (() => {
    const ch = [...String(character || "?")][0] || "?";
    return `${ch}${ch}`;
  })();
  let art = applyThumbCollateral(base, character);
  if (useColor && (colors?.primary || colors?.secondary)) {
    art = recolorAscii(art, {
      primary: colors.primary,
      secondary: colors.secondary,
      useColor: true,
      markHex: colors.primary || colors.cheek || colors.secondary,
      markChars: pair,
    });
  }
  return art;
}

/**
 * Forehead slot on the large thumb: `░░` → doubled collateral glyph for symmetry.
 *   ▄▀   ░░   ▀▄  →  ▄▀   UU   ▀▄  (or ₿₿, …). Width stays 12.
 */
export function applyThumbCollateral(art, character) {
  const ch = [...String(character || "?")][0] || "?";
  const pair = `${ch}${ch}`;
  return art
    .split("\n")
    .map((line) => {
      if (!line.includes("░░")) return line;
      return line.replace("░░", pair);
    })
    .join("\n");
}

/** Clamp a 0–99 trait value; non-finite → fallback (50). */
function clampTrait(v, fallback = 50) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(99, Math.round(n)));
}

/** 2-digit zero-padded eye color trait (00–99). */
function eyeColorGlyph(color) {
  return String(clampTrait(color)).padStart(2, "0");
}

/** 2-digit zero-padded eye shape vault value (00–99). */
function eyeShapeGlyph(shape) {
  return String(clampTrait(shape)).padStart(2, "0");
}

/** Replace the eye slot on the kanban face row with left (color) + right (shape vault). */
function applyKanbanEyes(art, leftEye, rightEye) {
  const pair = `${leftEye}${rightEye}`; // 4 chars: e.g. 5541
  return art
    .split("\n")
    .map((line) => {
      // Large thumb lower eye row: █  ▀▀  ▀▀ ░█ → █  22  88 ░█
      // (exact 2-space spacing so the chin row █ ▀▀    ▀▀░█ is untouched;
      //  upper ▄▄ row stays as lids — digits on the lower row keep width 12)
      if (/^█ {2}▀▀ {2}▀▀/.test(line)) {
        let n = 0;
        return line.replace(/▀▀/g, () => (n++ === 0 ? leftEye : rightEye));
      }
      // Legacy 9-wide mini face rows (█-anchored so the thumb crown
      // "  ▄▀▀▀▀▀▀▄  " can never match): █  ▀▀▀  █ or █  ▀▀▀▀ █ → █  5541 █
      if (line.startsWith("█") && line.includes("▀▀▀▀")) return line.replace("▀▀▀▀", pair);
      if (line.startsWith("█") && line.includes("▀▀▀")) {
        // expand 3-slot to 4-char pair; keep width if line has room
        return line.replace("▀▀▀", pair).replace(/^█  /, "█ ").replace(/  █$/, " █");
      }
      // legacy 7-wide face row: █ ▀ ▀ █
      if (/█\s*▀\s*▀\s*█/.test(line)) {
        return line.replace("▀", leftEye).replace("▀", rightEye);
      }
      return line;
    })
    .join("\n");
}

export const EYE_GLYPHS = [
  [41, "Θ"],
  [33, "δ"],
  [25, "@"],
  [17, "0"],
  [9, "O"],
  [1, "o"],
];

export function eyeGlyph(shape) {
  for (const [min, glyph] of EYE_GLYPHS) {
    if (shape >= min) return glyph;
  }
  return "o";
}

/** Inner 3 chars for a legacy framed-art eye slot (█████ → █xxx█). */
function eyeInnerThree(content) {
  return String(content || "").padEnd(3, "·").slice(0, 3);
}

function eyeBlockFive(innerContent, primary, useColor) {
  const innerStr = eyeInnerThree(innerContent);
  const mid = useColor && primary ? paint(innerStr, primary) : innerStr;
  return `█${mid}█`;
}

/**
 * Framed idle/inverted art (ascii-art 2): eyes stay solid ██████.
 * Left cheek ░░ = eyeShape (00–99), right cheek ░░ = eyeColor (00–99).
 * Uses private placeholders so later digit paint cannot match CSI bytes (e.g. 55 in 255).
 */
const CHEEK_PH_L = "‹‹";
const CHEEK_PH_R = "››";

function applyCheekGlyphs(art, { eyeColor = 50, eyeShape = 50, primary = null, useColor = true } = {}) {
  // Placeholders keep width 2; real digits applied in paintFramedCheekDigits.
  void eyeColor;
  void eyeShape;
  void primary;
  void useColor;
  return art
    .split("\n")
    .map((line) => {
      const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
      const slots = plain.match(/░░/g);
      if (!slots || slots.length < 2) return line;
      let n = 0;
      return line.replace(/░░/g, () => {
        n += 1;
        return n === 1 ? CHEEK_PH_L : CHEEK_PH_R;
      });
    })
    .join("\n");
}

/** Swap cheek placeholders for painted eyeShape / eyeColor digit pairs. */
function paintFramedCheekDigits(art, leftCheek, rightCheek, primary, useColor) {
  const L = useColor && primary ? paint(leftCheek, primary) : leftCheek;
  const R = useColor && primary ? paint(rightCheek, primary) : rightCheek;
  return art.replaceAll(CHEEK_PH_L, L).replaceAll(CHEEK_PH_R, R);
}

/** @deprecated eyes no longer carry traits — cheeks do. Kept as cheek alias. */
function applyEyeGlyphs(art, opts) {
  return applyCheekGlyphs(art, opts);
}

/** @deprecated kept for any external callers that pass a single shape glyph */
function applyEyeGlyph(art, glyph, primary, useColor) {
  const shapeMin = EYE_GLYPHS.find(([, g]) => g === glyph)?.[0] ?? 41;
  return applyCheekGlyphs(art, { eyeColor: 50, eyeShape: shapeMin, primary, useColor });
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

  const eyeShape = Number(traits[4]);
  const eyeColor = Number(traits[5]);
  return {
    id: hero.id,
    primary: colors?.primary ?? null,
    secondary: colors?.secondary ?? null,
    cheek: colors?.cheek ?? null,
    collateralName: colors?.name ?? colors?.spirit ?? null,
    glyph: eyeGlyph(Number.isFinite(eyeShape) ? eyeShape : 50),
    eyeShape: Number.isFinite(eyeShape) ? eyeShape : 50,
    eyeColor: Number.isFinite(eyeColor) ? eyeColor : 50,
    rarity: rarityBand(traits),
    hauntId: colors?.hauntId ?? hero.hauntId ?? 1,
    collateral: colors?.spirit ?? null,
    character: colors?.character || collateralCharacter(colors?.spirit || colors?.name || "?", colors),
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
  const useColor =
    colorEnabled() ||
    args.includes("--color") ||
    args.includes("--thumb") ||
    args.includes("--kanban") ||
    args.includes("--roster");

  if (args.includes("--thumb") || args.includes("--kanban") || args.includes("--roster")) {
    // --thumb / --kanban = plain recolor (iMessage + kanban seats)
    // --roster = doubled forehead collateral, eyes left alone (avatar sub-agents)
    const isRoster = args.includes("--roster");
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
    const art = isRoster
      ? renderRosterAscii(colors, { useColor })
      : renderThumbAscii(colors, { useColor });
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

  // Large framed avatar: doubled forehead collateral + cheek trait numbers
  // (left cheek = eyeShape 00–99, right cheek = eyeColor 00–99). Eyes stay solid.
  let art = base;
  try {
    const id = await heroIdentity();
    if (id) {
      const ch = id.character || collateralCharacter(id.collateral || id.collateralName || "?", id);
      const eyeColorArg = argValue(args, "--eye-color");
      const eyeShapeArg = argValue(args, "--eye-shape");
      const eyeColor = eyeColorArg != null ? Number(eyeColorArg) : id.eyeColor;
      const eyeShape = eyeShapeArg != null ? Number(eyeShapeArg) : id.eyeShape;
      art = applyCollateralChar(base, ch);
      const pair = `${ch}${ch}`;
      const leftCheek = eyeShapeGlyph(eyeShape);
      const rightCheek = eyeColorGlyph(eyeColor);
      // Cheek ░░ → placeholders before recolor (secondary ░ paint would hide slots).
      art = applyCheekGlyphs(art, { eyeColor, eyeShape });
      art = recolorAscii(art, {
        primary: id.primary,
        secondary: id.secondary,
        useColor,
        markHex: id.primary || id.cheek || id.secondary,
        markChars: pair,
      });
      art = paintFramedCheekDigits(art, leftCheek, rightCheek, id.primary, useColor);
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

if (isMainModule(import.meta.url)) {
  main().catch(() => {
    const fallback = `${ROOT}/assets/gotchi.ascii`;
    if (existsSync(fallback)) process.stdout.write(readFileSync(fallback, "utf8"));
  });
}
