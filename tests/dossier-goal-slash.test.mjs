/**
 * Slash parser for dossier goal verbs. Temp directory only — never this repo's sessions/.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDossierGoalSlash } from "../scripts/dossier-goal-slash.mjs";
import { setDossierGoal } from "../scripts/pstack-dossier.mjs";

const VERB_LIST = /set\|edit\|complete\|show\|clear/;

describe("parseDossierGoalSlash", () => {
  const mapped = [
    ["/dossier goal set hello world", ["goal", "set", "hello world"]],
    ["/dossier goal edit hello world", ["goal", "edit", "hello world"]],
    ["/dossier goal complete", ["goal", "complete"]],
    ["/dossier goal show", ["goal", "show"]],
    ["/dossier goal clear", ["goal", "clear"]],
    ["/dossier milestone", ["milestone"]],
    ["/dossier goal milestone", ["milestone"]],
  ];

  for (const [input, argv] of mapped) {
    it(`maps ${input}`, () => {
      assert.deepEqual(parseDossierGoalSlash(input), { ok: true, argv });
    });
  }

  it("keeps internal spaces in goal text", () => {
    assert.deepEqual(parseDossierGoalSlash("/dossier goal set ship the pane"), {
      ok: true,
      argv: ["goal", "set", "ship the pane"],
    });
    assert.deepEqual(parseDossierGoalSlash("/dossier goal edit ship  the   pane"), {
      ok: true,
      argv: ["goal", "edit", "ship  the   pane"],
    });
  });

  it("treats verbs as case-insensitive and keeps goal text case", () => {
    assert.deepEqual(parseDossierGoalSlash("/Dossier Goal SET Hello"), {
      ok: true,
      argv: ["goal", "set", "Hello"],
    });
    assert.deepEqual(parseDossierGoalSlash("/DOSSIER MILESTONE"), {
      ok: true,
      argv: ["milestone"],
    });
    assert.deepEqual(parseDossierGoalSlash("/dossier GOAL Milestone"), {
      ok: true,
      argv: ["milestone"],
    });
  });

  it("ignores slash lines whose first token is not dossier", () => {
    assert.equal(parseDossierGoalSlash("/goal ship it"), null);
    assert.equal(parseDossierGoalSlash("/goal"), null);
    assert.equal(parseDossierGoalSlash("plain text"), null);
    assert.equal(parseDossierGoalSlash("/goals set hello"), null);
  });

  it("rejects empty and whitespace-only set/edit without argv", () => {
    for (const input of [
      "/dossier goal set",
      "/dossier goal set   ",
      "/dossier goal set \t",
      "/dossier goal edit",
      "/dossier goal edit    ",
      "/dossier goal edit \n\t",
      "/dossier goal SET   \n",
    ]) {
      assert.deepEqual(parseDossierGoalSlash(input), { ok: false, error: "empty goal" });
    }
  });

  it("lists verbs for bare /dossier and /dossier goal", () => {
    for (const input of ["/dossier", "/dossier goal", "/dossier   ", "  /dossier goal  "]) {
      const result = parseDossierGoalSlash(input);
      assert.equal(result.ok, false);
      assert.match(result.error, VERB_LIST);
      assert.match(result.error, /milestone/);
      assert.equal(result.argv, undefined);
    }
  });

  it("rejects unknown verbs and extra arguments without argv", () => {
    for (const input of [
      "/dossier nope",
      "/dossier goal nope",
      "/dossier goal complete extra",
      "/dossier goal show extra",
      "/dossier goal clear extra",
      "/dossier milestone extra",
      "/dossier goal milestone extra",
    ]) {
      const result = parseDossierGoalSlash(input);
      assert.equal(result.ok, false);
      assert.equal(typeof result.error, "string");
      assert.notEqual(result.error, "");
      assert.equal(result.argv, undefined);
    }
  });
});

describe("empty setDossierGoal writes nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "gotchi-dossier-slash-"));
  const slug = "goal-fixture";
  const projectDir = join(root, "sessions", "pstack", slug);

  function dossierFile() {
    return join(projectDir, "dossier.json");
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

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("empty and whitespace set leaves dossier bytes unchanged", () => {
    const path = writeDossier("keep me");
    const before = readFileSync(path);
    for (const text of ["", "   ", "\n\t", " \n "]) {
      const result = setDossierGoal({ root, slug, text });
      assert.equal(result.ok, false);
      assert.equal(result.reason, "empty goal");
      assert.deepEqual(readFileSync(path), before);
    }
  });
});
