/**
 * Avatar pane is 24 at a 147-column desk and at 163 (147+16). One column is a left pad.
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
  it("defaults min avatar to a width that fits one column at a 147-col desk", () => {
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
    const cellW = avatar - pad;
    const row = cellW;
    const chat = content - chrome - avatar;
    const wide = 163;
    const chatWide = (wide - separators) - chrome - avatar;

    assert.equal(avatar, 24);
    assert.equal(cellW, 23);
    assert.ok(cellW >= 12, `cell_w ${cellW} >= 12 (12-column thumb fits)`);
    assert.equal(row, 23);
    assert.equal(pad, 1);
    assert.ok(pad + row <= avatar, `pad+row ${pad + row} <= avatar ${avatar}`);
    assert.equal(chat, 94);
    assert.equal(chatWide, 110);
    assert.ok(chatWide > chat, "the extra 16 columns widen chat");
    assert.ok(chat > 57, `chat ${chat} still > 57`);

    const labels = [
      "User.Default.AAVE",
      "Link.UserDefault",
      "social-media-manager".replaceAll("-", " "),
      "dossier-ai-cron-site".replaceAll("-", " "),
      "chief-of-staff".replaceAll("-", " "),
    ];
    for (const label of labels) {
      assert.ok(
        label.length <= cellW,
        `${JSON.stringify(label)} length ${label.length} fits in cell_w ${cellW}`,
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
    const eye = lines.find((line) => /▀▀ +▀▀/.test(line));
    assert.ok(eye, "mid thumb keeps the two-pixel eyes");
  });

  it("drops mini eye pixels 2 and 4 and leaves the mid face alone", () => {
    const mini = read(path.join(root, "assets/gotchi-kanban.ascii")).split("\n");
    const eye = mini.find((line) => line.startsWith("█") && line.includes("▀"));
    assert.equal(eye, "█  ▀ ▀  █");
    const marks = [...eye].filter((ch) => ch === "▀");
    assert.equal(marks.length, 2);
    const mid = read(thumb).split("\n").find((line) => /▀▀ +▀▀/.test(line));
    assert.match(mid, /▀▀ {2}▀▀/);
  });

  it("centers the 9-wide mini under the 12-wide face in a 24-column pane", () => {
    const out = execFileSync("bash", ["scripts/avatar-pane.sh", "roster-origin", "24"], {
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
    assert.equal(got.cell_w, "23");
    assert.equal(got.row_w, "23");
    assert.equal(got.label_col, "1");
    assert.equal(got.sprite_col, "1");
    assert.equal(got.line_w, "24");
    assert.equal(got.mini_col, "7");
    assert.equal(got.face_col, "6");
    assert.ok(Number(got.mini_col) > 1, "mini is not left-aligned");
    const pane = read(path.join(root, "scripts/avatar-pane.sh"));
    assert.ok(pane.includes("(pane_w - max_vis) / 2"));
    const draw = pane.slice(pane.indexOf("for ((i = base; i < end; i++))"));
    assert.ok(draw.includes('put_line "$row" "$line"'));
    assert.ok(!draw.slice(0, draw.indexOf("Button row")).includes("roster_pad_line"));
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

  it("pads collapsed labels and keeps chat at 94 on the previous 147-wide desk", () => {
    const got = sizes(147, "chat");
    assert.equal(got.files, "3");
    assert.equal(got.avatar, "24");
    assert.equal(got.cockpit, "3");
    assert.equal(got.chat, "94");
    assert.equal(got.factory, "3");
    assert.equal(got.dossier, "3");
    assert.equal(got.inbox, "3");
    assert.equal(got.meet, "3");
    assert.equal(got.kanban, "3");
    assert.equal(got.sum, "139");
    const widths = rowKeys.map((k) => Number(got[k]));
    assert.equal(widths.reduce((n, w) => n + w, 0) + 8, 147);

    const cockpit = sizes(147, "cockpit");
    assert.equal(cockpit.avatar, "24");
    assert.equal(cockpit.chat, "3");
    assert.equal(cockpit.cockpit, "94");
    assert.equal(cockpit.kanban, "3");
    assert.equal(cockpit.factory, "3");
    assert.equal(cockpit.sum, "139");
  });

  it("gives the extra 16 columns to chat, factory, dossier, inbox, meet, and kanban at 163", () => {
    const chat = sizes(163, "chat");
    assert.equal(chat.files, "3");
    assert.equal(chat.avatar, "24");
    assert.equal(chat.cockpit, "3");
    assert.equal(chat.chat, "110");
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
      assert.equal(got.avatar, "24", focus);
      assert.equal(got[pane], "110", focus);
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
    assert.equal(pstack.dossier, "110");
    assert.equal(pstack.chat, "3");
    assert.equal(pstack.kanban, "3");
    assert.equal(pstack.avatar, "24");
    const cockpit = sizes(163, "cockpit");
    assert.equal(cockpit.cockpit, "110");
    assert.equal(cockpit.chat, "3");
    assert.equal(cockpit.kanban, "3");
    assert.equal(cockpit.avatar, "24");
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

  function rosterRowsMode(paneH, mode) {
    const out = execFileSync("bash", ["scripts/avatar-pane.sh", "roster-rows", String(paneH), mode], {
      cwd: root,
      encoding: "utf8",
    });
    return Object.fromEntries(
      out.trim().split("\n").map((line) => line.split("=")),
    );
  }

  it("keeps the unfocused roster a single column of minis with no selected header", () => {
    const laptop = rosterRows(46);
    assert.equal(laptop.rows, "1");
    assert.equal(laptop.page, "7");
    assert.equal(laptop.grid, "46");
    const almost = rosterRows(69);
    assert.equal(almost.rows, "1");
    assert.equal(almost.page, "11");
    assert.equal(almost.grid, "69");
    const desk = rosterRows(70);
    assert.equal(desk.rows, "1");
    assert.equal(desk.page, "11");
    assert.equal(desk.grid, "70");
    const tall = rosterRows(119);
    assert.equal(tall.rows, "1");
    assert.equal(tall.page, "19");
    assert.equal(tall.grid, "119");
    assert.equal(rosterRows(27).grid, "27");
    assert.equal(rosterRows(27).rows, "1");
    assert.equal(rosterRows(27).page, "4");
    assert.equal(rosterRows(40).grid, "40");
    assert.equal(rosterRows(40).rows, "1");
    assert.equal(rosterRows(40).page, "6");
  });

  it("puts a 4 by 4 mid grid beside the portrait when the pane is focused", () => {
    const laptop = rosterRowsMode(46, "focused");
    assert.equal(laptop.cols, "4");
    assert.equal(laptop.rows, "4");
    assert.equal(laptop.page, "16");
    assert.equal(rosterRowsMode(27, "focused").rows, "2");
    assert.equal(rosterRowsMode(27, "focused").page, "8");
    assert.equal(rosterRowsMode(27, "focused").cols, "4");
    assert.equal(rosterRowsMode(70, "focused").rows, "4");
    assert.equal(rosterRowsMode(70, "focused").page, "16");
    const pane = read(path.join(root, "scripts/avatar-pane.sh"));
    const body = pane.slice(pane.indexOf("render_body()"), pane.indexOf("rerender()"));
    assert.match(body, /avatar_pane_focused/);
    assert.match(body, /render_main_art/);
    assert.match(body, /face=mid/);
    assert.match(body, /roster_geometry "\$right_w" wide/);
    assert.match(body, /join4 /);
    assert.doesNotMatch(body, /thumb_art "" "\$pin_id" "" mid/);
    assert.match(pane, /GOTCHI_INCLUDE_PINNED/);
  });

  it("expands the avatar pane on focus and leaves chat wide when chat is focused", () => {
    const chat = sizes(163, "chat");
    assert.equal(chat.avatar, "24");
    assert.equal(chat.chat, "110");
    assert.equal(chat.cockpit, "3");
    const cockpit = sizes(163, "cockpit");
    assert.equal(cockpit.cockpit, "110");
    assert.equal(cockpit.avatar, "24");
    assert.equal(cockpit.chat, "3");
    const av = sizes(163, "avatar");
    assert.equal(av.files, "3");
    assert.equal(av.avatar, "131");
    assert.equal(av.cockpit, "3");
    assert.equal(av.chat, "3");
    assert.equal(av.factory, "3");
    assert.equal(av.dossier, "3");
    assert.equal(av.inbox, "3");
    assert.equal(av.meet, "3");
    assert.equal(av.kanban, "3");
    assert.equal(av.sum, "155");
    const widths = rowKeys.map((k) => Number(av[k]));
    assert.equal(widths.reduce((n, w) => n + w, 0) + 8, 163);
    const av147 = sizes(147, "avatar");
    assert.equal(av147.avatar, "115");
    assert.equal(av147.chat, "3");
    assert.equal(av147.cockpit, "3");
    assert.equal(av147.sum, "139");
  });

  it("puts the project name where the tab subtitle used to lead with the orchestrator", () => {
    const out = execFileSync(
      "bash",
      ["-c", 'source scripts/lib/desk-label.sh; desk_label_subtitle "User0xDefault · idle" "AarcadeGh-t"'],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(out, "AarcadeGh-t · idle");
    const src = read(path.join(root, "scripts/lib/desk-label.sh"));
    assert.match(src, /desk_label_subtitle "\$line" "\$\(desk_label_project\)"/);
  });
});
