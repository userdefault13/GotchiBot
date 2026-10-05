/**
 * Hub model chain: next available model when a provider fails.
 *   node --test tests/hub-model-chain.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  classifyModelError,
  hubModelChain,
  markModelFailed,
  loadCooldowns,
  splitModel,
} from "../scripts/hub-model-chain.mjs";
import { turnWithModelFallback } from "../services/gotchibot-api/desk-runner.mjs";

const providers = [
  { id: "opencode-go", models: { "glm-5.3": {}, "kimi-k3": {} } },
  { id: "nvidia", models: { "z-ai/glm-5.3": {}, "z-ai/glm-5.3-flash": {} } },
  { id: "opencode", models: { "big-pickle": {} } },
];
const prefer = ["opencode-go/glm-5.3", "nvidia/z-ai/glm-5.3", "opencode-go/kimi-k3", "missing/model", "opencode/big-pickle"];

describe("hub model chain", () => {
  it("starts with the Hub's configured model and keeps only listed models", () => {
    const chain = hubModelChain({ configModel: "opencode-go/kimi-k3", providers, prefer, state: { until: {} } });
    assert.deepEqual(chain, ["opencode-go/kimi-k3", "opencode-go/glm-5.3", "nvidia/z-ai/glm-5.3", "opencode/big-pickle"]);
    assert.deepEqual(splitModel("nvidia/z-ai/glm-5.3"), { providerID: "nvidia", modelID: "z-ai/glm-5.3" });
  });

  it("classifies quota/auth as provider-wide, rate limits as one model, the rest as not a model problem", () => {
    assert.equal(classifyModelError("model error: Go usage limit exceeded").scope, "provider");
    assert.equal(classifyModelError("401 invalid api key").scope, "provider");
    assert.equal(classifyModelError("429 too many requests").scope, "model");
    assert.equal(classifyModelError("desk thread has no project"), null);
  });

  it("a provider cooldown skips every model of that provider", () => {
    const root = mkdtempSync(path.join(tmpdir(), "gb-chain-"));
    try {
      markModelFailed("opencode-go/glm-5.3", classifyModelError("usage limit exceeded"), { root });
      const chain = hubModelChain({ configModel: "opencode-go/glm-5.3", providers, prefer, state: loadCooldowns(root) });
      assert.deepEqual(chain, ["nvidia/z-ai/glm-5.3", "opencode/big-pickle"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("turnWithModelFallback", () => {
  const client = (calls) => ({
    providers: async () => providers,
    configModel: async () => "opencode-go/glm-5.3",
    abort: async () => calls.push("abort"),
  });

  it("moves to the next available model when the provider is out of quota", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "gb-chain-"));
    const calls = [];
    try {
      const r = await turnWithModelFallback(
        client(calls),
        "ses_1",
        async (model) => {
          calls.push(model);
          if (model.startsWith("opencode-go/")) throw new Error("model error: Go usage limit exceeded");
          return "ok";
        },
        { root },
      );
      assert.equal(r.model, "nvidia/z-ai/glm-5.3");
      assert.equal(r.fellBack, true);
      assert.match(r.note, /answered by nvidia\/z-ai\/glm-5\.3 · opencode-go\/glm-5\.3 quota/);
      assert.deepEqual(calls, ["opencode-go/glm-5.3", "abort", "nvidia/z-ai/glm-5.3"], "kimi-k3 skipped: same provider is cooling");
      // The next turn starts on NVIDIA directly while Go cools down.
      const next = [];
      await turnWithModelFallback(client(next), "ses_2", async (m) => next.push(m), { root });
      assert.deepEqual(next, ["nvidia/z-ai/glm-5.3"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not retry errors that are not about the model", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "gb-chain-"));
    try {
      await assert.rejects(
        turnWithModelFallback(client([]), "ses_1", async () => {
          throw new Error("desk thread has no project");
        }, { root }),
        /desk thread has no project/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
