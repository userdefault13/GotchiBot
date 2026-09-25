/**
 * Color step-down + gotchi-art golden fixtures — SLICE 2.
 *   node --test tests/term-color.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  rgbTo256,
  rgbTo16,
  xterm256ToRgb,
  fg,
  bg,
  downgradeAnsi,
  toAsciiGlyphs,
  ASCII_GLYPHS,
  renderMode,
} from "../scripts/lib/term-color.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artCli = path.join(root, "scripts/gotchi-art.mjs");
const fixturesDir = path.join(root, "tests/fixtures/gotchi-art-truecolor");
const cases = JSON.parse(readFileSync(path.join(fixturesDir, "cases.json"), "utf8"));

const TRUECOLOR_ENV = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TERM: "xterm-direct",
  COLORTERM: "truecolor",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
};

function runGotchiArt(argv, env = TRUECOLOR_ENV) {
  return execFileSync(process.execPath, [artCli, ...argv], {
    encoding: "buffer",
    env: { ...env },
    cwd: root,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function hasNonAsciiBesidesEscapes(s) {
  for (let i = 0; i < s.length; ) {
    if (s.charCodeAt(i) === 0x1b) {
      i++;
      if (i < s.length && s[i] === "[") {
        i++;
        while (i < s.length) {
          const c = s[i++];
          if (c >= "@" && c <= "~") break;
        }
        continue;
      }
      if (i < s.length) i++;
      continue;
    }
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    if (cp > 0x7e) return true;
  }
  return false;
}

describe("rgbTo256 / rgbTo16", () => {
  it("pure red → 196 and bright-red fg 91", () => {
    assert.equal(rgbTo256(255, 0, 0), 196);
    assert.equal(rgbTo16(255, 0, 0), 91);
  });

  it("black → cube 16 (or palette 0 → fg 30)", () => {
    assert.equal(rgbTo256(0, 0, 0), 16);
    const fg16 = rgbTo16(0, 0, 0);
    assert.ok(fg16 === 30 || fg16 === 90, `got ${fg16}`);
  });

  it("near-gray picks gray ramp", () => {
    // Mid gray closer to ramp than cube.
    const n = rgbTo256(128, 128, 128);
    assert.ok(n >= 232 && n <= 255, `expected gray ramp, got ${n}`);
  });

  it("xterm256ToRgb round-trips cube + gray", () => {
    assert.deepEqual(xterm256ToRgb(196), [255, 0, 0]);
    assert.deepEqual(xterm256ToRgb(16), [0, 0, 0]);
    const [r, g, b] = xterm256ToRgb(244);
    assert.equal(r, g);
    assert.equal(g, b);
  });

  it("38;5 → 16-color via rgb", () => {
    const [r, g, b] = xterm256ToRgb(196);
    assert.equal(rgbTo16(r, g, b), 91);
  });
});

describe("fg / bg / downgradeAnsi", () => {
  it("fg truecolor matches classic 38;2", () => {
    assert.equal(fg("ff0000", "truecolor"), "\x1b[38;2;255;0;0m");
    assert.equal(fg([255, 0, 0], "256"), "\x1b[38;5;196m");
    assert.equal(fg("ff0000", "16"), "\x1b[91m");
    assert.equal(fg("ff0000", "none"), "");
  });

  it("bg 16 maps to 40–47 / 100–107", () => {
    assert.equal(bg("ff0000", "16"), "\x1b[101m");
    assert.equal(bg("000000", "16"), "\x1b[40m");
  });

  it("downgradeAnsi truecolor is identity", () => {
    const s = "\x1b[38;2;1;2;3mhi\x1b[0m";
    assert.equal(downgradeAnsi(s, "truecolor"), s);
    assert.ok(downgradeAnsi(s, "truecolor") === s);
  });

  it("256/16/none strip 38;2", () => {
    const s = "\x1b[1;38;2;255;0;0mX\x1b[48;2;0;0;0m \x1b[0m";
    for (const mode of ["256", "16", "none"]) {
      const out = downgradeAnsi(s, mode);
      assert.equal(out.includes("38;2"), false, mode);
      assert.equal(out.includes("48;2"), false, mode);
    }
    const n256 = downgradeAnsi(s, "256");
    assert.match(n256, /38;5;196/);
    const n16 = downgradeAnsi(s, "16");
    assert.match(n16, /91/);
  });

  it("downgrades 38;5 to 16", () => {
    const out = downgradeAnsi("\x1b[38;5;196m", "16");
    assert.equal(out, "\x1b[91m");
  });
});

describe("toAsciiGlyphs", () => {
  it("every mapping is one char", () => {
    for (const [k, v] of Object.entries(ASCII_GLYPHS)) {
      assert.equal([...v].length, 1, `${k} → ${v}`);
    }
  });

  it("folds sample art; escapes untouched; no high chars left", () => {
    const sample =
      "\x1b[38;2;1;2;3m█▓▒░▀▄₿←→──\x1b[0m";
    const out = toAsciiGlyphs(sample);
    assert.ok(out.startsWith("\x1b[38;2;1;2;3m"));
    assert.ok(out.includes("#%+.\"_B<>--"));
    assert.equal(hasNonAsciiBesidesEscapes(out), false);
  });
});

describe("renderMode legacy", () => {
  it("TERM empty + no overrides → truecolor/unicode", () => {
    const m = renderMode({
      env: { PATH: "/usr/bin" },
      detectOpts: { probeTmux: false },
    });
    assert.equal(m.color, "truecolor");
    assert.equal(m.glyphs, "unicode");
    assert.equal(m.source, "legacy");
  });

  it("explicit --color-mode wins", () => {
    const m = renderMode({
      colorMode: "16",
      ascii: true,
      env: { TERM: "xterm-direct", COLORTERM: "truecolor", LANG: "en_US.UTF-8" },
      detectOpts: { probeTmux: false },
    });
    assert.equal(m.color, "16");
    assert.equal(m.glyphs, "ascii");
  });
});

describe("gotchi-art truecolor golden (byte-identical)", () => {
  for (const [name, argv] of Object.entries(cases)) {
    it(`${name} matches fixture with TERM=xterm-direct COLORTERM=truecolor`, () => {
      const expected = readFileSync(path.join(fixturesDir, `${name}.ans`));
      const actual = runGotchiArt(argv, TRUECOLOR_ENV);
      assert.deepEqual(actual, expected);
    });

    it(`${name} legacy TERM-unset matches fixture`, () => {
      const expected = readFileSync(path.join(fixturesDir, `${name}.ans`));
      const env = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: "en_US.UTF-8",
        // TERM unset, no COLORTERM / GOTCHIBOT_TUI_* / NO_COLOR
      };
      delete env.TERM;
      delete env.COLORTERM;
      delete env.GOTCHIBOT_TUI_COLOR;
      delete env.GOTCHIBOT_TUI_ASCII;
      delete env.GOTCHIBOT_TUI_PLAIN;
      delete env.NO_COLOR;
      const actual = runGotchiArt(argv, env);
      assert.deepEqual(actual, expected);
    });
  }
});

describe("gotchi-art color-mode / ascii step-down", () => {
  for (const [name, argv] of Object.entries(cases)) {
    it(`${name} --color-mode 256 has no 38;2`, () => {
      const out = runGotchiArt([...argv, "--color-mode", "256"], TRUECOLOR_ENV).toString("utf8");
      assert.equal(out.includes("38;2"), false);
    });

    it(`${name} --color-mode 16 has no 38;2`, () => {
      const out = runGotchiArt([...argv, "--color-mode", "16"], TRUECOLOR_ENV).toString("utf8");
      assert.equal(out.includes("38;2"), false);
    });

    it(`${name} --ascii --color-mode 16: no 38;2, no non-ASCII besides escapes`, () => {
      const out = runGotchiArt(
        [...argv, "--ascii", "--color-mode", "16"],
        TRUECOLOR_ENV,
      ).toString("utf8");
      assert.equal(out.includes("38;2"), false);
      assert.equal(hasNonAsciiBesidesEscapes(out), false);
    });
  }
});
