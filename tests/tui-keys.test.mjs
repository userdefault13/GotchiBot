/**
 * SLICE 3 — keyboard avatar paging, truecolor appends, mouse gating.
 *   node --test tests/tui-keys.test.mjs
 * Does not start tmux.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const layout = path.join(root, "scripts/orchestrator-layout.sh");
const avatar = path.join(root, "scripts/avatar-pane.sh");
const meetChannel = path.join(root, "scripts/meet-channel.mjs");
const meetPrompter = path.join(root, "scripts/meet-room-prompter.mjs");

function read(p) {
  return readFileSync(p, "utf8");
}

describe("orchestrator-layout.sh — truecolor", () => {
  it("does not use set-option -g terminal-overrides without -a/-ga", () => {
    const src = read(layout);
    const bad = src.match(
      /^\s*tmux set-option -g terminal-overrides\b/gm,
    );
    assert.equal(
      bad,
      null,
      "bare set-option -g terminal-overrides clobbers; use -ga / install_truecolor_terminal",
    );
  });

  it("appends terminal-features RGB entries (no blanket *:RGB)", () => {
    const src = read(layout);
    assert.match(src, /set-option -sa terminal-features ",\$\{pat\}:RGB"/);
    assert.match(
      src,
      /for pat in xterm-256color tmux-256color '\*-direct' xterm-kitty alacritty 'foot\*' xterm-ghostty wezterm/,
    );
    assert.doesNotMatch(src, /terminal-features ",\*:RGB"/);
    assert.doesNotMatch(src, /terminal-features ",linux:RGB"/);
  });

  it("keeps terminal-overrides Tc fallback with -ga", () => {
    const src = read(layout);
    assert.match(src, /set-option -ga terminal-overrides ",\$\{pat\}:Tc"/);
    assert.match(src, /for pat in xterm-256color tmux-256color/);
  });
});

describe("orchestrator-layout.sh — avatar page keys", () => {
  it("binds prefix N/P to avatar-pane.sh sb-wheel", () => {
    const src = read(layout);
    assert.match(src, /bind-key -T prefix P if-shell/);
    assert.match(src, /bind-key -T prefix N if-shell/);
    assert.match(
      src,
      /avatar-pane\.sh sb-wheel up[\s\S]*?avatar-pane\.sh sb-wheel down|install_avatar_page_keys/,
    );
    // The page-key helper must invoke sb-wheel without requiring pane focus.
    const fn = src.match(
      /install_avatar_page_keys\(\) \{[\s\S]*?\n\}/,
    );
    assert.ok(fn, "install_avatar_page_keys function present");
    assert.match(fn[0], /avatar-pane\.sh sb-wheel up/);
    assert.match(fn[0], /avatar-pane\.sh sb-wheel down/);
    assert.match(fn[0], /bind-key -T prefix P/);
    assert.match(fn[0], /bind-key -T prefix N/);
  });

  it("binds M-, / M-. session-scoped to sb-wheel", () => {
    const src = read(layout);
    const fn = src.match(
      /install_avatar_page_keys\(\) \{[\s\S]*?\n\}/,
    );
    assert.ok(fn);
    assert.match(fn[0], /bind-key -n M-,/);
    assert.match(fn[0], /bind-key -n M-\./);
    assert.match(fn[0], /send-keys M-,/);
    assert.match(fn[0], /send-keys M-\./);
  });

  it("gates mouse on behind TUI_MOUSE", () => {
    const src = read(layout);
    assert.match(src, /if \[ "\$\{TUI_MOUSE\}" = "on" \]/);
    assert.match(src, /gotchibot_term_caps/);
  });
});

describe("bash -n syntax", () => {
  it("orchestrator-layout.sh", () => {
    execFileSync("bash", ["-n", layout], { encoding: "utf8" });
  });

  it("avatar-pane.sh", () => {
    execFileSync("bash", ["-n", avatar], { encoding: "utf8" });
  });
});

describe("mouseEnabled gates SGR mouse enable", () => {
  it("meet-channel.mjs", () => {
    const src = read(meetChannel);
    assert.match(src, /import \{ mouseEnabled \} from "\.\/lib\/term-caps\.mjs"/);
    assert.match(src, /if \(useMouse\) output\.write\("\\x1b\[\?1000h\\x1b\[\?1006h"\)/);
    assert.match(src, /const useMouse = mouseEnabled\(\)/);
  });

  it("meet-room-prompter.mjs", () => {
    const src = read(meetPrompter);
    assert.match(src, /import \{ mouseEnabled \} from "\.\/lib\/term-caps\.mjs"/);
    assert.match(
      src,
      /if \(mouseEnabled\(\)\) stdout\.write\("\\x1b\[\?1000h\\x1b\[\?1006h"\)/,
    );
  });
});
