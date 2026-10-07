/**
 * Template heroes on a workbench: each hero (a template) is worked by one
 * cAavegotchi; old gotchi→role rooms convert with nobody losing their seat.
 * Scratch project rooms under sessions/pstack (removed after).
 *   node --test tests/hero-bench.test.mjs
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addHero,
  benchHeroes,
  benchPool,
  bindWorker,
  ensureProjectDirs,
  loadRoster,
  normalizeBench,
  projectRoles,
  removeHero,
  rosterAssign,
  unbindWorker,
} from "../scripts/project-context.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const made = [];
const slug = (tag) => {
  const s = `zz-hb-${tag}-${randomBytes(3).toString("hex")}`;
  made.push(s);
  return s;
};
const room = (s) => path.join(repo, "sessions", "pstack", s);
const onDisk = (s) => JSON.parse(readFileSync(path.join(room(s), "roster.json"), "utf8"));
after(() => {
  for (const s of made) rmSync(room(s), { recursive: true, force: true });
});
const global = { orchestrator: "orchestrator", "owned-22899": "orchestrator" };

describe("hero bench", () => {
  it("an old room converts: each seated gotchi works its role's hero, the rest are the pool", () => {
    const s = slug("conv");
    mkdirSync(room(s), { recursive: true });
    writeFileSync(
      path.join(room(s), "roster.json"),
      JSON.stringify({
        project: s,
        workbench: 1,
        heroes: [{ id: "owned-3033", role: "art-director" }, { id: "owned-954", role: "architect" }, { id: "owned-8532", role: null }],
      }),
    );
    const before = projectRoles(s, { roles: global });
    assert.deepEqual(loadRoster(s).bench, [
      { hero: "art-director", worker: "owned-3033" },
      { hero: "architect", worker: "owned-954" },
    ]);
    assert.deepEqual(benchPool(s), ["owned-8532"]);
    addHero("kanban-manager", s); // any write stores the bench
    assert.ok(Array.isArray(onDisk(s).bench));
    const after = projectRoles(s, { roles: global });
    assert.equal(after["owned-3033"], before["owned-3033"]);
    assert.equal(after["owned-954"], before["owned-954"]);
    assert.equal(after["owned-22899"], "orchestrator");
  });

  it("a hero with no worker is listed but gives no gotchi a role", () => {
    const s = slug("unb");
    ensureProjectDirs(s);
    addHero("kanban-manager", s);
    addHero("kanban-manager", s);
    const heroes = benchHeroes(s, { roles: global });
    assert.deepEqual(heroes[0], { hero: "orchestrator", worker: "owned-22899", deskWide: true });
    assert.deepEqual(heroes.slice(1), [{ hero: "kanban-manager", worker: null }], "added once");
    assert.equal(Object.values(projectRoles(s, { roles: global })).includes("kanban-manager"), false);
  });

  it("binding: one hero per gotchi here, a one-seat hero hands its seat over", () => {
    const s = slug("bind");
    ensureProjectDirs(s);
    bindWorker("architect", "owned-954", s);
    let r = bindWorker("architect", "owned-3033", s);
    assert.deepEqual(r.unseated, ["owned-954"]);
    assert.equal(projectRoles(s, { roles: global })["owned-954"], undefined, "back to the pool");
    r = bindWorker("art-director", "owned-3033", s);
    assert.equal(r.left, "architect");
    assert.deepEqual(loadRoster(s).bench, [
      { hero: "architect", worker: null },
      { hero: "art-director", worker: "owned-3033" },
    ]);
    assert.ok(benchPool(s).includes("owned-954"));
  });

  it("the same gotchi works different heroes in different projects", () => {
    const a = slug("pa");
    const b = slug("pb");
    ensureProjectDirs(a);
    ensureProjectDirs(b);
    bindWorker("architect", "owned-954", a);
    bindWorker("art-director", "owned-954", b);
    assert.equal(projectRoles(a, { roles: global })["owned-954"], "architect");
    assert.equal(projectRoles(b, { roles: global })["owned-954"], "art-director");
  });

  it("unbind keeps the hero; remove frees its worker; rosterAssign is a bench op", () => {
    const s = slug("un");
    ensureProjectDirs(s);
    rosterAssign("owned-954", "architect", s);
    assert.deepEqual(loadRoster(s).bench, [{ hero: "architect", worker: "owned-954" }]);
    unbindWorker("architect", s);
    assert.deepEqual(loadRoster(s).bench, [{ hero: "architect", worker: null }]);
    rosterAssign("owned-954", "architect", s);
    rosterAssign("owned-954", "none", s);
    assert.deepEqual(loadRoster(s).bench, [{ hero: "architect", worker: null }], "freeing the gotchi keeps the hero");
    bindWorker("architect", "owned-954", s);
    removeHero("architect", s);
    assert.deepEqual(loadRoster(s).bench, []);
    assert.ok(benchPool(s).includes("owned-954"));
  });

  it("refuses the orchestrator, unknown templates and non-gotchi workers", () => {
    const s = slug("bad");
    ensureProjectDirs(s);
    assert.throws(() => addHero("orchestrator", s), /desk-wide/);
    assert.throws(() => addHero("no-such-template", s), /unknown hero template/);
    assert.throws(() => bindWorker("architect", "prof-link-cube", s), /not a cAavegotchi id/);
    assert.deepEqual(
      normalizeBench([{ hero: "a", worker: "owned-1" }, { hero: "b", worker: "owned-1" }, { hero: "orchestrator", worker: "owned-2" }]),
      [{ hero: "a", worker: "owned-1" }, { hero: "b", worker: null }],
      "a worker is on one hero; the orchestrator is never on a bench",
    );
  });
});
