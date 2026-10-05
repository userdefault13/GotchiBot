import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPrompt } from "../scripts/desk-wake.mjs";

const clientPlaybook = JSON.parse(readFileSync(new URL("../templates/marketplace/sources/chief-of-staff/playbook.json", import.meta.url), "utf8"));

describe("Chief of Staff scheduled wake", () => {
  it("uses the marketplace workspace prompt in a client runtime", () => {
    const prompt = buildPrompt({
      roleId: "chief-of-staff",
      heroId: "client-hero",
      wake: { prompt: "Desk wake for UserDefault and the Aarcade fleet." },
      playbook: clientPlaybook,
    });
    assert.match(prompt, /authorized workspace/);
    assert.match(prompt, /evidence-backed review/);
    assert.doesNotMatch(prompt, /UserDefault|Aarcade/);
  });

  it("preserves the operator fleet's existing wake prompt", () => {
    const prompt = buildPrompt({
      roleId: "chief-of-staff",
      heroId: "operator-hero",
      wake: { prompt: "Desk wake for UserDefault and the Aarcade fleet." },
      playbook: { title: "Chief of Staff" },
    });
    assert.match(prompt, /UserDefault and the Aarcade fleet/);
  });
});
