#!/usr/bin/env node
/**
 * Color quantizers + ANSI downgrade + ASCII glyph fold for GotchiBot TUI.
 * Pure Node — no npm deps. Uses sibling term-caps for detection in renderMode.
 */
import { detectTermCaps, parseColorMode } from "./term-caps.mjs";

/** xterm cube levels for indices 0..5 */
const CUBE_LEVELS = Object.freeze([0, 95, 135, 175, 215, 255]);

/** Standard xterm 16-color palette (indices 0–15). */
export const ANSI16_RGB = Object.freeze([
  [0, 0, 0],
  [128, 0, 0],
  [0, 128, 0],
  [128, 128, 0],
  [0, 0, 128],
  [128, 0, 128],
  [0, 128, 128],
  [192, 192, 192],
  [128, 128, 128],
  [255, 0, 0],
  [0, 255, 0],
  [255, 255, 0],
  [0, 0, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
]);

/** Index 0–15 → SGR foreground 30–37 / 90–97 */
const ANSI16_FG = Object.freeze([
  30, 31, 32, 33, 34, 35, 36, 37, 90, 91, 92, 93, 94, 95, 96, 97,
]);

/**
 * Every mapping is exactly one column wide.
 * Includes collateral forehead glyphs (₿) and cheek/eye placeholders.
 */
export const ASCII_GLYPHS = Object.freeze({
  "█": "#",
  "▓": "%",
  "▒": "+",
  "░": ".",
  "▀": '"',
  "▄": "_",
  "◉": "o",
  "●": "o",
  "₿": "B",
  "■": "#",
  "▪": "#",
  "∙": ".",
  "·": ".",
  "˚": "o",
  "Θ": "O",
  "δ": "d",
  "▐": "|",
  "▌": "|",
  "═": "=",
  "║": "|",
  "╔": "+",
  "╗": "+",
  "╚": "+",
  "╝": "+",
  "┌": "+",
  "┐": "+",
  "└": "+",
  "┘": "+",
  "├": "+",
  "┤": "+",
  "┬": "+",
  "┴": "+",
  "┼": "+",
  "─": "-",
  "│": "|",
  "╎": "|",
  "←": "<",
  "→": ">",
  "◀": "<",
  "▶": ">",
  "◂": "<",
  "▸": ">",
  "‹": "<",
  "›": ">",
  "«": "<",
  "»": ">",
  "↑": "^",
  "↓": "v",
  "…": ".",
  "–": "-",
  "—": "-",
  "×": "x",
});

/**
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {number} 0–255 xterm index
 */
export function rgbTo256(r, g, b) {
  r = clampByte(r);
  g = clampByte(g);
  b = clampByte(b);

  const ri = nearestCubeIndex(r);
  const gi = nearestCubeIndex(g);
  const bi = nearestCubeIndex(b);
  const cube = 16 + 36 * ri + 6 * gi + bi;
  const cr = CUBE_LEVELS[ri];
  const cg = CUBE_LEVELS[gi];
  const cb = CUBE_LEVELS[bi];
  const cubeDist = dist2(r, g, b, cr, cg, cb);

  // Gray ramp 232–255: value = 8 + 10 * (n - 232)
  const grayLevel = Math.round((r + g + b) / 3);
  let grayIdx = Math.round((grayLevel - 8) / 10);
  if (grayIdx < 0) grayIdx = 0;
  if (grayIdx > 23) grayIdx = 23;
  const gray = 232 + grayIdx;
  const gv = 8 + grayIdx * 10;
  const grayDist = dist2(r, g, b, gv, gv, gv);

  return grayDist < cubeDist ? gray : cube;
}

/**
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {number} SGR foreground 30–37 / 90–97
 */
export function rgbTo16(r, g, b) {
  r = clampByte(r);
  g = clampByte(g);
  b = clampByte(b);
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < 16; i++) {
    const [pr, pg, pb] = ANSI16_RGB[i];
    const d = dist2(r, g, b, pr, pg, pb);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return ANSI16_FG[best];
}

/**
 * @param {number} n xterm-256 index
 * @returns {[number, number, number]}
 */
export function xterm256ToRgb(n) {
  n = Number(n);
  if (!Number.isFinite(n)) n = 0;
  n = Math.max(0, Math.min(255, n | 0));
  if (n < 16) {
    const rgb = ANSI16_RGB[n];
    return [rgb[0], rgb[1], rgb[2]];
  }
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return [v, v, v];
  }
  const i = n - 16;
  const ri = Math.floor(i / 36);
  const gi = Math.floor((i % 36) / 6);
  const bi = i % 6;
  return [CUBE_LEVELS[ri], CUBE_LEVELS[gi], CUBE_LEVELS[bi]];
}

/**
 * @param {string | number[] | { r: number, g: number, b: number }} hexOrRgb
 * @param {string} mode truecolor|256|16|none
 * @returns {string} SGR sequence or ""
 */
export function fg(hexOrRgb, mode) {
  if (mode === "none") return "";
  const rgb = parseRgb(hexOrRgb);
  if (!rgb) return "";
  const [r, g, b] = rgb;
  if (mode === "truecolor") return `\x1b[38;2;${r};${g};${b}m`;
  if (mode === "256") return `\x1b[38;5;${rgbTo256(r, g, b)}m`;
  if (mode === "16") return `\x1b[${rgbTo16(r, g, b)}m`;
  return "";
}

/**
 * @param {string | number[] | { r: number, g: number, b: number }} hexOrRgb
 * @param {string} mode
 * @returns {string}
 */
export function bg(hexOrRgb, mode) {
  if (mode === "none") return "";
  const rgb = parseRgb(hexOrRgb);
  if (!rgb) return "";
  const [r, g, b] = rgb;
  if (mode === "truecolor") return `\x1b[48;2;${r};${g};${b}m`;
  if (mode === "256") return `\x1b[48;5;${rgbTo256(r, g, b)}m`;
  if (mode === "16") {
    const f = rgbTo16(r, g, b);
    const bgCode = f >= 90 ? f + 10 : f + 10; // 30→40, 90→100
    return `\x1b[${bgCode}m`;
  }
  return "";
}

/**
 * Rewrite color SGRs in a string to the target mode.
 * truecolor: returns the same string (identity).
 * @param {string} str
 * @param {string} mode
 * @returns {string}
 */
export function downgradeAnsi(str, mode) {
  if (mode === "truecolor") return str;
  const s = String(str ?? "");
  return s.replace(/\x1b\[([0-9;]*)m/g, (full, body) => {
    if (body === "") return mode === "none" ? "" : full;
    const params = body.split(";").filter((p) => p !== "");
    if (!params.length) return mode === "none" ? "\x1b[0m" : full;
    const out = rewriteSgrParams(params, mode);
    if (out === null) return ""; // stripped entirely
    if (!out.length) return "\x1b[0m";
    return `\x1b[${out.join(";")}m`;
  });
}

/**
 * @param {string} str
 * @returns {string}
 */
export function toAsciiGlyphs(str) {
  const s = String(str ?? "");
  let out = "";
  for (let i = 0; i < s.length; ) {
    if (s.charCodeAt(i) === 0x1b) {
      // Pass escape sequences through untouched (CSI / OSC / simple).
      out += s[i++];
      if (i >= s.length) break;
      const next = s[i];
      if (next === "[") {
        out += s[i++];
        while (i < s.length) {
          const c = s[i];
          out += c;
          i++;
          if (c >= "@" && c <= "~") break;
        }
        continue;
      }
      if (next === "]") {
        out += s[i++];
        while (i < s.length) {
          const c = s[i];
          out += c;
          i++;
          if (c === "\x07") break;
          if (c === "\x1b" && s[i] === "\\") {
            out += s[i++];
            break;
          }
        }
        continue;
      }
      // Other ESC-letter forms: take one more char if present.
      out += s[i++];
      continue;
    }
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    out += Object.prototype.hasOwnProperty.call(ASCII_GLYPHS, ch)
      ? ASCII_GLYPHS[ch]
      : ch;
  }
  return out;
}

/**
 * Resolve { color, glyphs } from explicit opts/CLI, then term-caps.
 * Legacy: no explicit flags + no GOTCHIBOT_TUI_* / NO_COLOR / COLORTERM +
 * TERM empty/unset → truecolor + unicode (background services, launchd, tests).
 *
 * @param {{
 *   color?: string,
 *   colorMode?: string,
 *   glyphs?: string,
 *   ascii?: boolean,
 *   noColor?: boolean,
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   detectOpts?: object,
 * }} [opts]
 * @returns {{ color: string, glyphs: string, source: string }}
 */
export function renderMode(opts = {}) {
  const env = opts.env ?? process.env;

  let color = null;
  let glyphs = null;
  let source = "explicit";

  const rawColor = opts.color ?? opts.colorMode;
  if (rawColor != null && String(rawColor) !== "") {
    color = parseColorMode(rawColor) || String(rawColor).trim().toLowerCase();
  }
  if (opts.noColor) color = "none";

  if (opts.ascii === true) glyphs = "ascii";
  if (opts.glyphs === "ascii" || opts.glyphs === "unicode") glyphs = opts.glyphs;

  const hasEnvOverride =
    (env.GOTCHIBOT_TUI_COLOR != null && String(env.GOTCHIBOT_TUI_COLOR) !== "") ||
    String(env.GOTCHIBOT_TUI_PLAIN || "") === "1" ||
    String(env.GOTCHIBOT_TUI_ASCII || "") === "1" ||
    (env.NO_COLOR != null && String(env.NO_COLOR) !== "") ||
    (env.COLORTERM != null && String(env.COLORTERM) !== "");

  const termEmpty = env.TERM == null || String(env.TERM) === "";

  if (color == null && glyphs == null && !hasEnvOverride && termEmpty) {
    return { color: "truecolor", glyphs: "unicode", source: "legacy" };
  }

  // Probe the outer tmux client (300ms cap) so a truecolor desk stays
  // truecolor inside tmux; GOTCHIBOT_TUI_NO_PROBE=1 or detectOpts skip it.
  const caps = detectTermCaps(env, opts.detectOpts ?? {});
  if (color == null) {
    color = caps.color;
    source = caps.source;
  }
  if (glyphs == null) {
    glyphs = caps.glyphs;
    if (source === "explicit") source = caps.source;
  }
  return { color, glyphs, source };
}

// --- internals ---

function clampByte(n) {
  n = Number(n);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 255) return 255;
  return n | 0;
}

function dist2(r, g, b, pr, pg, pb) {
  const dr = r - pr;
  const dg = g - pg;
  const db = b - pb;
  return dr * dr + dg * dg + db * db;
}

function nearestCubeIndex(v) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < 6; i++) {
    const d = Math.abs(v - CUBE_LEVELS[i]);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/**
 * @param {string | number[] | { r?: number, g?: number, b?: number }} hexOrRgb
 * @returns {[number, number, number] | null}
 */
function parseRgb(hexOrRgb) {
  if (hexOrRgb == null) return null;
  if (Array.isArray(hexOrRgb) && hexOrRgb.length >= 3) {
    return [clampByte(hexOrRgb[0]), clampByte(hexOrRgb[1]), clampByte(hexOrRgb[2])];
  }
  if (typeof hexOrRgb === "object") {
    if (
      Number.isFinite(hexOrRgb.r) &&
      Number.isFinite(hexOrRgb.g) &&
      Number.isFinite(hexOrRgb.b)
    ) {
      return [clampByte(hexOrRgb.r), clampByte(hexOrRgb.g), clampByte(hexOrRgb.b)];
    }
    return null;
  }
  let h = String(hexOrRgb).trim().replace(/^0x/i, "").replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function isBasicColorSgr(p) {
  return (
    (p >= 30 && p <= 37) ||
    (p >= 40 && p <= 47) ||
    (p >= 90 && p <= 97) ||
    (p >= 100 && p <= 107)
  );
}

/**
 * @param {string[]} params
 * @param {string} mode
 * @returns {string[] | null} null = drop the whole sequence
 */
function rewriteSgrParams(params, mode) {
  const out = [];
  let keptAny = false;
  let onlyReset = true;

  for (let i = 0; i < params.length; i++) {
    const p = Number(params[i]);
    if (!Number.isFinite(p)) {
      out.push(params[i]);
      keptAny = true;
      onlyReset = false;
      continue;
    }

    if (p === 38 || p === 48) {
      const isFg = p === 38;
      const next = Number(params[i + 1]);
      if (next === 2 && i + 4 < params.length) {
        const r = Number(params[i + 2]);
        const g = Number(params[i + 3]);
        const b = Number(params[i + 4]);
        i += 4;
        if (mode === "none") continue;
        onlyReset = false;
        keptAny = true;
        if (mode === "256") {
          out.push(String(p), "5", String(rgbTo256(r, g, b)));
        } else if (mode === "16") {
          const code = isFg ? rgbTo16(r, g, b) : rgbTo16(r, g, b) + 10;
          out.push(String(code));
        }
        continue;
      }
      if (next === 5 && i + 2 < params.length) {
        const n = Number(params[i + 2]);
        i += 2;
        if (mode === "none") continue;
        onlyReset = false;
        keptAny = true;
        if (mode === "256") {
          out.push(String(p), "5", String(n));
        } else if (mode === "16") {
          const [r, g, b] = xterm256ToRgb(n);
          const code = isFg ? rgbTo16(r, g, b) : rgbTo16(r, g, b) + 10;
          out.push(String(code));
        }
        continue;
      }
      // Malformed 38/48 — drop the color opener in none; keep otherwise.
      if (mode === "none") continue;
      out.push(params[i]);
      keptAny = true;
      onlyReset = false;
      continue;
    }

    if (mode === "none" && isBasicColorSgr(p)) continue;

    if (p !== 0) onlyReset = false;
    out.push(String(p));
    keptAny = true;
  }

  if (!keptAny) return null;
  if (mode === "none" && onlyReset) return ["0"];
  return out;
}
