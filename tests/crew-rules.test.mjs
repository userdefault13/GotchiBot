/**
 * Crew rules (roster.json = project crew) — SLICE 1 rules 1–2.
 *   node --test tests/crew-rules.test.mjs
 *
 * No network. Uses GOTCHIBOT_SESSIONS_DIR temp + dynamic import.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const tmp = mkdtempSync(join(tmpdir(), "gotchibot-crew-"));
process.env.GOTCHIBOT_SESSIONS_DIR = tmp;

const pcUrl = pathToFileURL(
  join(new URL("..", import.meta.url).pathname, "scripts", "project-context.mjs"),
).href;
const hkUrl = pathToFileURL(
  join(new URL("..", import.meta.url).pathname, "scripts", "hero-kind.mjs"),
).href;

const {
  rosterAdd,
  rosterRemove,
  saveRoster,
  loadRoster,
  findCrewsForHero,
  checkCrewConflict,
  ensureProjectDirs,
} = await import(`${pcUrl}?crew=${Date.now()}`);
const { heroKind } = await import(`${hkUrl}?crew=${Date.now()}`);

function seedProject(slug) {
  ensureProjectDirs(slug);
  // ensure has empty roster; also drop a dossier so list helpers stay happy
  writeFileSync(
    join(tmp, "pstack", slug, "dossier.json"),
    `${JSON.stringify({ project: slug }, null, 2)}\n`,
  );
}

after(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("heroKind", () => {
  it("classifies owned / starter / orchestrator alias / unknown", () => {
    assert.equal(heroKind("owned-123"), "owned");
    assert.equal(heroKind("owned-954"), "owned"); // orch seat is still owned for crew
    assert.equal(heroKind("starter-dai-h1-2"), "starter");
    assert.equal(heroKind("gotchi"), "orchestrator");
    assert.equal(heroKind("weird-bot"), "unknown");
    assert.equal(heroKind("x", { bindType: "bindOwned" }), "owned");
    assert.equal(heroKind("x", { bindType: "starter" }), "starter");
  });
});

describe("crew rules", () => {
  before(() => {
    seedProject("proj-a");
    seedProject("proj-b");
  });

  it("starter one-project lock: add to proj-b throws CREW_CONFLICT naming proj-a", () => {
    rosterAdd("starter-dai-h1-2", "proj-a");
    assert.deepEqual(loadRoster("proj-a").heroes, ["starter-dai-h1-2"]);
    assert.throws(
      () => rosterAdd("starter-dai-h1-2", "proj-b"),
      (err) => {
        assert.equal(err.code, "CREW_CONFLICT");
        assert.match(err.message, /proj-a/);
        assert.match(err.message, /crew-remove|--move/);
        return true;
      },
    );
    assert.deepEqual(findCrewsForHero("starter-dai-h1-2"), ["proj-a"]);
  });

  it("starter move:true removes from a and adds to b", () => {
    rosterAdd("starter-dai-h1-2", "proj-b", { move: true });
    assert.ok(!loadRoster("proj-a").heroes.includes("starter-dai-h1-2"));
    assert.ok(loadRoster("proj-b").heroes.includes("starter-dai-h1-2"));
    assert.deepEqual(findCrewsForHero("starter-dai-h1-2"), ["proj-b"]);
  });

  it("saveRoster also refuses starter conflict", () => {
    // put starter back on proj-a only
    rosterRemove("starter-dai-h1-2", "proj-b");
    rosterAdd("starter-dai-h1-2", "proj-a");
    assert.throws(
      () => saveRoster({ heroes: ["starter-dai-h1-2"] }, "proj-b"),
      (err) => {
        assert.equal(err.code, "CREW_CONFLICT");
        assert.match(err.message, /proj-a/);
        return true;
      },
    );
  });

  it("owned-* may be in many crews", () => {
    rosterAdd("owned-42", "proj-a");
    rosterAdd("owned-42", "proj-b");
    assert.ok(loadRoster("proj-a").heroes.includes("owned-42"));
    assert.ok(loadRoster("proj-b").heroes.includes("owned-42"));
    assert.deepEqual(findCrewsForHero("owned-42").sort(), ["proj-a", "proj-b"]);
    const c = checkCrewConflict("owned-42", "proj-a");
    assert.equal(c.ok, true);
    assert.equal(c.kind, "owned");
  });

  it("unknown kind: allowed with warning", () => {
    const c = checkCrewConflict("mystery-hero", "proj-a");
    assert.equal(c.ok, true);
    assert.equal(c.kind, "unknown");
    assert.ok(c.warning);
    const body = rosterAdd("mystery-hero", "proj-a");
    assert.ok(body.heroes.includes("mystery-hero"));
  });

  it("rosterRemove drops hero from crew", () => {
    rosterRemove("owned-42", "proj-b");
    assert.ok(!loadRoster("proj-b").heroes.includes("owned-42"));
    assert.ok(loadRoster("proj-a").heroes.includes("owned-42"));
  });
});

describe("CLI help mentions crew", () => {
  it("project-context --help lists crew aliases", async () => {
    const { spawnSync } = await import("node:child_process");
    const root = join(new URL("..", import.meta.url).pathname);
    const r = spawnSync(process.execPath, ["scripts/project-context.mjs", "--help"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(r.status, 2);
    const out = `${r.stdout || ""}${r.stderr || ""}`;
    assert.match(out, /crew/);
    assert.match(out, /crew-add|roster-add/);
  });
});
