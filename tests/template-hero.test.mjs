/**
 * Seating a marketplace template creates a hero (and binds a cached cAavegotchi
 * as its worker). Temp dirs only — the live aarcadeghst roster is never written.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRosterHero } from "../scripts/project-context.mjs";
import {
  listSeatableTemplates,
  resolveTemplateAvatar,
  seatTemplate,
} from "../scripts/template-hero.mjs";

const root = new URL("..", import.meta.url).pathname;

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "template-hero-"));
  const sessions = join(dir, "sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, ".pin"), "owned-111\n");
  return {
    dir,
    sessions,
    roster: join(dir, "roster.json"),
    pin: join(sessions, ".pin"),
  };
}

describe("template heroes", () => {
  it("seats accountant with a bound worker when a gotchi id is provided, and an unbound slot when it is not", () => {
    const bound = scratch();
    const seated = seatTemplate("accountant", {
      root,
      sessionsDir: bound.sessions,
      rosterPath: bound.roster,
      gotchiId: "owned-22899",
    });
    assert.equal(seated.heroes.length, 1);
    const hero = seated.heroes[0];
    assert.equal(hero.id, "accountant");
    assert.equal(hero.role, "accountant");
    assert.equal(hero.name, "Accountant");
    assert.deepEqual(hero.worker, { status: "bound", gotchiId: "owned-22899" });

    const onDisk = JSON.parse(readFileSync(bound.roster, "utf8"));
    assert.equal(onDisk.heroes[0].worker.gotchiId, "owned-22899");
    assert.equal(readFileSync(bound.pin, "utf8"), "owned-111\n");

    const open = scratch();
    const empty = seatTemplate("accountant", {
      root,
      sessionsDir: open.sessions,
      rosterPath: open.roster,
    });
    assert.deepEqual(empty.heroes[0].worker, { status: "unbound", gotchiId: null });
    const text = readFileSync(open.roster, "utf8");
    assert.equal(JSON.parse(text).heroes[0].worker.status, "unbound");
    assert.doesNotMatch(text, /owned-\d+/);
    assert.equal(readFileSync(open.pin, "utf8"), "owned-111\n");
  });

  it("binds a gotchi that is already in the local subgraph cache and skips one that is not available", () => {
    const dir = scratch();
    writeFileSync(
      join(dir.sessions, ".wallet-gotchis.json"),
      JSON.stringify({ gotchis: [{ gotchiId: "5041", name: "Cached" }] }),
    );
    writeFileSync(
      join(dir.sessions, ".hero-agent-state.json"),
      JSON.stringify({ "owned-999": { status: "working" } }),
    );
    const seated = seatTemplate("accountant", {
      root,
      sessionsDir: dir.sessions,
      rosterPath: dir.roster,
    });
    assert.equal(seated.heroes[0].worker.gotchiId, "owned-5041");
    assert.equal(readFileSync(dir.pin, "utf8"), "owned-111\n");
  });

  it("resolves the avatar path to assets/templates/<id>.png and falls back to the glyph when the file is absent", () => {
    const missing = resolveTemplateAvatar("accountant", { root });
    assert.equal(missing.path, "assets/templates/accountant.png");
    assert.equal(missing.ready, false);
    assert.equal(missing.display, "glyph");

    const fake = mkdtempSync(join(tmpdir(), "template-avatar-"));
    const rel = "assets/templates/accountant.png";
    mkdirSync(join(fake, "assets", "templates"), { recursive: true });
    writeFileSync(join(fake, rel), "");
    const ready = resolveTemplateAvatar("accountant", { root: fake });
    assert.equal(ready.path, "assets/templates/accountant.png");
    assert.equal(ready.display, "assets/templates/accountant.png");
    assert.equal(ready.ready, true);
  });

  it("seats bend-crew as three heroes, not one", () => {
    const dir = scratch();
    const seated = seatTemplate("bend-crew", {
      root,
      sessionsDir: dir.sessions,
      rosterPath: dir.roster,
    });
    assert.equal(seated.kind, "suite");
    assert.deepEqual(
      seated.heroes.map((h) => h.id),
      ["bend-chief", "bend-laws", "bend-proofs"],
    );
    assert.equal(seated.heroes.some((h) => h.id === "bend-crew"), false);
    for (const hero of seated.heroes) {
      assert.equal(hero.worker.status, "unbound");
      assert.equal(hero.role, hero.id);
      assert.ok(hero.name);
    }
  });

  it("rejects prof-link-cube and does not invent arcade games", () => {
    assert.throws(() => seatTemplate("prof-link-cube", { root, sessionsDir: scratch().sessions }), /built-in fleet hero/);
    const listed = listSeatableTemplates({ root });
    assert.equal(listed.some((t) => t.id === "prof-link-cube"), false);
    assert.equal(listed.some((t) => t.id === "project-manager"), true);
    const suite = listed.find((t) => t.id === "bend-crew");
    assert.equal(suite.kind, "suite");
    assert.deepEqual(suite.members, ["bend-chief", "bend-laws", "bend-proofs"]);

    const arcade = seatTemplate("arcade-game-monitor", {
      root,
      sessionsDir: scratch().sessions,
    });
    assert.equal(arcade.heroes.length, 1);
    assert.equal(arcade.heroes[0].id, "arcade-game-monitor");

    const pm = seatTemplate("project-manager", { root, sessionsDir: scratch().sessions });
    assert.equal(pm.heroes[0].id, "project-manager");
    assert.equal(pm.heroes[0].name, "Project Manager");
  });

  it("refuses the live aarcadeghst roster and keeps worker fields on a roster row", () => {
    const box = scratch();
    const live = join(box.dir, "aarcadeghst", "roster.json");
    assert.throws(
      () => seatTemplate("accountant", { root, sessionsDir: box.sessions, rosterPath: live, gotchiId: "owned-1" }),
      /aarcadeghst/,
    );
    assert.deepEqual(
      normalizeRosterHero({
        id: "accountant",
        role: "accountant",
        name: "Accountant",
        worker: { status: "bound", gotchiId: "owned-22899" },
      }),
      {
        id: "accountant",
        role: "accountant",
        name: "Accountant",
        worker: { status: "bound", gotchiId: "owned-22899" },
      },
    );
  });
});
