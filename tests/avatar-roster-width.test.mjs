/**
 * Avatar pane is 44 at a 147-column desk and at 163 (147+16). One column is a left pad.
 * Collapsed label bars are 3: one space, the glyph, one space. They are not shrunk to 1.
 * Focused chat/factory/dossier/inbox/meet/cockpit/kanban is 74 at 147 and 90 at 163.
 * Kanban is pane 8: its collapsed bar (3) and separator (1) come out of the focused pane (was 78 and 94).
 * Desk rows recorded by the layout are 46 (was 40).
 *   node --test tests/avatar-roster-width.test.mjs
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
const thumb = path.join(root, "assets/gotchi-thumb.ascii");

function read(p) {
  return readFileSync(p, "utf8");
}

function defaultAvatarMin(src) {
  const m = src.match(/\$\{GOTCHIBOT_TMUX_AVATAR_MIN_WIDTH:-(\d+)\}/);
  assert.ok(m, "GOTCHIBOT_TMUX_AVATAR_MIN_WIDTH default present");
  return Number(m[1]);
}

describe("avatar roster width", () => {
  it("defaults min avatar to a width that fits three cells at a 147-col desk", () => {
    const avatar = defaultAvatarMin(read(layout));
    const windowW = 147;
    const separators = 9 - 1;
    const filesBar = 3;
    // Collapsed label bars are pad + glyph + pad, not a 1-column glyph.
    // Six bars: cockpit, factory, dossier, inbox, meet, kanban (chat is focused).
    const labelBars = 6 * 3;
    const chrome = filesBar + labelBars;
    const content = windowW - separators;
    const pad = 1;
    const cellW = Math.floor((avatar - pad - 4) / 3);
    const row = cellW * 3 + 4;
    const chat = content - chrome - avatar;
    const wide = 163;
    const chatWide = (wide - separators) - chrome - avatar;

    assert.equal(avatar, 44);
    assert.equal(cellW, 13);
    assert.ok(cellW >= 12, `cell_w ${cellW} >= 12 (12-column thumb fits)`);
    assert.equal(row, 43);
    assert.equal(pad, 1);
    assert.ok(pad + row <= avatar, `pad+row ${pad + row} <= avatar ${avatar}`);
    assert.equal(chat, 74);
    assert.equal(chatWide, 90);
    assert.ok(chatWide > chat, "the extra 16 columns widen chat");
    assert.ok(chat > 57, `chat ${chat} still > 57`);

    const labels = [
      "User.Default.AAVE",
      "Link.UserDefault",
      "social-media-manager".replaceAll("-", " "),
      "dossier-ai-cron-site".replaceAll("-", " "),
      "chief-of-staff".replaceAll("-", " "),
    ];
    assert.ok(
      labels.some((label) => label.length > cellW),
      "at least one name label is longer than cell_w and clips",
    );
    for (const label of labels) {
      assert.ok(
        label.length > cellW,
        `${JSON.stringify(label)} length ${label.length} clips in cell_w ${cellW}`,
      );
    }
  });

  it("keeps the 12-column roster thumb", () => {
    const lines = read(thumb).split("\n").filter((line) => line.length > 0);
    assert.ok(lines.length > 0, "thumb has art lines");
    let max = 0;
    for (const line of lines) {
      assert.ok(line.length <= 12, `thumb line length ${line.length} <= 12`);
      if (line.length > max) max = line.length;
    }
    assert.equal(max, 12);
  });

  it("left-pads the roster so the label and first sprite start at column 1", () => {
    const out = execFileSync("bash", ["scripts/avatar-pane.sh", "roster-origin", "44"], {
      cwd: root,
      encoding: "utf8",
    });
    const got = {};
    for (const line of out.split("\n")) {
      if (!line) continue;
      const eq = line.indexOf("=");
      assert.ok(eq > 0, `assignment line: ${JSON.stringify(line)}`);
      got[line.slice(0, eq)] = line.slice(eq + 1);
    }
    assert.equal(got.pad, "1");
    assert.equal(got.cell_w, "13");
    assert.equal(got.row_w, "43");
    assert.equal(got.label_col, "1");
    assert.equal(got.sprite_col, "1");
    assert.equal(got.line_w, "44");
    assert.equal(got.label_prefix, " ");
    const labelCol = Number(got.label_col);
    const spriteCol = Number(got.sprite_col);
    assert.ok(labelCol >= 0, `label_col ${labelCol} is not negative`);
    assert.ok(spriteCol >= 0, `sprite_col ${spriteCol} is not negative`);
    assert.notEqual(labelCol, 0);
    assert.notEqual(spriteCol, 0);
  });

  function sizes(width, focus) {
    const out = execFileSync("bash", ["scripts/orchestrator-layout.sh", "sizes", String(width), focus], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, TMUX: "", TMUX_PANE: "", TERM: "xterm-256color" },
    }).trim();
    return Object.fromEntries(out.split(/\s+/).map((part) => part.split("=")));
  }

  const rowKeys = ["files", "avatar", "cockpit", "chat", "factory", "dossier", "inbox", "meet", "kanban"];

  it("pads collapsed labels and keeps chat at 74 on the previous 147-wide desk", () => {
    const got = sizes(147, "chat");
    assert.equal(got.files, "3");
    assert.equal(got.avatar, "44");
    assert.equal(got.cockpit, "3");
    assert.equal(got.chat, "74");
    assert.equal(got.factory, "3");
    assert.equal(got.dossier, "3");
    assert.equal(got.inbox, "3");
    assert.equal(got.meet, "3");
    assert.equal(got.kanban, "3");
    assert.equal(got.sum, "139");
    const widths = rowKeys.map((k) => Number(got[k]));
    assert.equal(widths.reduce((n, w) => n + w, 0) + 8, 147);

    const cockpit = sizes(147, "cockpit");
    assert.equal(cockpit.avatar, "44");
    assert.equal(cockpit.chat, "3");
    assert.equal(cockpit.cockpit, "74");
    assert.equal(cockpit.kanban, "3");
    assert.equal(cockpit.factory, "3");
    assert.equal(cockpit.sum, "139");
  });

  it("gives the extra 16 columns to chat, factory, dossier, inbox, meet, and kanban at 163", () => {
    const chat = sizes(163, "chat");
    assert.equal(chat.files, "3");
    assert.equal(chat.avatar, "44");
    assert.equal(chat.cockpit, "3");
    assert.equal(chat.chat, "90");
    assert.equal(chat.factory, "3");
    assert.equal(chat.dossier, "3");
    assert.equal(chat.inbox, "3");
    assert.equal(chat.meet, "3");
    assert.equal(chat.kanban, "3");
    assert.equal(chat.sum, "155");
    const widths = rowKeys.map((k) => Number(chat[k]));
    assert.equal(widths.reduce((n, w) => n + w, 0) + 8, 163);

    const focused = { factory: "factory", dossier: "dossier", inbox: "inbox", meet: "meet", kanban: "kanban" };
    for (const [pane, focus] of Object.entries(focused)) {
      const got = sizes(163, focus);
      assert.equal(got.files, "3", focus);
      assert.equal(got.avatar, "44", focus);
      assert.equal(got[pane], "90", focus);
      assert.equal(got.sum, "155", focus);
      for (const other of ["cockpit", "chat", "factory", "dossier", "inbox", "meet", "kanban"]) {
        if (other === pane) continue;
        assert.equal(got[other], "3", `${focus} ${other}`);
      }
      const row = rowKeys.map((k) => Number(got[k]));
      assert.equal(row.reduce((n, w) => n + w, 0) + 8, 163, focus);
    }
    const at147 = sizes(147, "chat");
    assert.equal(Number(chat.chat) - Number(at147.chat), 16);
    const pstack = sizes(163, "pstack");
    assert.equal(pstack.dossier, "90");
    assert.equal(pstack.chat, "3");
    assert.equal(pstack.kanban, "3");
    assert.equal(pstack.avatar, "44");
    const cockpit = sizes(163, "cockpit");
    assert.equal(cockpit.cockpit, "90");
    assert.equal(cockpit.chat, "3");
    assert.equal(cockpit.kanban, "3");
    assert.equal(cockpit.avatar, "44");
  });

  it("draws collapsed label text with one space on each side", () => {
    const src = read(path.join(root, "scripts/lib/desk-label.sh"));
    assert.match(src, /desk_label_glyph\(\)/);
    assert.match(src, /printf '\\033\[38;5;%sm %s \\033\[0m\\n'/);
    const out = execFileSync(
      "bash",
      [
        "-c",
        "source scripts/lib/desk-label.sh; clear() { :; }; desk_label_render Ab ''",
      ],
      { cwd: root, encoding: "utf8" },
    );
    const visible = out
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));
    assert.deepEqual(visible, [" › ", " A ", " b "]);
  });

  it("records a desk canvas of 163 columns and 46 rows", () => {
    const src = read(layout);
    assert.match(src, /GOTCHIBOT_WINDOW_WIDTH:-163/);
    assert.match(src, /GOTCHIBOT_WINDOW_HEIGHT:-46/);
    assert.match(src, /GOTCHIBOT_WINDOW_HEIGHT_DESKTOP:-70/);
    const boot = read(path.join(root, "scripts/gotchibot"));
    assert.match(boot, /GOTCHIBOT_WINDOW_WIDTH:-163/);
    assert.match(boot, /GOTCHIBOT_WINDOW_HEIGHT:-46/);
    assert.doesNotMatch(src, /mouse on/);
  });

  function canvasHeight(client) {
    return execFileSync("bash", ["scripts/orchestrator-layout.sh", "canvas-height", String(client)], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, TMUX: "", TMUX_PANE: "", TERM: "xterm-256color" },
    }).trim();
  }

  function rosterRows(paneH) {
    const out = execFileSync("bash", ["scripts/avatar-pane.sh", "roster-rows", String(paneH)], {
      cwd: root,
      encoding: "utf8",
    });
    return Object.fromEntries(
      out.trim().split("\n").map((line) => line.split("=")),
    );
  }

  it("keeps a 46-row canvas on short terminals and grows only when 3 rows fit", () => {
    assert.equal(canvasHeight(24), "46");
    assert.equal(canvasHeight(46), "46");
    assert.equal(canvasHeight(50), "46");
    // 70 client lines leave 69 of content — one short of the 3-row pane.
    assert.equal(canvasHeight(70), "46");
    assert.equal(canvasHeight(71), "70");
    assert.equal(canvasHeight(120), "119");
  });

  it("shows one roster row below 70 pane rows and three at 70", () => {
    const laptop = rosterRows(46);
    assert.equal(laptop.rows, "1");
    assert.equal(laptop.page, "3");
    assert.equal(laptop.grid, "19");
    const almost = rosterRows(69);
    assert.equal(almost.rows, "1");
    assert.equal(almost.grid, "19");
    const desk = rosterRows(70);
    assert.equal(desk.rows, "3");
    assert.equal(desk.page, "9");
    assert.equal(desk.grid, "43");
    const tall = rosterRows(119);
    assert.equal(tall.rows, "3");
    assert.equal(tall.grid, "43");
    // Short pane budgets are unchanged.
    assert.equal(rosterRows(27).grid, "11");
    assert.equal(rosterRows(27).rows, "1");
    assert.equal(rosterRows(40).grid, "15");
    assert.equal(rosterRows(40).rows, "1");
  });
});
