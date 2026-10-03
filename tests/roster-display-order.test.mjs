/**
 * Settings reorder writes the project roster sequence, and the avatar strip
 * reads that sequence (pinned orchestrator stays pinned, just not in the strip).
 *   node --test tests/roster-display-order.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mergeRosterHeroes, moveRosterHero, placeRosterHero } from "../scripts/project-context.mjs";
import { othersInDisplayOrder } from "../scripts/avatar-roster.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("roster display order", () => {
  it("moves a row up or down and keeps its project role", () => {
    const start = [
      { id: "owned-1", role: "architect" },
      { id: "owned-2", role: null },
      { id: "owned-3", role: "scribe" },
    ];
    const down = moveRosterHero(start, "owned-1", 1);
    assert.deepEqual(down, [
      { id: "owned-2", role: null },
      { id: "owned-1", role: "architect" },
      { id: "owned-3", role: "scribe" },
    ]);
    const up = moveRosterHero(down, "owned-3", -1);
    assert.equal(up[1].id, "owned-3");
    assert.equal(up[1].role, "scribe");
    assert.deepEqual(moveRosterHero(start, "owned-1", -1).map((h) => h.id), ["owned-1", "owned-2", "owned-3"]);
    assert.deepEqual(moveRosterHero(start, "owned-3", 1).map((h) => h.id), ["owned-1", "owned-2", "owned-3"]);
    assert.deepEqual(moveRosterHero(start, "missing", -1).map((h) => h.id), ["owned-1", "owned-2", "owned-3"]);
  });

  it("avatar roster display reads the saved project order", () => {
    const chain = [
      { id: "owned-1", name: "A" },
      { id: "owned-2", name: "B" },
      { id: "owned-3", name: "C" },
      { id: "owned-9", name: "extra" },
    ];
    const saved = mergeRosterHeroes(moveRosterHero(
      [
        { id: "owned-1", role: "architect" },
        { id: "owned-2", role: null },
        { id: "owned-3", role: "scribe" },
      ],
      "owned-3",
      -2,
    ), []);
    assert.deepEqual(saved.map((h) => h.id), ["owned-3", "owned-1", "owned-2"]);
    assert.equal(saved[0].role, "scribe");
    // owned-1 is the orchestrator pin: strip shows the rest in saved order,
    // then any gotchi the project file does not list.
    assert.deepEqual(othersInDisplayOrder(chain, "owned-1", saved.map((h) => h.id)), [
      "owned-3",
      "owned-2",
      "owned-9",
    ]);
    assert.deepEqual(othersInDisplayOrder(chain, "owned-1", []), ["owned-2", "owned-3", "owned-9"]);
  });

  it("puts a gotchi at a typed position, rejects out of range, and does not revert on the next place", () => {
    const start = Array.from({ length: 30 }, (_, i) => ({
      id: `owned-${i + 1}`,
      role: i === 29 ? "scribe" : null,
    }));
    const moved = placeRosterHero(start, "owned-30", 29);
    assert.equal(moved[28].id, "owned-30");
    assert.equal(moved[28].role, "scribe");
    assert.equal(moved[29].id, "owned-29");
    // Re-merging the previous id sequence (avatar cache or sorted main roster)
    // must not put the saved row back where it was.
    const reread = mergeRosterHeroes(moved, start.map((h) => h.id));
    assert.deepEqual(reread.map((h) => h.id), moved.map((h) => h.id));
    // Moving another gotchi must not swap owned-30 back to position 30.
    const second = placeRosterHero(reread, "owned-1", 2);
    assert.equal(second[28].id, "owned-30");
    assert.equal(second[28].role, "scribe");
    assert.equal(second[0].id, "owned-2");
    assert.equal(second[1].id, "owned-1");
    // Moving the same gotchi again goes further, it does not snap back to 30.
    const further = placeRosterHero(second, "owned-30", 28);
    assert.equal(further[27].id, "owned-30");
    assert.notEqual(further.findIndex((h) => h.id === "owned-30"), 29);
    assert.deepEqual(placeRosterHero(further, "owned-30", 0).map((h) => h.id), further.map((h) => h.id));
    assert.deepEqual(placeRosterHero(further, "owned-30", 31).map((h) => h.id), further.map((h) => h.id));
    assert.deepEqual(placeRosterHero(further, "owned-30", 1.5).map((h) => h.id), further.map((h) => h.id));
    assert.deepEqual(placeRosterHero(further, "missing", 4).map((h) => h.id), further.map((h) => h.id));
    const chain = further.map((h) => ({ id: h.id, name: h.id }));
    assert.equal(othersInDisplayOrder(chain, "owned-1", further.map((h) => h.id))[26], "owned-30");
  });

  it("an open avatar pane reloads roster.json instead of keeping the previous strip", () => {
    const pane = readFileSync(path.join(root, "scripts/avatar-pane.sh"), "utf8");
    const loopAt = pane.indexOf("while true; do");
    const fpAt = pane.indexOf('fp="$(state_fingerprint)"', loopAt);
    assert.ok(loopAt > 0 && fpAt > loopAt, "watch loop fingerprints after the order check");
    const beforeFp = pane.slice(loopAt, fpAt);
    assert.match(beforeFp, /refresh_roster_for_order/);
    assert.match(pane, /pstack\/\$\{slug\}\/roster\.json/);
    const safeAt = pane.indexOf("safe_render()");
    const safe = pane.slice(safeAt, pane.indexOf("on_usr1()", safeAt));
    const memoAt = safe.indexOf("memo_reset_if_stale");
    assert.ok(memoAt > 0);
    assert.match(safe.slice(0, memoAt), /refresh_roster_for_order/);
    // The id memo has to include the payload. A bare "ids" key replayed the old strip.
    assert.match(pane, /ids_key="ids\|/);

    const bin = path.join(root, "scripts/avatar-pane.sh");
    const decision = (current, prev) =>
      execFileSync("bash", [bin, "roster-order-check", current, prev], {
        cwd: root,
        encoding: "utf8",
      }).trim();
    assert.equal(decision("bbbb", "aaaa"), "refresh");
    assert.equal(decision("aaaa", "aaaa"), "keep");

    const chain = [
      { id: "owned-1", name: "orch" },
      { id: "owned-2", name: "B" },
      { id: "owned-3", name: "C" },
      { id: "owned-9", name: "extra" },
    ];
    const before = [
      { id: "owned-1", role: null },
      { id: "owned-2", role: null },
      { id: "owned-3", role: "scribe" },
    ];
    const stale = othersInDisplayOrder(chain, "owned-1", before.map((h) => h.id));
    const saved = placeRosterHero(before, "owned-3", 1);
    assert.equal(saved[0].id, "owned-3");
    assert.equal(saved[0].role, "scribe");
    // What the strip paints: keep would leave the pre-save order; refresh
    // reads the heroes array just written (orchestrator pin stays out).
    const painted = decision("bbbb", "aaaa") === "refresh"
      ? othersInDisplayOrder(chain, "owned-1", saved.map((h) => h.id))
      : stale;
    assert.notDeepEqual(painted, stale);
    assert.deepEqual(painted, ["owned-3", "owned-2", "owned-9"]);
    assert.equal(painted.includes("owned-1"), false);
  });
});
