/**
 * Avatar pane is 24 at a 147-column desk and at 163 (147+16). One column is a left pad.
 * Collapsed label bars are 3: one space, the glyph, one space. They are not shrunk to 1.
 * Focused chat/factory/dossier/inbox/meet/cockpit/kanban is 74 at 147 and 90 at 163.
 * Kanban is pane 8, Terminal pane 9: each collapsed bar (3) and separator (1) comes out of the focused pane (94 → 90 at 147).
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
    const separators = 10 - 1;
    const filesBar = 3;
    // Collapsed label bars are pad + glyph + pad, not a 1-column glyph.
    // Seven bars: cockpit, factory, dossier, inbox, meet, kanban, terminal (chat is focused).
    const labelBars = 7 * 3;
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
    assert.equal(chat, 90);
    assert.equal(chatWide, 106);
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

  const rowKeys = ["files", "avatar", "cockpit", "chat", "factory", "dossier", "inbox", "meet", "kanban", "terminal"];

  it("pads collapsed labels and keeps chat at 90 on the previous 147-wide desk", () => {
    const got = sizes(147, "chat");
    assert.equal(got.files, "3");
    assert.equal(got.avatar, "24");
    assert.equal(got.cockpit, "3");
    assert.equal(got.chat, "90");
    assert.equal(got.factory, "3");
    assert.equal(got.dossier, "3");
    assert.equal(got.inbox, "3");
    assert.equal(got.meet, "3");
    assert.equal(got.kanban, "3");
    assert.equal(got.sum, "138");
    const widths = rowKeys.map((k) => Number(got[k]));
    assert.equal(widths.reduce((n, w) => n + w, 0) + 9, 147);

    const cockpit = sizes(147, "cockpit");
    assert.equal(cockpit.avatar, "24");
    assert.equal(cockpit.chat, "3");
    assert.equal(cockpit.cockpit, "90");
    assert.equal(cockpit.kanban, "3");
    assert.equal(cockpit.factory, "3");
    assert.equal(cockpit.sum, "138");
  });

  it("gives the extra 16 columns to chat, factory, dossier, inbox, meet, and kanban at 163", () => {
    const chat = sizes(163, "chat");
    assert.equal(chat.files, "3");
    assert.equal(chat.avatar, "24");
    assert.equal(chat.cockpit, "3");
    assert.equal(chat.chat, "106");
    assert.equal(chat.factory, "3");
    assert.equal(chat.dossier, "3");
    assert.equal(chat.inbox, "3");
    assert.equal(chat.meet, "3");
    assert.equal(chat.kanban, "3");
    assert.equal(chat.sum, "154");
    const widths = rowKeys.map((k) => Number(chat[k]));
    assert.equal(widths.reduce((n, w) => n + w, 0) + 9, 163);

    const focused = { factory: "factory", dossier: "dossier", inbox: "inbox", meet: "meet", kanban: "kanban" };
    for (const [pane, focus] of Object.entries(focused)) {
      const got = sizes(163, focus);
      assert.equal(got.files, "3", focus);
      assert.equal(got.avatar, "24", focus);
      assert.equal(got[pane], "106", focus);
      assert.equal(got.sum, "154", focus);
      for (const other of ["cockpit", "chat", "factory", "dossier", "inbox", "meet", "kanban", "terminal"]) {
        if (other === pane) continue;
        assert.equal(got[other], "3", `${focus} ${other}`);
      }
      const row = rowKeys.map((k) => Number(got[k]));
      assert.equal(row.reduce((n, w) => n + w, 0) + 9, 163, focus);
    }
    const at147 = sizes(147, "chat");
    assert.equal(Number(chat.chat) - Number(at147.chat), 16);
    const pstack = sizes(163, "pstack");
    assert.equal(pstack.dossier, "106");
    assert.equal(pstack.chat, "3");
    assert.equal(pstack.kanban, "3");
    assert.equal(pstack.avatar, "24");
    const cockpit = sizes(163, "cockpit");
    assert.equal(cockpit.cockpit, "106");
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

  it("puts a 4 by 3 mid grid beside the portrait when the pane is focused", () => {
    const laptop = rosterRowsMode(46, "focused");
    assert.equal(laptop.cols, "4");
    assert.equal(laptop.rows, "3");
    assert.equal(laptop.page, "12");
    assert.equal(rosterRowsMode(27, "focused").rows, "2");
    assert.equal(rosterRowsMode(27, "focused").page, "8");
    assert.equal(rosterRowsMode(27, "focused").cols, "4");
    assert.equal(rosterRowsMode(70, "focused").rows, "3");
    assert.equal(rosterRowsMode(70, "focused").page, "12");
    const pane = read(path.join(root, "scripts/avatar-pane.sh"));
    const body = pane.slice(pane.indexOf("render_body()"), pane.indexOf("rerender()"));
    assert.match(body, /avatar_pane_focused/);
    assert.match(body, /render_main_art/);
    assert.match(body, /face=mid/);
    assert.match(body, /roster_geometry "\$right_w" wide/);
    assert.match(body, /join4 /);
    assert.match(body, /expanded_vpad "\$pane_h" "\$block_h"/);
    assert.doesNotMatch(body, /thumb_art "" "\$pin_id" "" mid/);
    assert.match(pane, /GOTCHI_INCLUDE_PINNED/);
  });

  it("expands the avatar pane on focus and leaves chat wide when chat is focused", () => {
    const chat = sizes(163, "chat");
    assert.equal(chat.avatar, "24");
    assert.equal(chat.chat, "106");
    assert.equal(chat.cockpit, "3");
    const cockpit = sizes(163, "cockpit");
    assert.equal(cockpit.cockpit, "106");
    assert.equal(cockpit.avatar, "24");
    assert.equal(cockpit.chat, "3");
    const av = sizes(163, "avatar");
    assert.equal(av.files, "3");
    assert.equal(av.avatar, "127");
    assert.equal(av.cockpit, "3");
    assert.equal(av.chat, "3");
    assert.equal(av.factory, "3");
    assert.equal(av.dossier, "3");
    assert.equal(av.inbox, "3");
    assert.equal(av.meet, "3");
    assert.equal(av.kanban, "3");
    assert.equal(av.sum, "154");
    const widths = rowKeys.map((k) => Number(av[k]));
    assert.equal(widths.reduce((n, w) => n + w, 0) + 9, 163);
    const av147 = sizes(147, "avatar");
    assert.equal(av147.avatar, "111");
    assert.equal(av147.chat, "3");
    assert.equal(av147.cockpit, "3");
    assert.equal(av147.sum, "138");
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

  function probe(args) {
    const out = execFileSync("bash", ["scripts/avatar-pane.sh", ...args], {
      cwd: root,
      encoding: "utf8",
    });
    return Object.fromEntries(
      out.trim().split("\n").filter(Boolean).map((line) => {
        const eq = line.indexOf("=");
        return [line.slice(0, eq), line.slice(eq + 1)];
      }),
    );
  }

  it("keeps the focused expanded render alive on bash 3.2", () => {
    const pane = read(path.join(root, "scripts/avatar-pane.sh"));
    assert.doesNotMatch(pane, /local llen=\$\{#L\[@\]\}/);
    execFileSync("bash", ["scripts/avatar-pane.sh", "once"], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
      env: {
        ...process.env,
        TMUX: "",
        TMUX_PANE: "",
        GOTCHIBOT_AVATAR_FOCUSED: "1",
        TERM: "xterm-256color",
      },
    });
  });

  it("centers the expanded portrait and grid with blank rows above and below", () => {
    const laptop = probe(["block-origin", "46", "37"]);
    assert.equal(Number(laptop.top) > 0, true, `top ${laptop.top}`);
    assert.equal(Number(laptop.bottom) > 0, true, `bottom ${laptop.bottom}`);
    assert.ok(Math.abs(Number(laptop.top) - Number(laptop.bottom)) <= 1);
    const desk = probe(["block-origin", "70", "36"]);
    assert.equal(Number(desk.top) > 0, true);
    assert.equal(Number(desk.bottom) > 0, true);
    assert.ok(Math.abs(Number(desk.top) - Number(desk.bottom)) <= 1);
    const full = probe(["block-origin", "46", "46"]);
    assert.equal(full.top, "0");
    assert.equal(full.bottom, "0");
    const pane = read(path.join(root, "scripts/avatar-pane.sh"));
    const body = pane.slice(pane.indexOf("render_body()"), pane.indexOf("rerender()"));
    assert.match(body, /expanded_vpad "\$pane_h" "\$block_h"/);
    assert.match(body, /lft="\$\{L\[i\]\}"/);
    assert.match(body, /gline="\$\{G\[i\]\}"/);
    assert.doesNotMatch(body, /The grid stays at the top/);
  });

  it("starts the sub-agent selector on the first card and moves it with arrows", () => {
    const pane = read(path.join(root, "scripts/avatar-pane.sh"));
    assert.match(pane, /SEL=0/);
    assert.match(pane, /settle_selection/);
    const origin = probe(["select-apply", "1", "13", "12", "4", "0", "0", "0", "right"]);
    assert.equal(origin.sel, "1");
    assert.equal(origin.page, "0");
    assert.equal(origin.modal, "0");
    const across = probe(["select-apply", "1", "13", "12", "4", "11", "0", "0", "right"]);
    assert.equal(across.sel, "12");
    assert.equal(across.page, "1");
    const down = probe(["select-apply", "1", "13", "12", "4", "8", "0", "0", "down"]);
    assert.equal(down.sel, "12");
    assert.equal(down.page, "1");
    const back = probe(["select-apply", "1", "13", "12", "4", "12", "1", "0", "up"]);
    assert.equal(back.sel, "8");
    assert.equal(back.page, "0");
    const left = probe(["select-apply", "1", "13", "12", "4", "12", "1", "0", "left"]);
    assert.equal(left.sel, "11");
    assert.equal(left.page, "0");
  });

  it("opens the sub-agent modal with space and ignores selector keys when unfocused", () => {
    const open = probe(["select-apply", "1", "13", "12", "4", "12", "1", "0", "space"]);
    assert.equal(open.modal, "1");
    assert.equal(open.modal_for, "12");
    assert.equal(open.sel, "12");
    const close = probe(["select-apply", "1", "13", "12", "4", "12", "1", "1", "space"]);
    assert.equal(close.modal, "0");
    const esc = probe(["select-apply", "1", "13", "12", "4", "12", "1", "1", "esc"]);
    assert.equal(esc.modal, "0");
    assert.equal(esc.sel, "12");
    const typed = probe(["select-apply", "1", "13", "12", "4", "0", "0", "0", "space", "4"]);
    assert.equal(typed.modal, "0");
    const idle = probe(["select-apply", "0", "13", "12", "4", "3", "0", "0", "right"]);
    assert.equal(idle.sel, "3");
    assert.equal(idle.page, "0");
    assert.equal(idle.modal, "0");
    const idleSpace = probe(["select-apply", "0", "13", "12", "4", "3", "0", "1", "space"]);
    assert.equal(idleSpace.sel, "3");
    assert.equal(idleSpace.modal, "1");
    const pane = read(path.join(root, "scripts/avatar-pane.sh"));
    assert.match(pane, /draw_sub_modal/);
    // Modal menu: Chat (1:1 meeting) and Assign role (catalog list with Back).
    assert.match(pane, /MODAL_MENU=\("Chat" "Assign role"\)\n  \[ "\$\{MODAL_TRUST:-\}" = probation \] && MODAL_MENU\+=\("Promote"\)/);
    assert.match(pane, /Promote\) modal_promote ;;/);
    assert.match(pane, /pack-wearable\.mjs" trust "\$hero" trusted/);
    assert.match(pane, /pack-wearable\.mjs" equip "\$SEL_ID" "\$role"/);
    assert.match(pane, /gotchibot meet chat "\$SEL_ID"/);
    assert.match(pane, /← back/);
    assert.match(pane, /esc close/);
    assert.match(pane, /EXPANDED:-0\}" != 1/);
    assert.match(pane, /CELL_SELECTED/);
    assert.match(pane, /AV_SEL_BG/);
    const layout = read(path.join(root, "scripts/orchestrator-layout.sh"));
    assert.match(layout, /bind-key -T gotchi-avatar Left "run-shell \\"\$sl\\""/);
    assert.match(layout, /bind-key -T gotchi-avatar Up "run-shell \\"\$su\\""/);
    assert.match(layout, /select-arrow left/);
    assert.match(layout, /Focused expanded avatar: arrows move the sub-agent selector instead of paging/);
    assert.doesNotMatch(layout, /tmux bind-key -n Left/);
    assert.doesNotMatch(layout, /tmux bind-key -n Up/);
  });
});
