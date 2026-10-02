/**
 * Avatar pane is 44 at a 147-column desk. One column is a left pad.
 * Chat focus is 88: five label bars shrink 3 → 1. Sprites stay 12 columns; names may clip.
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
    const separators = 8 - 1;
    const filesBar = 3;
    // Chat focus: five label bars give up 2 columns of glyph slack each (3 → 1).
    const labelBars = 5 * 1;
    const chrome = filesBar + labelBars;
    const content = windowW - separators;
    const pad = 1;
    const cellW = Math.floor((avatar - pad - 4) / 3);
    const row = cellW * 3 + 4;
    const chat = content - chrome - avatar;

    assert.equal(avatar, 44);
    assert.equal(cellW, 13);
    assert.ok(cellW >= 12, `cell_w ${cellW} >= 12 (12-column thumb fits)`);
    assert.equal(row, 43);
    assert.equal(pad, 1);
    assert.ok(pad + row <= avatar, `pad+row ${pad + row} <= avatar ${avatar}`);
    assert.equal(chat, 88);
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

  it("gives chat 10 columns from the five label bars at 147", () => {
    const out = execFileSync("bash", ["scripts/orchestrator-layout.sh", "sizes", "147", "chat"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, TMUX: "", TMUX_PANE: "", TERM: "xterm-256color" },
    }).trim();
    const got = Object.fromEntries(out.split(/\s+/).map((part) => part.split("=")));
    assert.equal(got.files, "3");
    assert.equal(got.avatar, "44");
    assert.equal(got.cockpit, "1");
    assert.equal(got.chat, "88");
    assert.equal(got.factory, "1");
    assert.equal(got.dossier, "1");
    assert.equal(got.inbox, "1");
    assert.equal(got.meet, "1");
    assert.equal(got.sum, "140");
    const widths = ["files", "avatar", "cockpit", "chat", "factory", "dossier", "inbox", "meet"].map((k) => Number(got[k]));
    assert.equal(widths.reduce((n, w) => n + w, 0) + 7, 147);

    const cockpit = execFileSync("bash", ["scripts/orchestrator-layout.sh", "sizes", "147", "cockpit"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, TMUX: "", TMUX_PANE: "", TERM: "xterm-256color" },
    }).trim();
    const other = Object.fromEntries(cockpit.split(/\s+/).map((part) => part.split("=")));
    assert.equal(other.avatar, "44");
    assert.equal(other.chat, "3");
    assert.equal(other.cockpit, "78");
    assert.equal(other.factory, "3");
    assert.equal(other.sum, "140");
  });

  it("gives factory, dossier, inbox, and meet the chat width at 147", () => {
    const env = { ...process.env, TMUX: "", TMUX_PANE: "", TERM: "xterm-256color" };
    function sizes(focus) {
      const out = execFileSync("bash", ["scripts/orchestrator-layout.sh", "sizes", "147", focus], {
        cwd: root,
        encoding: "utf8",
        env,
      }).trim();
      return Object.fromEntries(out.split(/\s+/).map((part) => part.split("=")));
    }
    const focused = { factory: "factory", dossier: "dossier", inbox: "inbox", meet: "meet" };
    for (const [pane, focus] of Object.entries(focused)) {
      const got = sizes(focus);
      assert.equal(got.files, "3", focus);
      assert.equal(got.avatar, "44", focus);
      assert.equal(got[pane], "88", focus);
      assert.equal(got.sum, "140", focus);
      for (const other of ["cockpit", "chat", "factory", "dossier", "inbox", "meet"]) {
        if (other === pane) continue;
        assert.equal(got[other], "1", `${focus} ${other}`);
      }
      const widths = ["files", "avatar", "cockpit", "chat", "factory", "dossier", "inbox", "meet"].map((k) => Number(got[k]));
      assert.equal(widths.reduce((n, w) => n + w, 0) + 7, 147, focus);
    }
    // pstack is the layout name for the dossier pane.
    const pstack = sizes("pstack");
    assert.equal(pstack.dossier, "88");
    assert.equal(pstack.chat, "1");
    assert.equal(pstack.avatar, "44");
  });
});
