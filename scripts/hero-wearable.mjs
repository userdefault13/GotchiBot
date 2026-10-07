#!/usr/bin/env node
/**
 * A template hero's wearable, as terminal art for the avatar pane's hero box.
 *
 * Reads templates/marketplace/wearables.json at call time (the art is being
 * resized — whatever is there is what draws). Art taller or wider than the box
 * is scaled down nearest-neighbour on the character grid, keeping each cell's
 * color. No wearable → a one-line placeholder.
 *
 *   node scripts/hero-wearable.mjs art <template> [--rows N] [--width N] [--color-mode truecolor|256|16|none]
 *   node scripts/hero-wearable.mjs name <template>
 *   node scripts/hero-wearable.mjs list
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEARABLES = join(ROOT, "templates/marketplace/wearables.json");

export function loadWearables(path = WEARABLES) {
  try {
    return JSON.parse(readFileSync(path, "utf8")) || {};
  } catch {
    return {};
  }
}

/** The wearable a template hero wears: { name, ascii, markup } or null. */
export function wearableFor(templateId, wearables = loadWearables()) {
  const w = wearables?.[String(templateId || "")];
  return w && typeof w.ascii === "string" && w.ascii.trim() ? w : null;
}

const ENTITIES = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&#39;": "'" };
const unescape = (s) => s.replace(/&(lt|gt|amp|quot|#39);/g, (m) => ENTITIES[m]);

/**
 * Markup (one `<span style="color:#rrggbb">…</span>` per run) → rows of
 * cells [{ ch, color|null }]. Plain ascii when there is no markup.
 */
export function parseCells(w) {
  const src = typeof w?.markup === "string" && w.markup ? w.markup : null;
  if (!src) return String(w?.ascii || "").split("\n").map((line) => [...line].map((ch) => ({ ch, color: null })));
  return src.split("\n").map((line) => {
    const cells = [];
    const re = /<span style="color:(#[0-9a-fA-F]{6})">([\s\S]*?)<\/span>|([^<]+)/g;
    let m;
    while ((m = re.exec(line))) {
      const color = m[1] ? m[1].toLowerCase() : null;
      for (const ch of unescape(m[2] ?? m[3] ?? "")) cells.push({ ch, color });
    }
    return cells;
  });
}

/**
 * Nearest-neighbour shrink of a cell grid to fit rows × width, each axis on its
 * own (a tall staff keeps its width). Never grows. Blank edge rows are dropped.
 */
export function fitCells(grid, maxRows, maxWidth, { exact = false } = {}) {
  const blank = (r) => !r.some((c) => c.ch.trim());
  let g = grid;
  while (g.length && blank(g[0])) g = g.slice(1);
  while (g.length && blank(g[g.length - 1])) g = g.slice(0, -1);
  grid = g;
  const rows = grid.length;
  const width = Math.max(0, ...grid.map((r) => r.length));
  if (!rows || !width) return grid;
  let outR = maxRows > 0 && rows > maxRows ? maxRows : rows;
  let outW = maxWidth > 0 && width > maxWidth ? maxWidth : width;
  if (exact && maxRows > 0) {
    // Exactly maxRows tall (grow or shrink), width scaled by the same factor.
    outR = maxRows;
    outW = Math.max(1, Math.round((width * maxRows) / rows));
    if (maxWidth > 0 && outW > maxWidth) outW = maxWidth;
  }
  if (outR === rows && outW === width) return grid;
  const out = [];
  for (let r = 0; r < outR; r++) {
    const src = grid[Math.min(rows - 1, Math.floor(((r + 0.5) * rows) / outR))];
    const line = [];
    for (let c = 0; c < outW; c++) line.push(src[Math.min(width - 1, Math.floor(((c + 0.5) * width) / outW))] || { ch: " ", color: null });
    out.push(line);
  }
  return out;
}

function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function fg(hex, mode) {
  if (!hex || mode === "none") return "";
  const [r, g, b] = hexRgb(hex);
  if (mode === "256" || mode === "16") {
    const q = (v) => Math.round((v / 255) * 5);
    return `\x1b[38;5;${16 + 36 * q(r) + 6 * q(g) + q(b)}m`;
  }
  return `\x1b[38;2;${r};${g};${b}m`;
}

/** Rows of colored text, trailing blanks trimmed. Pure black ink shows as a dim grey (it vanishes on dark panes). */
export function renderCells(grid, mode = "truecolor") {
  return grid.map((row) => {
    let out = "";
    let cur = null;
    for (const { ch, color } of row) {
      const c = color === "#000000" ? "#5a5a5a" : color;
      if (mode !== "none" && ch !== " " && c !== cur) {
        out += c ? fg(c, mode) : cur ? "\x1b[0m" : "";
        cur = c;
      }
      out += ch;
    }
    out = out.replace(/\s+$/, "");
    return cur && mode !== "none" ? `${out}\x1b[0m` : out;
  });
}

export function wearableArt(templateId, { rows = 5, width = 16, colorMode = "truecolor", exact = false, wearables } = {}) {
  const w = wearableFor(templateId, wearables);
  if (!w) return [];
  return renderCells(fitCells(parseCells(w), rows, width, { exact }), colorMode);
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main() {
  const [cmd, id, ...rest] = process.argv.slice(2);
  if (cmd === "art") {
    const lines = wearableArt(id, {
      rows: Number(argValue(rest, "--rows") || 5),
      width: Number(argValue(rest, "--width") || 16),
      colorMode: argValue(rest, "--color-mode") || "truecolor",
      exact: rest.includes("--exact"),
    });
    if (lines.length) process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }
  if (cmd === "name") {
    const w = wearableFor(id);
    if (w?.name) console.log(w.name);
    return;
  }
  if (cmd === "list") {
    for (const [k, w] of Object.entries(loadWearables())) console.log(`${k}\t${w.name || ""}`);
    return;
  }
  console.error("usage: hero-wearable.mjs art <template> [--rows N] [--width N] [--exact] [--color-mode M] | name <template> | list");
  process.exit(2);
}

if (isMainModule(import.meta.url)) main();
