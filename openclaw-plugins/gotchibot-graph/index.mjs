/**
 * gotchibot-graph — OpenClaw plugin entry. Linked from the GotchiBot repo
 * (`gotchibot graph plugin install`). OpenClaw runs it from a capture copy, so
 * config.root (set by the installer) points it back at the live repo.
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
      const extra = Object.keys(value).filter((k) => k !== "root");
      if (extra.length) return { success: false, error: { issues: [{ path: [extra[0]], message: "unknown key" }] } };
      if (value.root != null && typeof value.root !== "string") return { success: false, error: { issues: [{ path: ["root"], message: "root must be the GotchiBot repo path" }] } };
      return { success: true, data: value };
    },
    jsonSchema: { type: "object", additionalProperties: false, properties: { root: { type: "string", description: "GotchiBot repo path (set by gotchibot graph plugin install)" } } },
  },
  register(api) {
    registerGraphHooks(api);
  },
};
