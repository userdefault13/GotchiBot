import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { heroForRole } from "../scripts/orch-route.mjs";

// Its own role table (another root reads that file), so the test does not
// depend on which project the live desk has open — roles are per workbench.
test("heroForRole skips only the orchestrator alias key", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "gb-orchseat-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "config"));
  writeFileSync(
    path.join(root, "config", "agent-roles.json"),
    JSON.stringify({ orchestrator: "orchestrator", "owned-22899": "orchestrator", "owned-954": "architect" }),
  );
  assert.equal(heroForRole("orchestrator", root), "owned-22899");
  assert.equal(heroForRole("architect", root), "owned-954");
  assert.equal(heroForRole("chief-of-staff", root), null);
});
