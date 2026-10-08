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

  it("lets a meeting propose WondrStack status / launch / login, not raw tool calls", () => {
    assert.equal(normalizeAction("gotchibot wondrstack launch gotchibot").allowed, true);
    assert.equal(normalizeAction("./scripts/gotchibot wondrstack status aarcadeghst").allowed, true);
    assert.equal(normalizeAction("./scripts/gotchibot wondrstack login gotchibot").allowed, true);
    assert.equal(normalizeAction("./scripts/gotchibot wondrstack call gotchibot deploy_app").allowed, false);
    assert.equal(normalizeAction("./scripts/gotchibot wondrstack logout gotchibot").allowed, false);
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

describe("meetings speak for their project", () => {
  it("every turn opens with the project, and says other projects' notes do not apply", async () => {
    const { meetProjectFrame } = await import("../scripts/gotchi-meet.mjs");
    assert.deepEqual(meetProjectFrame("owned-1", null), [], "no project, no frame");
    const meet = readFileSync(path.join(root, "scripts/gotchi-meet.mjs"), "utf8");
    const fn = meet.slice(meet.indexOf("async function agentReply"), meet.indexOf("function withProposedAction"));
    assert.match(fn, /\.\.\.meetProjectFrame\(speakerId, slug\)/);
    assert.match(fn, /slug !== "aarcadeghst"/, "the arcade-written autonomy line only inside aarcadeghst");
    const frameSrc = meet.slice(meet.indexOf("export function meetProjectFrame"), meet.indexOf("export const MEET_ACTION_RULE"));
    assert.match(frameSrc, /about \$\{title\} only/);
    assert.match(frameSrc, /do not apply here/);
    const cos = readFileSync(path.join(root, "config/openclaw/templates/AGENTS.chief-of-staff.md"), "utf8");
    assert.doesNotMatch(cos.split("\n").slice(0, 5).join("\n"), /AarcadeGh-t \/ GotchiBot fleet/);
  });
});

describe("proposals are the room's, not copies", () => {
  it("drops ▶ Proposed / /run lines a gotchi copied, keeps its words and real ACTION lines", async () => {
    const { stripCopiedProposals } = await import("../scripts/gotchi-meet.mjs");
    const reply = [
      "I've proposed the login below.",
      "▶ Proposed: ./scripts/gotchibot seat owned-12444 project-manager",
      "/run to run it · /skip to drop it",
      "▶ Proposed 1/2: ./scripts/gotchibot wondrstack login gotchibot",
      "ACTION: ./scripts/gotchibot wondrstack login gotchibot",
    ].join("\n");
    const out = stripCopiedProposals(reply);
    assert.doesNotMatch(out, /▶ Proposed|\/run to run/);
    assert.match(out, /I've proposed the login below\./);
    assert.match(out, /^ACTION: \.\/scripts\/gotchibot wondrstack login gotchibot$/m);
    const meet = readFileSync(path.join(root, "scripts/gotchi-meet.mjs"), "utf8");
    assert.match(meet, /writeJson\(pendingActionPath\(meetingsRoot\(\), meeting\.id\), \{ actions: queue \}\)/, "several proposals queue up");
    assert.match(meet, /const act = queue\.shift\(\)/, "/run takes the oldest");
  });
});
