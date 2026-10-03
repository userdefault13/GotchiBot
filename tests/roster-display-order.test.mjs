/**
 * Settings reorder writes the project roster sequence, and the avatar strip
 * reads that sequence (pinned orchestrator stays pinned, just not in the strip).
 *   node --test tests/roster-display-order.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeRosterHeroes, moveRosterHero } from "../scripts/project-context.mjs";
import { othersInDisplayOrder } from "../scripts/avatar-roster.mjs";

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
});
