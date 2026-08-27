#!/usr/bin/env node
/**
 * Terminal gotchi ASCII — recolored from AarcadeGh-t collateral JSON.
 *
 * Solid blocks (█ ▓ ▀ ▄ …) → collateral primaryColor
 * Lighter dots / hatch (▒ ░) → collateral secondaryColor
 *
 * usage: node scripts/gotchi-art.mjs [--inverted] [--no-color] [--no-rarity] [idle|running]
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { call, loadMeta } from "./identity.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COLORS_PATH = `${ROOT}/assets/collateral-colors.json`;
const AARCADE_COLORS = resolve(ROOT, "../AarcadeGh-t/public/data/aavegotchi_db_collaterals.json");

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

function hexNormalize(raw) {
  if (!raw) return null;
  let h = String(raw).trim().replace(/^0x/i, "").replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return h.toLowerCase();
}

function paint(text, hex) {
  const h = hexNormalize(hex);
  if (!h) return text;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

function loadCollateralTable() {
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
      if (list.length) return list;
    } catch {}
  }
  return [];
}

function spiritKey(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/^ma?/, "")
    .replace(/^a/, "")
    .replace(/[^a-z0-9]/g, "");
}

function findCollateralColors(collateralTypeOrName, hauntId = 1) {
  const list = loadCollateralTable();
  const key = String(collateralTypeOrName || "").trim().toLowerCase();
  if (!key || !list.length) return null;

  const byAddr = list.find((c) => String(c.collateralType || "").toLowerCase() === key);
  if (byAddr) {
    return {
      name: byAddr.name,
      primary: hexNormalize(byAddr.primaryColor),
      secondary: hexNormalize(byAddr.secondaryColor),
      cheek: hexNormalize(byAddr.cheekColor),
    };
  }

  const byName = list.find((c) => String(c.name || "").toLowerCase() === key);
  if (byName) {
    return {
      name: byName.name,
      primary: hexNormalize(byName.primaryColor),
      secondary: hexNormalize(byName.secondaryColor),
      cheek: hexNormalize(byName.cheekColor),
    };
  }

  const spirit = spiritKey(key);
  const haunt = Number(hauntId) || 1;
  const bySpirit =
    list.find((c) => spiritKey(c.name) === spirit && Number(c.haunt) === haunt) ||
    list.find((c) => spiritKey(c.name) === spirit);
  if (bySpirit) {
    return {
      name: bySpirit.name,
      primary: hexNormalize(bySpirit.primaryColor),
      secondary: hexNormalize(bySpirit.secondaryColor),
      cheek: hexNormalize(bySpirit.cheekColor),
    };
  }
  return null;
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
      // Match eye blocks before ANSI coloring; operate on raw art only.
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

async function heroIdentity() {
  const meta = loadMeta();
  if (!meta?.cartridgeId || !existsSync(`${ROOT}/sessions/.identity.json`)) return null;
  const r = await call(`/cartridges/${meta.cartridgeId}`);
  if (!r.ok) return null;
  const s = r.data.cartridge ?? r.data;
  const roster = s.cAavegotchis ?? [];
  let pin = null;
  try {
    pin = readFileSync(`${ROOT}/sessions/.pin`, "utf8").trim();
  } catch {}
  const hero =
    roster.find((h) => h.id === pin) ||
    roster.find((h) => h.id === meta.activeHeroId) ||
    s.activeCAavegotchi ||
    roster[0];
  if (!hero) return null;

  const traits = hero.modifiedTraits ?? hero.traits ?? [];
  const collateralAddr = hero.collateralAddress || hero.collateral || null;
  const idCollateral = /^starter-([a-z0-9]+)-h\d/i.exec(hero.id ?? "")?.[1];
  const colors =
    findCollateralColors(collateralAddr, hero.hauntId) ||
    findCollateralColors(idCollateral, hero.hauntId) ||
    findCollateralColors(hero.collateral, hero.hauntId);

  return {
    primary: colors?.primary ?? null,
    secondary: colors?.secondary ?? null,
    cheek: colors?.cheek ?? null,
    collateralName: colors?.name ?? idCollateral ?? null,
    glyph: eyeGlyph(Number(traits[4]) || 0),
    rarity: rarityBand(traits),
    hauntId: hero.hauntId ?? 1,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const status = args.filter((a) => !a.startsWith("--"))[0] ?? "idle";
  const useColor = colorEnabled() || args.includes("--color") || args.includes("--thumb");

  // Thumbnail mode: recolor assets/gotchi-thumb.ascii from AarcadeGh-t collateral JSON
  //   node scripts/gotchi-art.mjs --thumb --collateral link
  //   node scripts/gotchi-art.mjs --thumb starter-link-h1-1
  if (args.includes("--thumb")) {
    const thumbPath = `${ROOT}/assets/gotchi-thumb.ascii`;
    const base = existsSync(thumbPath)
      ? readFileSync(thumbPath, "utf8")
      : "  ▄▄▄▄▄▄\n";
    const collIdx = args.indexOf("--collateral");
    let collateralArg =
      collIdx >= 0 ? args[collIdx + 1] : null;
    if (!collateralArg) {
      const pos = args.find((a) => !a.startsWith("--") && a !== "--thumb");
      collateralArg = pos || null;
      if (collateralArg && /^starter-([a-z0-9]+)-/i.test(collateralArg)) {
        collateralArg = RegExp.$1;
      }
    }
    const hauntIdx = args.indexOf("--haunt");
    const hauntId = hauntIdx >= 0 ? Number(args[hauntIdx + 1]) || 1 : 1;
    const colors =
      findCollateralColors(collateralArg, hauntId) ||
      findCollateralColors(String(collateralArg || "").replace(/^0x/i, ""), hauntId);
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

  // ANSI primary only (for shells): node scripts/gotchi-art.mjs --ansi-primary link
  if (args.includes("--ansi-primary")) {
    const i = args.indexOf("--ansi-primary");
    const key = args[i + 1] || "";
    const colors = findCollateralColors(key, 1);
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
  const useInverted =
    process.argv.includes("--inverted") ||
    (status === "running" && !process.argv.includes("--framed"));
  const base = useInverted ? activeArt : idleArt;

  let art = base;
  try {
    const id = await heroIdentity();
    if (id) {
      // Eyes on raw art first, then recolor solids / dots.
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
