/**
 * Avatar pane is 43 at a 147-column desk. Sprites stay 12 columns; labels may clip.
 *   node --test tests/avatar-roster-width.test.mjs
 * Does not start tmux.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
    const cellW = Math.floor((avatar - 4) / 3);
    const row = cellW * 3 + 4;
    const chat = content - chrome - avatar;

    assert.equal(avatar, 43);
    assert.equal(cellW, 13);
    assert.ok(cellW >= 12, `cell_w ${cellW} >= 12 (12-column thumb fits)`);
    assert.equal(row, 43);
    assert.ok(row <= avatar, `row ${row} <= avatar ${avatar}`);
    assert.equal(chat, 79);
    assert.ok(chat > 57, `chat ${chat} grew when avatar shrank from 65 (was 57)`);

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
});
