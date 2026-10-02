/**
 * Avatar pane is 44 at a 147-column desk. One column is a left pad.
 * Sprites stay 12 columns; labels may clip.
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
    const labelBars = 5 * 3;
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
    assert.equal(chat, 78);
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
});
