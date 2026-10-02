/**
 * Avatar pane width at a 147-column desk: three roster cells, labels up to 20.
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

    assert.ok(avatar >= 65, `avatar default ${avatar} >= 65`);
    assert.ok(cellW >= 20, `cell_w ${cellW} >= 20`);
    assert.ok(row <= avatar - 1, `row ${row} <= avatar-1 ${avatar - 1}`);
    assert.ok(chat >= 36, `chat ${chat} stays above the 36-col focus floor`);
    assert.ok(chat < 81, `chat ${chat} is the pane that shrank (was 81)`);

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
  });
});
