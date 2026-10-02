/**
 * Factory unit state follows the live session, not a stale units.tsv row.
 *   node --test tests/factory-live-status.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapUnitState } from "../scripts/factory-window.mjs";

const RUNNING = /^(running|claimed|working|active|busy)$/i;

describe("mapUnitState", () => {
  it("shows the live session status when a session id is present", () => {
    assert.equal(mapUnitState("running", "s20260916-105038-47170", "failed"), "failed");
    assert.equal(mapUnitState("running", "s20260918-010917-73840", "done"), "done");
    assert.equal(mapUnitState("done", "s20260918-104840-27520", "failed"), "failed");
  });

  it("does not call a failed or done session running", () => {
    assert.equal(RUNNING.test(mapUnitState("running", "s-egg", "failed")), false);
    assert.equal(RUNNING.test(mapUnitState("running", "s-ja2", "done")), false);
    assert.equal(RUNNING.test(mapUnitState("running", "s-live", "running")), true);
  });

  it("keeps the tsv state when there is no session id or no live status", () => {
    assert.equal(mapUnitState("running", "", "failed"), "running");
    assert.equal(mapUnitState("queued", "", ""), "queued");
    assert.equal(mapUnitState("idle", "s-missing", ""), "idle");
    assert.equal(mapUnitState("todo", null, null), "todo");
  });
});
