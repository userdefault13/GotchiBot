/**
 * gotchibot-graph — OpenClaw plugin entry. Linked from the GotchiBot repo
 * (`gotchibot graph plugin install`), so it loads the repo's own hook logic.
 * Observation only: no hook here can block, rewrite, or delay a run.
 */
import { registerGraphHooks } from "../../scripts/oc-graph-hooks.mjs";

export default {
  id: "gotchibot-graph",
  name: "GotchiBot agent graph",
  description: "Records bot runs, token usage and native sub-agents on the GotchiBot agent graph.",
  configSchema: {
    safeParse(value) {
      if (value === undefined) return { success: true, data: undefined };
      if (!value || typeof value !== "object" || Array.isArray(value)) return { success: false, error: { issues: [{ path: [], message: "expected config object" }] } };
      return { success: true, data: value };
    },
    jsonSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  register(api) {
    registerGraphHooks(api);
  },
};
