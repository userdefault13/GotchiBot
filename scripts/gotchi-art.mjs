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

const EYE_GLYPHS = [
  [41, "Θ"], [33, "δ"], [25, "@"], [17, "0"], [9, "O"], [1, "o"],
];

function eyeGlyph(shape) {
  for (const [min, glyph] of EYE_GLYPHS) {
    if (shape >= min) return glyph;
  }
  return "o";
}

function eyeDigit(color) {
  return String((Math.round(color) % 9) + 1);
}

function applyIdentity(art, { tex, glyph, digit }) {
  let lines = art.split("\n");
  lines = lines.map((line) => line.replace(/▒/g, tex));

  let inEyes = false;
  let eyeRowCount = 0;
  lines = lines.map((line) => {
    if (/█████\s+█████/.test(line)) {
      eyeRowCount += 1;
      inEyes = true;
      if (eyeRowCount === 2) {
        return line.replace(/█████/g, `█${glyph}${digit}${glyph}█`);
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
    glyph: eyeGlyph(traits[4] ?? 0),
    digit: eyeDigit(traits[5] ?? 0),
  };
}

async function main() {
  const status = process.argv[2] ?? "idle";
  const idleArt = readFileSync(`${ROOT}/assets/gotchi-framed.ascii`, "utf8");
  const activeArt = readFileSync(`${ROOT}/assets/gotchi-inverted.ascii`, "utf8");
  const base = status === "running" ? activeArt : idleArt;

  let art = base;
  try {
    const id = await heroIdentity();
    if (id) art = applyIdentity(base, id);
  } catch {}

  process.stdout.write(art);
}

main().catch(() => {
  const fallback = `${ROOT}/assets/gotchi.ascii`;
  if (existsSync(fallback)) process.stdout.write(readFileSync(fallback, "utf8"));
});
