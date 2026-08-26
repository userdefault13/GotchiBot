#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { call, loadMeta } from "./identity.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const COLLATERAL_TEX = {
  ameth: "▒", amweth: "░", aaave: "▓", adai: "▄", alink: "▀",
  ausdt: "∙", ausdc: ":", atusd: ";", auni: ",", ayfi: "~",
  amwbtc: "≈", amwmatic: "=",
  ghst: "*", maticx: "+", ftm: "º", bnb: "°", avax: "·",
};

const COLLATERAL_COLOR = {
  ameth: "9553FF", amweth: "9553FF", aaave: "B6509E", adai: "FF7D00",
  alink: "1E90FF", ausdt: "26A17B", ausdc: "2775CA", atusd: "E7C51E",
  auni: "FF007A", ayfi: "006AE3", amwbtc: "F7931A", amwmatic: "8247E5",
  ghst: "FA34F3", maticx: "8247E5", ftm: "13B5EC", bnb: "F3BA2F", avax: "E84142",
};

const RARITY_COLOR = {
  common: "9CA3AF", uncommon: "4CAF50", rare: "2196F3",
  legendary: "9C27B0", mythical: "FF5252",
};

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
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

const EYE_GLYPHS = [
  [41, "Θ"], [33, "δ"], [25, "@"], [17, "0"], [9, "O"], [1, "o"],
];

function eyeGlyph(shape) {
  for (const [min, glyph] of EYE_GLYPHS) {
    if (shape >= min) return glyph;
  }
  return "o";
}

function applyIdentity(art, { tex, glyph, color, useColor }) {
  const texRe = new RegExp(`${tex.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}+`, "g");
  let lines = art.split("\n").map((line) => line.replace(/▒/g, tex));

  if (useColor && color) {
    lines = lines.map((line) => line.replace(texRe, (m) => paint(m, color)));
  }

  let inEyes = false;
  let eyeRowCount = 0;
  lines = lines.map((line) => {
    if (/█████\s+█████/.test(line)) {
      eyeRowCount += 1;
      inEyes = true;
      if (eyeRowCount === 2) {
        const eye = `${glyph}${glyph}`;
        const painted = useColor && color ? paint(eye, color) : eye;
        return line.replace(/█████/g, `█${painted}█`);
      }
      return line;
    }
    if (inEyes && !/█/.test(line)) inEyes = false;
    return line;
  });

  return lines.join("\n");
}

async function heroIdentity() {
  const meta = loadMeta();
  if (!meta?.cartridgeId || !existsSync(`${ROOT}/sessions/.identity.json`)) return null;
  const r = await call(`/cartridges/${meta.cartridgeId}`);
  if (!r.ok) return null;
  const s = r.data.cartridge ?? r.data;
  const roster = s.cAavegotchis ?? [];
  const hero = roster.find((h) => h.id === meta.activeHeroId) ?? s.activeCAavegotchi ?? roster[0];
  if (!hero) return null;
  const traits = hero.modifiedTraits ?? hero.traits ?? [];
  const idCollateral = /^starter-([a-z]+)-h\d/.exec(hero.id ?? "")?.[1];
  const collateral = (hero.collateral ?? idCollateral ?? "ameth").toLowerCase();
  return {
    tex: COLLATERAL_TEX[collateral] ?? COLLATERAL_TEX[`a${collateral}`] ?? "▒",
    color: COLLATERAL_COLOR[collateral] ?? COLLATERAL_COLOR[`a${collateral}`] ?? null,
    glyph: eyeGlyph(traits[4] ?? 0),
    rarity: rarityBand(traits),
  };
}

async function main() {
  const status = process.argv.filter((a) => !a.startsWith("--"))[2] ?? "idle";
  const idleArt = readFileSync(`${ROOT}/assets/gotchi-framed.ascii`, "utf8");
  const activeArt = readFileSync(`${ROOT}/assets/gotchi-inverted.ascii`, "utf8");
  const base = status === "running" ? activeArt : idleArt;
  const useColor = colorEnabled();

  let art = base;
  try {
    const id = await heroIdentity();
    if (id) {
      art = applyIdentity(base, { ...id, useColor });
      if (useColor && id.rarity && !process.argv.includes("--no-rarity")) {
        art += `\n${paint(id.rarity.toUpperCase(), RARITY_COLOR[id.rarity])}`;
      }
    }
  } catch {}

  process.stdout.write(art);
}

main().catch(() => {
  const fallback = `${ROOT}/assets/gotchi.ascii`;
  if (existsSync(fallback)) process.stdout.write(readFileSync(fallback, "utf8"));
});
