/**
 * Workbenches: each project's own copy of the main roster with its own roles.
 * Scratch project rooms under sessions/pstack (removed after; Hub publish is off
 * under node --test).
 *   node --test tests/workbench.test.mjs
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureProjectDirs,
  migrateWorkbench,
  projectRoles,
  heroRole,
  isWorkbench,
  rosterAssign,
  loadRoster,
  roleBrief,
  heroRolesByProject,
  WORKBENCH_VERSION,
} from "../scripts/project-context.mjs";
import { rolesByProjectBlock } from "../scripts/openclaw-fleet.mjs";
import { roleOf } from "../scripts/agent-graph.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const made = [];
const slug = (tag) => {
  const s = `zz-wb-${tag}-${randomBytes(3).toString("hex")}`;
  made.push(s);
  return s;
};
const room = (s) => path.join(repo, "sessions", "pstack", s);
after(() => {
  for (const s of made) rmSync(room(s), { recursive: true, force: true });
});
const global = { orchestrator: "orchestrator", "owned-22899": "orchestrator", "owned-3033": "art-director", "owned-954": "architect" };

describe("workbench", () => {
  it("a new project is a blank workbench: only the desk-wide orchestrator has a role", () => {
    const s = slug("new");
    ensureProjectDirs(s);
    assert.equal(JSON.parse(readFileSync(path.join(room(s), "roster.json"), "utf8")).workbench, WORKBENCH_VERSION);
    assert.equal(isWorkbench(s), true);
    assert.deepEqual(projectRoles(s, { roles: global }), { orchestrator: "orchestrator", "owned-22899": "orchestrator" });
    assert.equal(heroRole("owned-3033", s), null);
  });

  it("an existing room migrates once with today's team; project-set roles and the orchestrator stay put", () => {
    const s = slug("old");
    mkdirSync(room(s), { recursive: true });
    writeFileSync(
      path.join(room(s), "roster.json"),
      JSON.stringify({ project: s, heroes: [{ id: "owned-3033", role: null }, { id: "owned-954", role: "worker" }, { id: "owned-22899", role: null }] }),
    );
    assert.equal(isWorkbench(s), false);
    assert.equal(migrateWorkbench(s, { roles: global }), true);
    assert.equal(migrateWorkbench(s, { roles: global }), false, "only once");
    const heroes = Object.fromEntries(loadRoster(s).heroes.map((h) => [h.id, h.role]));
    assert.equal(heroes["owned-3033"], "art-director");
    assert.equal(heroes["owned-954"], "worker", "a role already set on the project wins");
    assert.equal(heroes["owned-22899"], null, "the orchestrator is desk-wide, never copied");
    assert.equal(projectRoles(s, { roles: global })["owned-22899"], "orchestrator");
  });

  it("projects are independent and assignments keep the workbench marker", () => {
    const a = slug("a");
    const b = slug("b");
    ensureProjectDirs(a);
    ensureProjectDirs(b);
    rosterAssign("owned-3033", "architect", a);
    rosterAssign("owned-3033", "art-director", b);
    assert.equal(projectRoles(a, { roles: global })["owned-3033"], "architect");
    assert.equal(projectRoles(b, { roles: global })["owned-3033"], "art-director");
    assert.equal(isWorkbench(a), true, "rosterAssign kept the marker");
    rosterAssign("owned-3033", "none", a);
    assert.equal(projectRoles(a, { roles: global })["owned-3033"], undefined);
  });

  it("tells a bot its role in this project with each task", () => {
    const s = slug("brief");
    ensureProjectDirs(s);
    rosterAssign("owned-954", "architect", s);
    assert.match(roleBrief("owned-954", s), new RegExp(`^\\[project ${s} · you are the architect — `));
    assert.match(roleBrief("owned-3033", s), /you have no role here yet/);
    assert.equal(roleBrief("owned-954", null), "");
  });

  it("lists one gotchi's role in every project, for its workspace", () => {
    const a = slug("ra");
    const b = slug("rb");
    ensureProjectDirs(a);
    ensureProjectDirs(b);
    rosterAssign("owned-8532", "architect", a);
    const rows = heroRolesByProject("owned-8532").filter((r) => [a, b].includes(r.project));
    assert.deepEqual(rows, [{ project: a, role: "architect" }, { project: b, role: null }]);
    const block = rolesByProjectBlock(rows);
    assert.match(block, /## Roles by project/);
    assert.match(block, new RegExp(`${a}=architect · ${b}=—`));
    assert.match(block, /\[project X · you are the Y\]/);
    assert.equal(rolesByProjectBlock([]), "");
    const long = Array.from({ length: 80 }, (_, i) => ({ project: `p${i}-xxxxxxxx`, role: "architect" }));
    assert.ok(rolesByProjectBlock(long).split("\n")[2].length <= 600, "kept under its cap");
  });

  it("the agent graph reads an edge's role from that project's workbench", () => {
    const a = slug("ga");
    ensureProjectDirs(a);
    rosterAssign("owned-8532", "art-director", a);
    assert.equal(roleOf("owned-8532", { root: repo, project: a }), "art-director");
    const b = slug("gb");
    ensureProjectDirs(b);
    assert.equal(roleOf("owned-8532", { root: repo, project: b }), null, "unassigned in that project");
  });

  it("no project reads the global table, as before", () => {
    assert.deepEqual(projectRoles(null, { roles: global }), global);
  });
});
