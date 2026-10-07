/**
 * Hero box: a template hero's wearable over its cAavegotchi worker, in a dashed
 * frame (avatar pane). Wearable art is scaled to fit; every frame row is the
 * same width.
 *   node --test tests/hero-box.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fitCells, parseCells, renderCells, wearableArt, wearableFor } from "../scripts/hero-wearable.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

describe("hero wearable art", () => {
  const w = { ascii: "ab\ncd", markup: '<span style="color:#ff0000">a</span>b\n<span style="color:#000000">cd</span>' };

  it("reads colored markup into cells and renders it back", () => {
    const grid = parseCells(w);
    assert.deepEqual(grid[0], [{ ch: "a", color: "#ff0000" }, { ch: "b", color: null }]);
    const lines = renderCells(grid, "truecolor");
    assert.equal(strip(lines[0]), "ab");
    assert.match(lines[1], /38;2;90;90;90/, "black ink shows as grey");
    assert.equal(renderCells(grid, "none")[0], "ab");
  });

  it("shrinks each axis on its own, never grows, and drops blank edge rows", () => {
    const tall = Array.from({ length: 19 }, () => [...".#."].map((ch) => ({ ch, color: null })));
    const fit = fitCells([[{ ch: " ", color: null }], ...tall], 5, 16);
    assert.equal(fit.length, 5);
    assert.equal(fit[0].length, 3, "a tall staff keeps its width");
    assert.deepEqual(fitCells(tall.slice(0, 2), 5, 16), tall.slice(0, 2));
  });

  it("draws a real wearable inside the box size; no wearable draws nothing", () => {
    if (!wearableFor("architect")) return;
    const lines = wearableArt("architect", { rows: 4, width: 10 });
    assert.ok(lines.length <= 4 && lines.length > 0);
    for (const l of lines) assert.ok([...strip(l)].length <= 10);
    assert.deepEqual(wearableArt("no-such-template"), []);
  });
});

describe("hero box in the avatar pane", () => {
  const harness = `
ROOT=${JSON.stringify(repo)}
TUI_COLOR=none; TUI_GLYPHS=unicode; ESC_CH=$'\\033'; VIS=0
AV_MUTED=""; AV_RST=""; AV_ROLE_GAL=""; AV_ROSTER=""; AV_ST_ASSIGN=""; AV_ST_AVAIL=""; AV_ST_WORKING=""; AV_ST_ACTIVE=""; AV_ST_IDLE=""; AV_ST_WATCH=""
ASCII_THUMB="$ROOT/assets/gotchi-thumb.ascii"
gotchi_art() { return 1; }
for f in vislen_set center_pad block_pad_line pad_cell_line repeat_char emit_line resolve_thumb_collateral thumb_art status_style tile_lines hero_box cell_block; do
  eval "$(awk -v n="$f" '$0 ~ "^"n"\\\\(\\\\) \\\\{" {p=1} p {print} p && /^}/ {exit}' "$ROOT/scripts/avatar-pane.sh")"
done
cell_block "$@"
`;
  const box = (...args) => {
    const r = spawnSync("bash", ["-c", harness, "hb", ...args], { encoding: "utf8", env: { ...process.env, LC_ALL: "en_US.UTF-8", PATH: "/usr/bin:/bin" } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trimEnd().split("\n");
  };

  it("frames wearable ▼ worker with name, role · status, worker · hat — every row the same width", () => {
    const lines = box("owned-954", "working", "", "22", "5", "", "", "DAI", "architect", "", "mini", "0", "Staff of Creation", "engineer");
    assert.match(lines[0], /^┌╌+┐$/);
    assert.match(lines.at(-1), /^└╌+┘$/);
    const widths = new Set(lines.map((l) => [...l].length));
    assert.deepEqual([...widths], [22]);
    const text = lines.join("\n");
    assert.match(text, /▼/);
    assert.match(text, /Staff of Creation/);
    assert.match(text, /\n╎ *architect *╎\n╎ *working *╎/);
    assert.match(text, /DAI · engineer/);
  });

  it("a hero with no worker shows an empty slot and says so", () => {
    const text = box("hero:kanban-manager", "needs-worker", "", "22", "5", "", "", "", "kanban-manager", "", "mini", "0", "1337 Laptop", "").join("\n");
    assert.match(text, /╎ \? ╎/);
    assert.match(text, /needs a worker/);
    assert.match(text, /asleep/);
  });

  it("in the focused grid (mid face) the wearable sits beside the worker, arrow between", () => {
    const lines = box("owned-954", "idle", "", "30", "9", "", "", "UNI", "architect", "", "mid", "0", "Staff of Creation", "");
    assert.deepEqual([...new Set(lines.map((l) => [...l].length))], [30], "every row the frame width");
    const arrowRow = lines.find((l) => l.includes("▶"));
    assert.ok(arrowRow, "a sideways arrow");
    assert.equal(lines.some((l) => l.includes("▼")), false, "no down arrow");
    assert.match(lines.join("\n"), /Staff of Creation\s*╎\n╎\s*architect\s*╎\n╎\s*idle/);
  });

  it("a gotchi with no hero keeps the plain tile", () => {
    const text = box("owned-3033", "available", "", "22", "5", "", "", "ART", "", "", "mini", "0", "", "").join("\n");
    assert.doesNotMatch(text, /┌/);
    assert.match(text, /no role/);
  });
});

describe("wearable height", () => {
  it("--exact draws the wearable exactly as tall as asked, growing small art", () => {
    const small = [[{ ch: "#", color: null }, { ch: "#", color: null }]];
    const up = fitCells(small, 5, 16, { exact: true });
    assert.equal(up.length, 5);
    assert.equal(up[0].length, 10, "width scales with height");
    const tall = Array.from({ length: 10 }, () => [...".#."].map((ch) => ({ ch, color: null })));
    assert.equal(fitCells(tall, 5, 16, { exact: true }).length, 5);
    assert.ok(fitCells(Array.from({ length: 2 }, () => Array(20).fill({ ch: "#", color: null })), 5, 12, { exact: true })[0].length <= 12, "still inside the box");
  });
});

describe("tall wearables", () => {
  it("shrinking to the box height keeps the width, so a staff keeps its shaft", () => {
    const staff = Array.from({ length: 19 }, (_, r) => [..."  ▐█▌  "].map((ch) => ({ ch: r === 0 ? "▄" : ch, color: null })));
    const fit = fitCells(staff, 5, 21, { exact: true });
    assert.equal(fit.length, 5);
    assert.equal(fit[0].length, 7);
    assert.ok(fit.slice(1).every((row) => row.some((c) => c.ch === "█")), "the shaft survives");
  });
});
