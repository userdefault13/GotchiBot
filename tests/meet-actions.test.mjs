/**
 * Meeting gotchis propose commands (ACTION: …); UserDefault runs them with /run.
 *   node --test tests/meet-actions.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractActions, normalizeAction, pendingActionPath } from "../scripts/lib/meet-actions.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("meeting actions", () => {
  it("takes seat commands, normalized to ./scripts/gotchibot", () => {
    assert.deepEqual(normalizeAction("./scripts/gotchibot heroes bind chief-of-staff owned-12302"), {
      cmd: "./scripts/gotchibot heroes bind chief-of-staff owned-12302",
      allowed: true,
    });
    assert.equal(normalizeAction("gotchibot seat owned-954 architect").cmd, "./scripts/gotchibot seat owned-954 architect");
    assert.equal(normalizeAction("`!gotchibot roles`").allowed, true);
  });

  it("refuses anything outside the allowlist or with shell syntax", () => {
    for (const bad of [
      "rm -rf ~",
      "./scripts/gotchibot spawn do things",
      "./scripts/gotchibot heroes bind x y; rm -rf ~",
      "./scripts/gotchibot heroes bind x $(whoami)",
      "./scripts/gotchibot heroes bind x y | sh",
      "./scripts/gotchibot heroes bind 'x' y",
      "gotchibotheroes",
    ]) {
      assert.equal(normalizeAction(bad).allowed, false, bad);
    }
  });

  it("splits ACTION lines out of a reply", () => {
    const r = extractActions("I'll seat User.Default as CoS.\nACTION: ./scripts/gotchibot heroes bind chief-of-staff owned-12302\n");
    assert.equal(r.text, "I'll seat User.Default as CoS.");
    assert.deepEqual(r.actions, [{ cmd: "./scripts/gotchibot heroes bind chief-of-staff owned-12302", allowed: true }]);
    assert.deepEqual(extractActions("just talk").actions, []);
    assert.equal(pendingActionPath("/m", "m1"), path.join("/m", "m1", "pending-action.json"));
  });

  it("is wired: proposals kept for /run, the rule says propose not do, the room has /run and /skip", async () => {
    const { MEET_ACTION_RULE } = await import("../scripts/gotchi-meet.mjs");
    assert.match(MEET_ACTION_RULE, /ACTION: \.\/scripts\/gotchibot/);
    assert.match(MEET_ACTION_RULE, /\/run/);
    assert.match(MEET_ACTION_RULE, /Never say something was done/);
    const meet = readFileSync(path.join(root, "scripts/gotchi-meet.mjs"), "utf8");
    assert.match(meet, /withProposedAction\(meeting, speakerId, said\)/);
    assert.match(meet, /if \(cmd === "action"\)/);
    const room = readFileSync(path.join(root, "scripts/meet-room-prompter.mjs"), "utf8");
    assert.match(room, /line === "\/run" \|\| line === "\/skip"/);
    assert.match(room, /tag: "\/run"/);
  });
});
