/**
 * Milestones live beside the dossier, never inside it.
 * Temp directory only — never the checkout sessions/ tree.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordMilestone } from "../scripts/pstack-dossier.mjs";
import { buildMilestonesPanelBody } from "../scripts/pstack-window.mjs";

const root = mkdtempSync(join(tmpdir(), "gotchi-milestones-"));
const slug = "ms-fixture";
const projectDir = join(root, "sessions", "pstack", slug);

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
  writeFileSync(join(projectDir, "dossier.json"), `${JSON.stringify(dossier, null, 2)}\n`);
  writeFileSync(join(root, "sessions", ".pstack-dossier-current"), `${slug}\n`);
}

describe("dossier milestones", () => {
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("appends the goal, clears fields.goal, and keeps the milestone file shape", () => {
    writeDossier("ship the pane");
    writeFileSync(
      join(projectDir, "milestones.json"),
      `${JSON.stringify(
        {
          project: slug,
          milestones: [
            { id: "older", goal: "first mark", completedAt: "2026-01-01T00:00:00.000Z" },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const result = recordMilestone({
      root,
      completedAt: "2026-06-01T12:00:00.000Z",
    });
    assert.equal(result.ok, true);
    assert.equal(result.project, slug);
    assert.equal(result.milestone.goal, "ship the pane");
    assert.equal(result.milestone.completedAt, "2026-06-01T12:00:00.000Z");
    assert.match(result.milestone.id, /^[a-f0-9]{8}$/);

    const store = JSON.parse(readFileSync(join(projectDir, "milestones.json"), "utf8"));
    assert.deepEqual(Object.keys(store).sort(), ["milestones", "project"]);
    assert.equal(store.project, slug);
    assert.equal(store.milestones.length, 2);
    assert.equal(store.milestones[0].goal, "first mark");
    const added = store.milestones[1];
    assert.equal(added.goal, "ship the pane");
    assert.equal(added.completedAt, "2026-06-01T12:00:00.000Z");
    assert.equal(typeof added.id, "string");
    assert.ok(added.id.length > 0);
    assert.deepEqual(Object.keys(added).sort(), ["completedAt", "goal", "id"]);

    const dossier = JSON.parse(readFileSync(join(projectDir, "dossier.json"), "utf8"));
    assert.equal(dossier.fields.goal, "");
    assert.equal(dossier.fields.title, "Fixture");
    assert.equal(dossier.milestones, undefined);
  });

  it("does not append a blank milestone when the goal is whitespace", () => {
    writeDossier("   ");
    const milestoneFile = join(projectDir, "milestones.json");
    rmSync(milestoneFile, { force: true });
    const result = recordMilestone({ root, slug });
    assert.equal(result.ok, false);
    assert.equal(existsSync(milestoneFile), false);
    const dossier = JSON.parse(readFileSync(join(projectDir, "dossier.json"), "utf8"));
    assert.equal(dossier.fields.goal, "   ");
  });

  it("lists newest completedAt first and dims an empty pane", () => {
    const rows = buildMilestonesPanelBody(
      [
        { id: "a", goal: "older goal", completedAt: "2026-01-01T00:00:00.000Z" },
        { id: "b", goal: "newer goal", completedAt: "2026-06-01T00:00:00.000Z" },
      ],
      80,
    );
    const text = rows.join("\n");
    assert.ok(text.indexOf("newer goal") !== -1);
    assert.ok(text.indexOf("older goal") !== -1);
    assert.ok(text.indexOf("newer goal") < text.indexOf("older goal"));

    const empty = buildMilestonesPanelBody([], 80);
    assert.match(empty.join("\n"), /\u001b\[2mno milestones/);
  });
});
