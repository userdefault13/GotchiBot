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

  it("turns tmux mouse off and does not bind the wheel", () => {
    const src = read(layout);
    assert.match(src, /gotchibot_term_caps/);
    assert.match(src, /tmux set-option -t "\$sess" mouse off/);
    assert.doesNotMatch(src, /mouse on/);
    assert.doesNotMatch(src, /tmux bind-key -n WheelUpPane/);
    assert.doesNotMatch(src, /tmux bind-key -n WheelDownPane/);
    assert.match(src, /unbind-key -n WheelUpPane/);
    assert.match(src, /unbind-key -n WheelDownPane/);
    // Keyboard roster paging stays.
    assert.match(src, /bind-key -T prefix P/);
    assert.match(src, /bind-key -T prefix N/);
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

describe("pane scripts ignore wheel", () => {
  it("meet-channel.mjs does not enable mouse and ignores SGR 64/65", () => {
    const src = read(meetChannel);
    assert.match(src, /const useMouse = false/);
    assert.doesNotMatch(src, /\?1000h/);
    assert.match(src, /btn === 64 \|\| btn === 65/);
    assert.match(src, /key === "j"|ch === "j"/);
    assert.match(src, /ch === "k"/);
  });

  it("meet-room-prompter.mjs does not enable mouse", () => {
    const src = read(meetPrompter);
    assert.doesNotMatch(src, /\?1000h/);
    assert.match(src, /btn === 64 \|\| btn === 65/);
    assert.match(src, /chunk === "h"/);
  });

  it("factory and dossier panes do not repaint on wheel", () => {
    const factory = read(path.join(root, "scripts/factory-window.mjs"));
    const dossier = read(path.join(root, "scripts/pstack-window.mjs"));
    assert.doesNotMatch(factory, /\?1000h/);
    assert.doesNotMatch(dossier, /\?1000h/);
    assert.doesNotMatch(dossier, /handleWheel/);
    assert.match(factory, /btn === 64 \|\| btn === 65\) continue/);
    assert.match(factory, /key\.name === "j"/);
    assert.match(factory, /key\.name === "k"/);
    assert.match(dossier, /key\.name === "j"/);
    assert.match(dossier, /key\.name === "up"/);
  });
});

describe("orchestrator-layout.sh — desk hotkeys", () => {
  it("does not bind Ctrl-A, Ctrl-B, or Ctrl-W on the pane key tables", () => {
    const src = read(layout);
    const fn = src.match(/install_layout_keys\(\) \{[\s\S]*?\n\}/);
    assert.ok(fn, "install_layout_keys present");
    assert.match(fn[0], /unbind-key -T "\$table" C-a/);
    assert.match(fn[0], /unbind-key -T "\$table" C-b/);
    assert.match(fn[0], /unbind-key -T "\$table" C-w/);
    assert.doesNotMatch(fn[0], /\btmux bind-key -T "\$table" C-a/);
    assert.doesNotMatch(fn[0], /\btmux bind-key -T "\$table" C-b/);
    assert.doesNotMatch(fn[0], /\btmux bind-key -T "\$table" C-w/);
    // Other layout chords stay.
    assert.match(fn[0], /bind-key -T "\$table" C-f/);
    assert.match(fn[0], /bind-key -T "\$table" C-g/);
    assert.match(fn[0], /bind-key -T "\$table" M-a/);
    assert.match(fn[0], /bind-key -T "\$table" M-b/);
    assert.match(fn[0], /bind-key -T "\$table" M-w/);
  });

  it("keeps prefix Ctrl+Space and focuses dossier, inbox, and meet from it", () => {
    const src = read(layout);
    assert.match(src, /set-option -t "\$sess" prefix C-Space/);
    assert.match(src, /set-option -t "\$sess" -u prefix2/);
    assert.match(src, /bind-key -T prefix D if-shell/);
    assert.match(src, /bind-key -T prefix I if-shell/);
    assert.match(src, /bind-key -T prefix M if-shell/);
    assert.match(src, /toggle-dossier/);
    assert.match(src, /toggle-inbox/);
    assert.match(src, /toggle-meet/);
    assert.match(src, /focus_desk pstack/);
    assert.match(src, /focus_desk inbox/);
    assert.match(src, /focus_desk meet/);
    // lowercase prefix m still opens the gallery; Shift+M is the desk pane.
    assert.match(src, /bind-key -T prefix m run-shell/);
  });
});

describe("meet room transcript scroll", () => {
  it("j scrolls down one line and k scrolls up when the prompt is empty", () => {
    const src = read(meetPrompter);
    assert.match(src, /if \(key === "j" \|\| key === "J"\) return -1/);
    assert.match(src, /if \(key === "k" \|\| key === "K"\) return 1/);
    const fn = src.slice(src.indexOf("function handleKey"), src.indexOf("function handleEsc"));
    assert.match(fn, /bufferEmpty\(\)/);
    assert.match(fn, /meetScrollDelta\(chunk\)/);
    assert.match(fn, /scrollFromBottom \+ line/);
    // Typing still inserts j/k; scroll is only the empty-prompt path.
    assert.ok(fn.indexOf("meetScrollDelta") < fn.indexOf("editor.insert"));
  });
});

describe("chat pane size", () => {
  it("caps the OpenCode chat prompt at 5 lines and pads 2 by 1", () => {
    const cfg = JSON.parse(read(path.join(root, "config/tui.json")));
    assert.equal(cfg.prompt.max_height, 5);
    const logo = read(path.join(root, ".opencode/tui-plugins/gotchi-logo.tsx"));
    assert.match(logo, /const CHAT_LINES = 5/);
    assert.match(logo, /const CHAT_PAD_X = 2/);
    assert.match(logo, /const CHAT_PAD_Y = 1/);
    assert.match(logo, /paddingLeft=\{CHAT_PAD_X\}/);
    assert.match(logo, /paddingRight=\{CHAT_PAD_X\}/);
    assert.match(logo, /paddingTop=\{CHAT_PAD_Y\}/);
    assert.match(logo, /paddingBottom=\{CHAT_PAD_Y\}/);
  });
});

