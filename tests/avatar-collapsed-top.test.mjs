/**
 * Collapsed avatar pane: tiles start at the top, the pager stays at the bottom.
 *   node --test tests/avatar-collapsed-top.test.mjs
 * Does not start tmux.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pane = path.join(root, "scripts/avatar-pane.sh");
const origin = (...a) =>
  Object.fromEntries(
    execFileSync("bash", [pane, "collapsed-origin", ...a.map(String)], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((l) => l.split("=")),
  );

describe("collapsed avatar column", () => {
  it("starts at the top and puts the spare rows between the tiles and the pager", () => {
    const o = origin(46, 1, 30);
    assert.equal(o.top, "0");
    assert.equal(o.gap, String(46 - 1 - 3 - 30));
  });
  it("never goes negative when the tiles fill the pane", () => {
    assert.equal(origin(20, 1, 30).gap, "0");
    assert.equal(origin(20, 1, 30).top, "0");
  });
  it("the renderer draws the tiles first and the gap after them, before the pager row", () => {
    const src = readFileSync(pane, "utf8");
    const body = src.slice(src.indexOf("# Tiles start at the top;"), src.indexOf("# Button row under the roster"));
    const tiles = body.indexOf('for ((i = base; i < end; i++)); do\n    [ "$row" -ge "$pane_h" ] && break');
    const gap = body.indexOf("for ((i = 0; i < drop; i++)); do");
    assert.ok(tiles > 0 && gap > tiles, "gap loop comes after the tile loop");
    assert.ok(!/\n  for \(\(i = 0; i < drop; i\+\+\)\); do\n    put_line "\$row" ""\n    row=\$\(\(row \+ 1\)\)\n  done\n  for \(\(i = base/.test(body), "no blank rows above the first tile");
    assert.match(src, /CTRL_ROW="\$row"/);
  });
});
