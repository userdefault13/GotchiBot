import assert from "node:assert/strict";
import test from "node:test";

import { heroForRole } from "../scripts/orch-route.mjs";

test("heroForRole skips only the orchestrator alias key", () => {
  assert.equal(heroForRole("orchestrator"), "owned-22899");
  assert.equal(heroForRole("architect"), "owned-954");
});
