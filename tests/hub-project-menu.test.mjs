/**
 * Paired desk: cockpit project menu lists hub slugs and a hub pick
 * writes the pointer only (no blank local room).
 *   node --test tests/hub-project-menu.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  listHubProjectSlugs,
  projectMenuOptions,
  resolveDeskProjectSlug,
  setCurrentProject,
  unionProjectSlugs,
} from "../scripts/project-context.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gate = path.join(root, "scripts/onboarding-gate.mjs");
const TEST_TOKEN = "desk-token-test";
const HUB_SLUGS = ["aarcadeghst", "p1790750313984"];

describe("hub project menu", () => {
  it("unions local slugs with hub slugs and keeps Create new project as an extra row", () => {
    const slugs = unionProjectSlugs(["local-room", "aarcadeghst"], ["aarcadeghst", "p1790750313984", "not a slug"]);
    assert.deepEqual(slugs, ["local-room", "aarcadeghst", "p1790750313984"]);
    const rows = projectMenuOptions(slugs, null);
    assert.ok(rows.filter((r) => r.key.startsWith("proj:")).length >= 2);
    assert.equal(rows.filter((r) => r.key === "new").length, 1);
    assert.equal(rows.find((r) => r.key === "new").label, "Create new project…");
    assert.notEqual(rows.length, 1);
    assert.equal(rows.at(-1).key, "back");
  });

  it("reads GET /api/gotchibot/projects only when the desk pin is present", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gb-hub-pin-"));
    const pinPath = path.join(dir, "hub.json");
    writeFileSync(
      pinPath,
      `${JSON.stringify({ deskName: "test-desk", tailscaleHost: "hub.test", deskApiBase: "http://127.0.0.1:9", deskToken: TEST_TOKEN })}\n`,
    );
    let calls = 0;
    const slugs = await listHubProjectSlugs({
      env: {
        GOTCHIBOT_HUB_PIN: pinPath,
        GOTCHIBOT_DESK_API_BASE: "http://127.0.0.1:9",
        GOTCHIBOT_DESK_TOKEN: TEST_TOKEN,
      },
      fetchImpl: async (url, opts) => {
        calls += 1;
        assert.equal(url, "http://127.0.0.1:9/api/gotchibot/projects");
        const sent = opts?.headers?.["X-GotchiBot-Desk-Token"];
        if (sent !== TEST_TOKEN) throw new Error("desk token header did not match the test token");
        return {
          ok: true,
          async text() {
            return JSON.stringify({
              ok: true,
              projects: [
                { slug: "aarcadeghst" },
                { slug: "p1790750313984" },
                { slug: "aarcadeghst" },
                { slug: "bad slug" },
              ],
            });
          },
        };
      },
    });
    assert.deepEqual(slugs, HUB_SLUGS);
    assert.equal(calls, 1);

    const missing = path.join(dir, "missing-hub.json");
    let fetched = 0;
    const none = await listHubProjectSlugs({
      env: {
        GOTCHIBOT_HUB_PIN: missing,
        GOTCHIBOT_DESK_API_BASE: "http://127.0.0.1:9",
        GOTCHIBOT_DESK_TOKEN: TEST_TOKEN,
      },
      fetchImpl: async () => {
        fetched += 1;
        return { ok: true, async text() { return "{}"; } };
      },
    });
    assert.deepEqual(none, []);
    assert.equal(fetched, 0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("picking a hub slug writes the pointer and does not create a local room", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gb-hub-pick-"));
    try {
      mkdirSync(path.join(dir, "pstack", "localproj"), { recursive: true });
      writeFileSync(
        path.join(dir, ".checkpoint-local.json"),
        `${JSON.stringify({ gameState: { projects: { current: "localproj" } } })}\n`,
      );
      setCurrentProject("p1790750313984", { ensureDirs: false, sessionsDir: dir });
      assert.equal(readFileSync(path.join(dir, ".pstack-dossier-current"), "utf8").trim(), "p1790750313984");
      assert.equal(readFileSync(path.join(dir, ".project-current"), "utf8").trim(), "p1790750313984");
      assert.equal(existsSync(path.join(dir, "pstack", "p1790750313984")), false);

      const shown = resolveDeskProjectSlug({ sessionsDir: dir, paired: true });
      assert.equal(shown, "p1790750313984");
      assert.equal(readFileSync(path.join(dir, ".project-current"), "utf8").trim(), "p1790750313984");
      assert.equal(existsSync(path.join(dir, "pstack", "p1790750313984")), false);

      const hidden = resolveDeskProjectSlug({
        preferSepolia: false,
        sessionsDir: dir,
        paired: false,
      });
      assert.equal(hidden, null);
      assert.equal(existsSync(path.join(dir, "pstack", "p1790750313984")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the cockpit menu unions hub slugs and does not create a room on pick", () => {
    const src = readFileSync(gate, "utf8");
    const listFn = src.slice(src.indexOf("async function listProjectSlugs"), src.indexOf("function setCurrentProject"));
    assert.match(listFn, /listHubProjectSlugs/);
    assert.match(listFn, /unionProjectSlugs/);
    const pick = src.slice(src.indexOf('if (pick.key.startsWith("proj:"))'), src.indexOf("const rl = readline"));
    assert.match(pick, /pointerOnly/);
    assert.doesNotMatch(pick, /pstack-dossier/);
    assert.doesNotMatch(pick, /ensureProjectDirs/);
    const menu = src.slice(src.indexOf("async function selectProjectMenu"), src.indexOf('if (pick.key.startsWith("proj:"))'));
    assert.match(menu, /projectMenuOptions/);
    assert.match(menu, /listProjectSlugs/);
  });
});
