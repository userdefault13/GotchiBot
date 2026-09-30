/**
 * A project roster is a copy of the main roster. Roles stored on it belong
 * to that project only.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeRosterHeroes, normalizeRosterHero } from "../scripts/project-context.mjs";

describe("project roster", () => {
  it("reads a bare id as unassigned", () => {
    assert.deepEqual(normalizeRosterHero("owned-22899"), { id: "owned-22899", role: null });
    assert.deepEqual(normalizeRosterHero({ id: "owned-22899", role: "architect" }), {
      id: "owned-22899",
      role: "architect",
    });
    assert.equal(normalizeRosterHero({ id: "owned-22899", role: "none" }).role, null);
  });

  it("copies every main-roster gotchi in unassigned and keeps a role this project already stored", () => {
    const heroes = mergeRosterHeroes(
      [{ id: "owned-22899", role: "architect" }, "owned-954"],
      ["owned-22899", "owned-954", "owned-5041"],
    );
    assert.deepEqual(heroes, [
      { id: "owned-22899", role: "architect" },
      { id: "owned-954", role: null },
      { id: "owned-5041", role: null },
    ]);
  });

  it("does not copy a role from another list onto a gotchi that is only an id", () => {
    const projectB = mergeRosterHeroes(["owned-22899"], ["owned-22899"]);
    assert.equal(projectB[0].role, null);
  });
});
