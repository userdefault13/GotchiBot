/**
 * Terminal capability detection — SLICE 1.
 *   node --test tests/term-caps.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  detectTermCaps,
  parseColorMode,
  COLOR_MODES,
} from "../scripts/lib/term-caps.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mjsCli = path.join(root, "scripts/lib/term-caps.mjs");
const shCli = path.join(root, "scripts/lib/term-caps.sh");

/** Minimal env for deterministic glyph/mouse defaults. */
function base(extra = {}) {
  return {
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
    ...extra,
  };
}

function lineOf(caps) {
  return `color=${caps.color} glyphs=${caps.glyphs} mouse=${caps.mouse}`;
}

function runMjs(env) {
  return execFileSync(process.execPath, [mjsCli], {
    encoding: "utf8",
    env: { ...env, PATH: process.env.PATH },
  }).trim();
}

function runBash(env) {
  return execFileSync("bash", [shCli], {
    encoding: "utf8",
    env: { ...env, PATH: process.env.PATH },
  }).trim();
}

describe("parseColorMode", () => {
  it("accepts aliases", () => {
    assert.equal(parseColorMode("24bit"), "truecolor");
    assert.equal(parseColorMode("true"), "truecolor");
    assert.equal(parseColorMode("rgb"), "truecolor");
    assert.equal(parseColorMode("256color"), "256");
    assert.equal(parseColorMode("8"), "16");
    assert.equal(parseColorMode("16color"), "16");
    assert.equal(parseColorMode("basic"), "16");
    assert.equal(parseColorMode("0"), "none");
    assert.equal(parseColorMode("off"), "none");
    assert.equal(parseColorMode("no"), "none");
  });

  it("ignores invalid", () => {
    assert.equal(parseColorMode("rainbow"), null);
    assert.equal(parseColorMode(""), null);
  });

  it("exports COLOR_MODES", () => {
    assert.deepEqual([...COLOR_MODES], ["truecolor", "256", "16", "none"]);
  });
});

describe("detectTermCaps — TERM / COLORTERM", () => {
  it("xterm-direct => truecolor", () => {
    const c = detectTermCaps(base({ TERM: "xterm-direct" }), { probeTmux: false });
    assert.equal(c.color, "truecolor");
    assert.equal(c.glyphs, "unicode");
  });

  it("xterm-256color => 256", () => {
    const c = detectTermCaps(base({ TERM: "xterm-256color" }), { probeTmux: false });
    assert.equal(c.color, "256");
  });

  it("linux => 16 + ascii + mouse off", () => {
    const c = detectTermCaps(base({ TERM: "linux" }), { probeTmux: false });
    assert.equal(c.color, "16");
    assert.equal(c.glyphs, "ascii");
    assert.equal(c.mouse, "off");
  });

  it("vt100 => 16 + ascii + mouse off", () => {
    const c = detectTermCaps(base({ TERM: "vt100" }), { probeTmux: false });
    assert.equal(c.color, "16");
    assert.equal(c.glyphs, "ascii");
    assert.equal(c.mouse, "off");
  });

  it("COLORTERM=truecolor => truecolor", () => {
    const c = detectTermCaps(
      base({ TERM: "xterm", COLORTERM: "truecolor" }),
      { probeTmux: false },
    );
    assert.equal(c.color, "truecolor");
  });

  it("NO_COLOR => none", () => {
    const c = detectTermCaps(
      base({ NO_COLOR: "1" }),
      { probeTmux: false },
    );
    assert.equal(c.color, "none");
  });
});

describe("detectTermCaps — overrides", () => {
  it("GOTCHIBOT_TUI_PLAIN=1 => 16/ascii/mouse off", () => {
    const c = detectTermCaps(
      base({ GOTCHIBOT_TUI_PLAIN: "1", TERM: "xterm-direct", COLORTERM: "truecolor" }),
      { probeTmux: false },
    );
    assert.equal(c.color, "16");
    assert.equal(c.glyphs, "ascii");
    assert.equal(c.mouse, "off");
  });

  it("GOTCHIBOT_TUI_COLOR override aliases", () => {
    assert.equal(
      detectTermCaps(base({ GOTCHIBOT_TUI_COLOR: "24bit" }), { probeTmux: false }).color,
      "truecolor",
    );
    assert.equal(
      detectTermCaps(base({ GOTCHIBOT_TUI_COLOR: "none" }), { probeTmux: false }).color,
      "none",
    );
  });

  it("PLAIN + COLOR=none => none/ascii/mouse off", () => {
    const c = detectTermCaps(
      base({ GOTCHIBOT_TUI_PLAIN: "1", GOTCHIBOT_TUI_COLOR: "none" }),
      { probeTmux: false },
    );
    assert.equal(c.color, "none");
    assert.equal(c.glyphs, "ascii");
    assert.equal(c.mouse, "off");
  });

  it("GOTCHIBOT_TUI_ASCII=1 forces ascii", () => {
    const c = detectTermCaps(
      base({ GOTCHIBOT_TUI_ASCII: "1", TERM: "xterm-256color", LANG: "en_US.UTF-8" }),
      { probeTmux: false },
    );
    assert.equal(c.glyphs, "ascii");
    assert.equal(c.color, "256");
  });

  it("GOTCHIBOT_TUI_COLOR wins over NO_COLOR", () => {
    const c = detectTermCaps(
      base({ NO_COLOR: "1", GOTCHIBOT_TUI_COLOR: "256" }),
      { probeTmux: false },
    );
    assert.equal(c.color, "256");
  });
});

describe("detectTermCaps — locale / SSH", () => {
  it("LANG=C => ascii", () => {
    const c = detectTermCaps(
      base({ LANG: "C", LC_ALL: "", LC_CTYPE: "" }),
      { probeTmux: false },
    );
    // Clear LC_* that base may not set; ensure only LANG=C
    const c2 = detectTermCaps(
      { TERM: "xterm-256color", LANG: "C" },
      { probeTmux: false },
    );
    assert.equal(c2.glyphs, "ascii");
    assert.equal(c.glyphs, "ascii");
  });

  it("LANG=en_US.ISO-8859-1 => ascii", () => {
    const c = detectTermCaps(
      { TERM: "xterm-256color", LANG: "en_US.ISO-8859-1" },
      { probeTmux: false },
    );
    assert.equal(c.glyphs, "ascii");
  });

  it("LANG=en_US.UTF-8 => unicode", () => {
    const c = detectTermCaps(
      { TERM: "xterm-256color", LANG: "en_US.UTF-8" },
      { probeTmux: false },
    );
    assert.equal(c.glyphs, "unicode");
  });

  it("SSH_TTY with xterm-256color stays 256", () => {
    const c = detectTermCaps(
      base({
        TERM: "xterm-256color",
        SSH_TTY: "/dev/pts/0",
        SSH_CONNECTION: "1.2.3.4 22 5.6.7.8 22",
      }),
      { probeTmux: false },
    );
    assert.equal(c.color, "256");
    assert.equal(c.glyphs, "unicode");
  });
});

describe("detectTermCaps — tmux probe", () => {
  it("tmux-256color + probe RGB => truecolor", () => {
    const c = detectTermCaps(
      base({ TERM: "tmux-256color", TMUX: "/tmp/tmux-1/default,1,0" }),
      { probeTmux: () => "xterm-256color|RGB" },
    );
    assert.equal(c.color, "truecolor");
  });

  it("tmux-256color + probe throw => 256", () => {
    const c = detectTermCaps(
      base({ TERM: "tmux-256color", TMUX: "/tmp/tmux-1/default,1,0" }),
      {
        probeTmux: () => {
          throw new Error("boom");
        },
      },
    );
    assert.equal(c.color, "256");
  });

  it("COLORTERM=truecolor inside tmux => truecolor", () => {
    const c = detectTermCaps(
      base({
        TERM: "tmux-256color",
        COLORTERM: "truecolor",
        TMUX: "/tmp/tmux-1/default,1,0",
      }),
      {
        probeTmux: () => {
          throw new Error("should not probe");
        },
      },
    );
    assert.equal(c.color, "truecolor");
  });

  it("probeTmux:false skips probe => 256", () => {
    const c = detectTermCaps(
      base({ TERM: "tmux-256color", TMUX: "/tmp/tmux-1/default,1,0" }),
      { probeTmux: false },
    );
    assert.equal(c.color, "256");
  });
});

describe("mjs / bash parity", () => {
  const cases = [
    { TERM: "xterm-direct", LANG: "en_US.UTF-8", GOTCHIBOT_TUI_NO_PROBE: "1" },
    { TERM: "xterm-256color", LANG: "en_US.UTF-8", GOTCHIBOT_TUI_NO_PROBE: "1" },
    { TERM: "linux", LANG: "en_US.UTF-8", GOTCHIBOT_TUI_NO_PROBE: "1" },
    { TERM: "vt100", LANG: "C", GOTCHIBOT_TUI_NO_PROBE: "1" },
    {
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
      COLORTERM: "truecolor",
      GOTCHIBOT_TUI_NO_PROBE: "1",
    },
    {
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
      NO_COLOR: "1",
      GOTCHIBOT_TUI_NO_PROBE: "1",
    },
    {
      TERM: "xterm-direct",
      LANG: "en_US.UTF-8",
      GOTCHIBOT_TUI_PLAIN: "1",
      GOTCHIBOT_TUI_NO_PROBE: "1",
    },
    {
      TERM: "tmux-256color",
      LANG: "en_US.UTF-8",
      GOTCHIBOT_TUI_NO_PROBE: "1",
    },
  ];

  for (const env of cases) {
    const label = Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    it(`parity: ${label}`, () => {
      const mjs = runMjs(env);
      const sh = runBash(env);
      assert.equal(sh, mjs, `bash=${sh} mjs=${mjs}`);
      // Sanity: matches detectTermCaps too.
      assert.equal(mjs, lineOf(detectTermCaps(env, { probeTmux: false })));
    });
  }
});
