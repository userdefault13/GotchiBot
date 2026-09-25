#!/usr/bin/env node
/**
 * Terminal capability detection for headless / SSH GotchiBot desk use.
 *
 * Pure + testable: pass an env object and options instead of reading
 * process.env in the core path.
 */
import { execFileSync } from "node:child_process";
import { isMainModule } from "../is-main.mjs";

export const COLOR_MODES = Object.freeze(["truecolor", "256", "16", "none"]);

const COLOR_ALIASES = {
  truecolor: "truecolor",
  "24bit": "truecolor",
  true: "truecolor",
  rgb: "truecolor",
  "256": "256",
  "256color": "256",
  "16": "16",
  "8": "16",
  "16color": "16",
  basic: "16",
  none: "none",
  "0": "none",
  off: "none",
  no: "none",
};

/** @type {{ color: string, glyphs: string, mouse: string, source: string } | null} */
let _memo = null;

/**
 * @param {string | undefined} raw
 * @returns {string | null}
 */
export function parseColorMode(raw) {
  if (raw == null || raw === "") return null;
  const key = String(raw).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(COLOR_ALIASES, key)
    ? COLOR_ALIASES[key]
    : null;
}

/**
 * @param {string} term
 * @returns {boolean}
 */
function isModernTruecolorTerm(term) {
  const t = term.toLowerCase();
  return (
    t === "xterm-kitty" ||
    t === "kitty" ||
    t === "foot" ||
    t === "foot-extra" ||
    t === "alacritty" ||
    t === "wezterm" ||
    t === "xterm-ghostty" ||
    t === "ghostty"
  );
}

/**
 * Apply TERM color rules (rule 4), excluding tmux/screen prefixes
 * (caller handles those).
 * @param {string} term
 * @returns {{ color: string, ascii: boolean, mouseOff: boolean, source: string }}
 */
function colorFromTermName(term) {
  const t = String(term || "").toLowerCase();
  if (!t) {
    return { color: "16", ascii: false, mouseOff: false, source: "term:empty" };
  }
  if (t === "dumb") {
    return { color: "none", ascii: true, mouseOff: true, source: "term:dumb" };
  }
  if (t === "linux" || t.startsWith("vt") || t === "cons25" || t === "ansi") {
    return { color: "16", ascii: true, mouseOff: t === "linux" || t.startsWith("vt"), source: `term:${t}` };
  }
  if (t.endsWith("-direct")) {
    return { color: "truecolor", ascii: false, mouseOff: false, source: "term:direct" };
  }
  if (t.includes("256color")) {
    return { color: "256", ascii: false, mouseOff: false, source: "term:256color" };
  }
  if (isModernTruecolorTerm(t)) {
    return { color: "truecolor", ascii: false, mouseOff: false, source: "term:modern" };
  }
  // plain xterm, *-color, rxvt*, other *color*, unknown → 16
  return { color: "16", ascii: false, mouseOff: false, source: "term:basic" };
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @returns {string}
 */
function localeString(env) {
  for (const key of ["LC_ALL", "LC_CTYPE", "LANG"]) {
    const v = env[key];
    if (v != null && String(v) !== "") return String(v);
  }
  return "";
}

/**
 * @param {string} loc
 * @returns {boolean} true if locale forces ascii glyphs
 */
function localeForcesAscii(loc) {
  if (!loc) return false;
  // C / POSIX / ISO-8859 / anything without utf-8 → ascii (rule 7).
  return !/utf-?8/i.test(loc);
}

/**
 * Default outer-tmux probe. Throws on failure (caller maps to 256).
 * @returns {string}
 */
function defaultProbeTmux() {
  return execFileSync(
    "tmux",
    ["display-message", "-p", "#{client_termname}|#{client_termfeatures}"],
    {
      encoding: "utf8",
      timeout: 300,
      stdio: ["ignore", "pipe", "ignore"],
    },
  ).trim();
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @param {{ platform?: string, probeTmux?: ((env: object) => string) | false }} [opts]
 * @returns {{ color: string, glyphs: string, mouse: string, source: string }}
 */
export function detectTermCaps(env = process.env, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const plain = String(env.GOTCHIBOT_TUI_PLAIN || "") === "1";
  const colorOverride = parseColorMode(env.GOTCHIBOT_TUI_COLOR);
  const asciiForced =
    plain || String(env.GOTCHIBOT_TUI_ASCII || "") === "1";
  const mouseForcedOff =
    plain || String(env.GOTCHIBOT_TUI_MOUSE || "") === "0";

  const term = String(env.TERM || "");
  const termLower = term.toLowerCase();
  const isTmuxOrScreen =
    termLower.startsWith("tmux") || termLower.startsWith("screen");

  /** TERM-derived flags (glyphs / mouse), always from the local TERM. */
  let termAscii = false;
  let termMouseOff = false;
  if (termLower === "dumb") {
    termAscii = true;
    termMouseOff = true;
  } else if (
    termLower === "linux" ||
    termLower.startsWith("vt") ||
    termLower === "cons25" ||
    termLower === "ansi"
  ) {
    termAscii = true;
    termMouseOff = termLower === "linux" || termLower.startsWith("vt");
  }

  let color;
  let source;

  if (colorOverride) {
    color = colorOverride;
    source = "override:GOTCHIBOT_TUI_COLOR";
  } else if (plain) {
    color = "16";
    source = "override:GOTCHIBOT_TUI_PLAIN";
  } else if (env.NO_COLOR != null && String(env.NO_COLOR) !== "") {
    color = "none";
    source = "no_color";
  } else if (
    String(env.COLORTERM || "").toLowerCase() === "truecolor" ||
    String(env.COLORTERM || "").toLowerCase() === "24bit"
  ) {
    color = "truecolor";
    source = "colorterm";
  } else if (isTmuxOrScreen) {
    // Rule 5 — outer client probe (COLORTERM already handled above).
    const noProbe =
      opts.probeTmux === false ||
      String(env.GOTCHIBOT_TUI_NO_PROBE || "") === "1";
    if (noProbe) {
      color = "256";
      source = "tmux:no_probe";
    } else if (typeof opts.probeTmux !== "function" && !env.TMUX) {
      // Rule 5: only probe the outer client when TMUX is set.
      color = "256";
      source = "tmux:no_tmux";
    } else {
      const probe =
        typeof opts.probeTmux === "function" ? opts.probeTmux : defaultProbeTmux;
      try {
        const raw = probe(env);
        const line = String(raw || "");
        const pipe = line.indexOf("|");
        const clientTerm = pipe >= 0 ? line.slice(0, pipe) : line;
        const features = pipe >= 0 ? line.slice(pipe + 1) : "";
        const ct = String(clientTerm || "").toLowerCase();
        if (!ct && !/RGB/i.test(features)) {
          // No attached client yet (detached session) — unknown, not "16".
          throw new Error("no tmux client");
        }
        if (
          /RGB/i.test(features) ||
          isModernTruecolorTerm(ct) ||
          ct.endsWith("-direct")
        ) {
          color = "truecolor";
          source = "tmux:probe";
        } else if (ct.startsWith("tmux") || ct.startsWith("screen")) {
          color = "256";
          source = "tmux:nested";
        } else {
          const fromClient = colorFromTermName(clientTerm);
          color = fromClient.color;
          source = `tmux:client:${fromClient.source}`;
          // Outer console (e.g. Linux VT) can't draw block glyphs either.
          if (fromClient.ascii) termAscii = true;
        }
      } catch {
        color = "256";
        source = "tmux:probe_failed";
      }
    }
  } else {
    const fromTerm = colorFromTermName(term);
    color = fromTerm.color;
    source = fromTerm.source;
    // Reinforce ascii/mouse from the same classification when not already set.
    if (fromTerm.ascii) termAscii = true;
    if (fromTerm.mouseOff) termMouseOff = true;
  }

  // Glyphs
  let glyphs;
  if (asciiForced || termAscii) {
    glyphs = "ascii";
  } else {
    const loc = localeString(env);
    if (loc) {
      glyphs = localeForcesAscii(loc) ? "ascii" : "unicode";
    } else {
      // No locale: darwin → unicode; other platforms → unicode unless TERM said ascii
      glyphs = "unicode";
    }
  }

  // Mouse
  const mouse =
    mouseForcedOff || termMouseOff ? "off" : "on";

  return { color, glyphs, mouse, source };
}

/**
 * Memoized detection against process.env.
 * @returns {{ color: string, glyphs: string, mouse: string, source: string }}
 */
export function termCaps() {
  if (!_memo) _memo = detectTermCaps(process.env);
  return _memo;
}

/** @returns {string} */
export function colorMode() {
  return termCaps().color;
}

/** @returns {string} */
export function glyphMode() {
  return termCaps().glyphs;
}

/** @returns {boolean} */
export function mouseEnabled() {
  return termCaps().mouse === "on";
}

/** Reset memo (tests). */
export function _resetTermCapsMemo() {
  _memo = null;
}

function main(argv = process.argv.slice(2)) {
  const caps = detectTermCaps(process.env);
  if (argv.includes("--json")) {
    process.stdout.write(
      JSON.stringify({
        color: caps.color,
        glyphs: caps.glyphs,
        mouse: caps.mouse,
      }) + "\n",
    );
    return;
  }
  if (argv.includes("--shell")) {
    process.stdout.write(
      `GOTCHIBOT_TUI_COLOR_MODE=${caps.color}; ` +
        `GOTCHIBOT_TUI_GLYPHS=${caps.glyphs}; ` +
        `GOTCHIBOT_TUI_MOUSE_MODE=${caps.mouse}\n`,
    );
    return;
  }
  process.stdout.write(
    `color=${caps.color} glyphs=${caps.glyphs} mouse=${caps.mouse}\n`,
  );
}

if (isMainModule(import.meta.url)) {
  main();
}
