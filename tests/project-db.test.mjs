import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { reconnectProjectDb, setCurrentProject } from "../scripts/project-context.mjs";

function writeJson(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

test("project switch reconnects the selected project's own db directory", () => {
  const sessionsDir = mkdtempSync(join(tmpdir(), "gotchibot-project-db-"));
  try {
    writeJson(join(sessionsDir, "pstack", "aarcadeghst", "db.json"), {
      project: "aarcadeghst",
      directory: "/tmp/aarcade-db",
    });
    writeJson(join(sessionsDir, "pstack", "wondrstack", "db.json"), {
      project: "wondrstack",
      directory: "/tmp/wondr-db",
    });

    assert.equal(setCurrentProject("wondrstack", { ensureDirs: false, sessionsDir }), "wondrstack");
    assert.equal(setCurrentProject("aarcadeghst", { ensureDirs: false, sessionsDir }), "aarcadeghst");
    assert.equal(reconnectProjectDb("aarcadeghst", { sessionsDir, deskRoot: "/desk" }), "/tmp/aarcade-db");
  } finally {
    rmSync(sessionsDir, { recursive: true, force: true });
  }
});

test("project reconnect ignores desk root repo paths", () => {
  const sessionsDir = mkdtempSync(join(tmpdir(), "gotchibot-project-db-"));
  try {
    writeJson(join(sessionsDir, "pstack", "aarcadeghst", "repo.json"), {
      project: "aarcadeghst",
      path: "/desk",
    });

    assert.equal(reconnectProjectDb("aarcadeghst", { sessionsDir, deskRoot: "/desk" }), null);
  } finally {
    rmSync(sessionsDir, { recursive: true, force: true });
  }
});

test("project reconnect rejects repo bindings for another slug", () => {
  const sessionsDir = mkdtempSync(join(tmpdir(), "gotchibot-project-db-"));
  try {
    writeJson(join(sessionsDir, "pstack", "aarcadeghst", "repo.json"), {
      project: "wondrstack",
      path: "/tmp/aarcade-db",
    });

    assert.equal(reconnectProjectDb("aarcadeghst", { sessionsDir, deskRoot: "/desk" }), null);
  } finally {
    rmSync(sessionsDir, { recursive: true, force: true });
  }
});
