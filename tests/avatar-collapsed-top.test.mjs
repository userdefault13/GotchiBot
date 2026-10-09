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

const fit = (avail, heights, solo) =>
  Number(
    execFileSync("bash", [pane, "collapsed-fit", String(avail), heights, solo ?? ""], { encoding: "utf8" })
      .trim()
      .split("=")[1],
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
  it("keeps one separator row above the pager unless a solo last tile needs it", () => {
    // pane_h here is the 42 rows the renderer paints in a 43-row tmux pane (the last row is the hint line)
    assert.equal(origin(42, 0, 20).sep, "1");
    assert.equal(origin(42, 0, 39).sep, "1"); // exactly fills the room, separator still fits
    assert.equal(origin(42, 0, 40).sep, "0"); // solo page borrows the separator row
  });
});

describe("collapsed fit: two full tiles and a solo mini", () => {
  // Heights measured on the desk roster: pinned 12, plain mini 8, hero box 17.
  const H = "12 8 8 17 17 8 8 8 17 8 8 8";
  const SOLO = "0 1 1 0 0 1 1 1 0 1 1 1";
  it("shows 3 tiles per page at a tall desktop when the last tile may go solo", () => {
    // 17 + 17 + 8 = 42 > 39, but 17 + 17 + (8 - 2) = 40 = 39 + the separator row.
    assert.equal(fit(39, H, SOLO), 3);
  });
  it("falls back to 2 tiles when the last tile of the tall page cannot be solo (a hero box)", () => {
    assert.equal(fit(39, "12 8 8 17 17 17 8 8", "0 1 1 0 0 0 1 1"), 2);
  });
  it("without solo flags the old fit applies", () => {
    assert.equal(fit(39, H, "0 0 0 0 0 0 0 0 0 0 0 0"), 2);
  });
  it("short panes keep their old page sizes (solo never makes a page taller than the room)", () => {
    assert.equal(fit(21, H, SOLO), 1);
    assert.equal(fit(27, H, SOLO), 2);
    assert.equal(fit(32, H, SOLO), 2);
  });
  it("a roomy pane still fits more than three", () => {
    assert.ok(fit(46, "8 8 8 8 8 8 8 8", "1 1 1 1 1 1 1 1") >= 4);
  });
  it("cell_block draws a solo tile without the status and role rows, only when asked", () => {
    const src = readFileSync(pane, "utf8");
    assert.match(src, /\[ "\$\{15:-0\}" = 1 \] && solo=1/);
    assert.equal((src.match(/if \[ "\$solo" != 1 \]; then/g) || []).length, 4);
    assert.match(src, /solo_i=\$\(\(end - 1\)\)\n\s+page_h=\$\(\(page_h - 2\)\)/);
  });
});
