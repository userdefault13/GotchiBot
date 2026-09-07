/**
 * Sub-agent model selection — the chain a `gotchibot new` spawn walks.
 *   node --test tests/model-auto.test.mjs
 *
 * Regression: sub-agents ran on free Zen (opencode/big-pickle) even with a paid
 * OpenCode Go key in the abra vault, because the picker only looked at
 * process.env and ran before `abra run` injected anything.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { subagentCandidates } from "../scripts/model-auto.mjs";
import { hasGoKeyInEnv, GO_KEY_NAME } from "../scripts/go-key.mjs";

const cfg = {
  goPrefer: ["opencode-go/kimi-k3", "opencode-go/glm-5.3-flash"],
  subagentPrefer: ["opencode/big-pickle", "opencode-go/should-be-dropped-without-key", "opencode/mimo-v2.5-free"],
  subagentFallback: "opencode/big-pickle",
  skip: ["opencode-go/glm-5.3-flash"],
};

describe("subagentCandidates", () => {
  it("leads with the Go list when a key is available", () => {
    const list = subagentCandidates(cfg, { goKey: true });
    assert.equal(list[0], "opencode-go/kimi-k3");
    assert.ok(list.includes("opencode/big-pickle"), "free Zen stays as a fallback");
  });

  it("never queues an opencode-go model without a key", () => {
    const list = subagentCandidates(cfg, { goKey: false });
    assert.equal(list[0], "opencode/big-pickle");
    assert.ok(list.every((m) => !m.startsWith("opencode-go/")), list.join(","));
  });

  it("honours the skip list and de-duplicates", () => {
    const list = subagentCandidates(cfg, { goKey: true });
    assert.ok(!list.includes("opencode-go/glm-5.3-flash"));
    assert.equal(new Set(list).size, list.length);
  });
});

describe("go-key env detection", () => {
  it("treats blank as unset", () => {
    assert.equal(hasGoKeyInEnv({ [GO_KEY_NAME]: "   " }), false);
    assert.equal(hasGoKeyInEnv({}), false);
    assert.equal(hasGoKeyInEnv({ [GO_KEY_NAME]: "x" }), true);
  });
});
