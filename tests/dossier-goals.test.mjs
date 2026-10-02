/**
 * One current dossier goal. Temp directory only — never the checkout sessions/ tree.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setDossierGoal,
  clearDossierGoal,
  recordMilestone,
  goalShowText,
} from "../scripts/pstack-dossier.mjs";

const root = mkdtempSync(join(tmpdir(), "gotchi-goals-"));
const slug = "goal-fixture";
const projectDir = join(root, "sessions", "pstack", slug);

function dossierFile() {
  return join(projectDir, "dossier.json");
}

function milestoneFile() {
  return join(projectDir, "milestones.json");
}

function writeDossier(goal) {
  mkdirSync(projectDir, { recursive: true });
  const dossier = {
    slug,
    schemaVersion: 1,
    status: "draft",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    fields: { goal, title: "Fixture" },
  };
  writeFileSync(dossierFile(), `${JSON.stringify(dossier, null, 2)}\n`);
  return dossierFile();
}

describe("dossier goals", () => {
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("set replaces fields.goal and does not create milestones.json", () => {
    writeDossier("old goal");
    rmSync(milestoneFile(), { force: true });
    const result = setDossierGoal({ root, slug, text: "  ship the pane  " });
    assert.equal(result.ok, true);
    assert.equal(result.goal, "ship the pane");
    const dossier = JSON.parse(readFileSync(dossierFile(), "utf8"));
    assert.equal(dossier.fields.goal, "ship the pane");
    assert.equal(dossier.fields.title, "Fixture");
    assert.equal(dossier.milestones, undefined);
    assert.equal(existsSync(milestoneFile()), false);
  });

  it("empty and whitespace set writes nothing", () => {
    const path = writeDossier("keep me");
    const before = readFileSync(path);
    rmSync(milestoneFile(), { force: true });
    for (const text of ["", "   ", "\n\t", " \n "]) {
      const result = setDossierGoal({ root, slug, text });
      assert.equal(result.ok, false);
      assert.equal(result.reason, "empty goal");
      assert.deepEqual(readFileSync(path), before);
    }
    assert.equal(existsSync(milestoneFile()), false);
  });

  it("edit changes the goal in place and does not append a milestone", () => {
    writeDossier("first");
    const prior = {
      project: slug,
      milestones: [{ id: "older", goal: "done", completedAt: "2026-01-01T00:00:00.000Z" }],
    };
    writeFileSync(milestoneFile(), `${JSON.stringify(prior, null, 2)}\n`);
    const beforeMilestones = readFileSync(milestoneFile());

    const edited = setDossierGoal({ root, slug, text: "  revised goal  " });
    assert.equal(edited.ok, true);
    assert.equal(edited.goal, "revised goal");
    const dossier = JSON.parse(readFileSync(dossierFile(), "utf8"));
    assert.equal(dossier.fields.goal, "revised goal");
    assert.equal(dossier.fields.title, "Fixture");
    assert.deepEqual(readFileSync(milestoneFile()), beforeMilestones);

    rmSync(milestoneFile(), { force: true });
    const again = setDossierGoal({ root, slug, text: "still editing" });
    assert.equal(again.ok, true);
    assert.equal(JSON.parse(readFileSync(dossierFile(), "utf8")).fields.goal, "still editing");
    assert.equal(existsSync(milestoneFile()), false);
  });

  it("clear sets fields.goal to empty and does not create milestones.json", () => {
    writeDossier("to clear");
    rmSync(milestoneFile(), { force: true });
    const cleared = clearDossierGoal({ root, slug });
    assert.equal(cleared.fields.goal, "");
    assert.equal(JSON.parse(readFileSync(dossierFile(), "utf8")).fields.goal, "");
    assert.equal(existsSync(milestoneFile()), false);

    clearDossierGoal({ root, slug });
    assert.equal(JSON.parse(readFileSync(dossierFile(), "utf8")).fields.goal, "");
    assert.equal(existsSync(milestoneFile()), false);
  });

  it("show helper returns the trimmed goal or goal is empty", () => {
    writeDossier("  ship it  ");
    const raw = JSON.parse(readFileSync(dossierFile(), "utf8")).fields.goal;
    assert.equal(goalShowText(raw), "ship it");
    assert.equal(goalShowText("  ship it  "), "ship it");
    assert.equal(goalShowText(""), "goal is empty");
    assert.equal(goalShowText("   "), "goal is empty");
    assert.equal(goalShowText(undefined), "goal is empty");
    assert.equal(goalShowText(null), "goal is empty");
  });

  it("complete records a milestone and a blank goal writes nothing", () => {
    writeDossier("ship the pane");
    rmSync(milestoneFile(), { force: true });
    const result = recordMilestone({
      root,
      slug,
      completedAt: "2026-06-01T12:00:00.000Z",
    });
    assert.equal(result.ok, true);
    assert.equal(result.milestone.goal, "ship the pane");
    assert.equal(result.milestone.completedAt, "2026-06-01T12:00:00.000Z");
    assert.match(result.milestone.id, /^[a-f0-9]{8}$/);
    assert.deepEqual(Object.keys(result.milestone).sort(), ["completedAt", "goal", "id"]);

    const store = JSON.parse(readFileSync(milestoneFile(), "utf8"));
    assert.equal(store.project, slug);
    assert.equal(store.milestones.length, 1);
    assert.equal(store.milestones[0].goal, "ship the pane");
    assert.equal(store.milestones[0].completedAt, "2026-06-01T12:00:00.000Z");
    const dossier = JSON.parse(readFileSync(dossierFile(), "utf8"));
    assert.equal(dossier.fields.goal, "");
    assert.equal(dossier.fields.title, "Fixture");

    writeDossier("   ");
    rmSync(milestoneFile(), { force: true });
    const before = readFileSync(dossierFile());
    const blank = recordMilestone({ root, slug });
    assert.equal(blank.ok, false);
    assert.equal(blank.reason, "empty goal");
    assert.equal(existsSync(milestoneFile()), false);
    assert.deepEqual(readFileSync(dossierFile()), before);
  });
});
