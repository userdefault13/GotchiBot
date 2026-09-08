/**
 * Gotchi focus routing — hard-coded, not model-dependent.
 *
 * After /switch (sessions/.focus.json mode=sub), every prompt typed in the
 * gotchi chat pane must reach that hero, not the local model's imagination.
 * gotchi.md only *asked* the model to do this; free models forgot. This hook
 * injects the rule into the system prompt on every LLM call while focus is
 * SUB, with the exact command pre-filled, and drops it again on /orch.
 *
 * Hook: experimental.chat.system.transform (OpenCode >= 1.18).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export const GotchiFocusRoute = async ({ directory, worktree }) => {
  const root = directory || worktree || process.cwd();
  return {
    "experimental.chat.system.transform": async (input, output) => {
      // Only the gotchi primary agent relays; ask/plan/build stay local.
      const mode = readJson(join(root, "sessions", ".agent-mode.json"));
      if (mode?.agent && mode.agent !== "gotchi") return;
      // The openclaw/* provider already talks to the focused hero directly.
      if (String(input?.model?.providerID || "") === "openclaw") return;
      const focus = readJson(join(root, "sessions", ".focus.json"));
      if (!focus || focus.mode !== "sub") return;
      const hero = focus.openclawAgentId || focus.heroId;
      if (!hero) return;
      output.system.push(
        [
          `## FOCUS IS SUB → ${hero} (set by /switch; live from sessions/.focus.json)`,
          `Julius is talking to ${hero} directly. You are a relay, not the answerer.`,
          "For EVERY user message in this session do exactly one thing:",
          `1. Run the bash command  ./scripts/agent-focus.mjs chat --sub "<the user's message, verbatim, double quotes escaped>"`,
          "2. Reply with that command's stdout word for word. Nothing before it, nothing after it. No summary, no commentary.",
          "If stdout contains `escalated: true`, focus is back on ORCH: handle the original message yourself as the orchestrator (delegate-first).",
          "If the command fails, reply with its exact error line (for example `openclaw chat failed (http-401)`) and stop; do not answer in the hero's place.",
          "Julius types /orch to end this mode; until then, never answer as yourself.",
        ].join("\n"),
      );
    },
  };
};
