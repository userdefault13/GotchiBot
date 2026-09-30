/**
 * Orchestrator routing — per message, not model-dependent.
 *
 * gotchi.md asks the orchestrator to delegate; given a "how would you…" question
 * the model still answered it itself and only offered to route afterwards. This
 * hook classifies each user message (scripts/orch-route.mjs, rules in
 * config/orch-routes.json) and, for that turn, pins the route into the system
 * prompt with the exact command pre-filled: architect → consult and relay,
 * worker → delegate-pick. Chit-chat, status, slash commands and "you answer"
 * stay with the orchestrator.
 *
 * Skipped for `opencode run` (dispatch workers and one-shots run as gotchi too),
 * for non-gotchi agents, while focus is SUB (gotchi-focus-route owns that), and
 * with GOTCHIBOT_ORCH_ROUTE=0.
 *
 * Hooks: chat.message + experimental.chat.system.transform (OpenCode >= 1.18).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function userText(parts) {
  return (parts || [])
    .filter((p) => p?.type === "text" && !p.synthetic && !p.ignored)
    .map((p) => p.text || "")
    .join("\n")
    .trim();
}

const BUILD = /\b(build|make|create)\b/i;

function directive(route, text) {
  if (route.route === "architect" && BUILD.test(text)) {
    const title = text.replace(/\s+/g, " ").slice(0, 120);
    return [
      `## ROUTE → architect, then a job (${route.hero}) · ${route.why} — set for THIS message by gotchi-orch-route`,
      "This is a build ask. You are the orchestrator: do not design it, do not plan it, and do not spawn workers.",
      "1. Tell UserDefault in one line that you are asking the architect.",
      `2. Run: ./scripts/gotchibot consult architect --from orchestrator ${JSON.stringify(text)}`,
      `3. Open the job and move it to design: ./scripts/project-tickets.mjs job open --by orchestrator ${JSON.stringify(title)}`,
      "   then ./scripts/project-tickets.mjs job advance <id> --to design --by orchestrator",
      "4. Hand the design note to the project manager and stop:",
      "   ./scripts/project-tickets.mjs job advance <id> --to plan --by orchestrator",
      `   ./scripts/gotchibot consult project-manager --from orchestrator "plan job <id>: <the design note>"`,
      "5. Show UserDefault the plan. Wait. Do not assign tickets and do not spawn.",
      "6. A later yes: ./scripts/project-tickets.mjs job advance <id> --to staff --by orchestrator",
      "   then ./scripts/gotchibot consult project-manager --from orchestrator \"UserDefault said yes — seat gaps and assign job <id>\"",
      "   A later change: ./scripts/project-tickets.mjs job advance <id> --to plan --by orchestrator and consult project-manager again.",
      "If consult fails, show its exact error line. Never answer in the architect's or the project manager's place.",
    ].join("\n");
  }
  if (route.route === "worker") {
    return [
      `## ROUTE → worker (${route.why}) — set for THIS message by gotchi-orch-route`,
      "This is hands-on work. You are the orchestrator: do not do it in this chat.",
      "1. Say in one line who you are handing it to.",
      "2. Run ./scripts/delegate-pick.mjs --json and follow its action (chat / spawn / blocked).",
      "3. The worker does the edits through a work tool (cursor-cli first). Report what spawned, then merge its output.md.",
    ].join("\n");
  }
  return [
    `## ROUTE → ${route.route} (${route.hero}) · ${route.why} — set for THIS message by gotchi-orch-route`,
    `This belongs to the ${route.route} desk. You are the orchestrator: do not answer it yourself, and do not investigate first.`,
    `1. Tell UserDefault in one line that you are asking the ${route.route}.`,
    `2. Run: ./scripts/gotchibot consult ${route.route} --from orchestrator "<the user's message, verbatim, double quotes escaped>"`,
    `3. Relay the reply (lead with its TLDR, keep its options). Keep the thread id it prints.`,
    `4. Follow-ups on this topic go to the same desk: ./scripts/gotchibot consult followup <thread> "…"`,
    "5. Nothing gets built until UserDefault picks; then hand the build to a worker (delegate-pick → cursor-cli).",
    `If consult fails, show its exact error line and offer --via spawn. Never answer in the ${route.route}'s place.`,
    text.length > 600 ? "" : `(message: ${JSON.stringify(text)})`,
  ]
    .filter(Boolean)
    .join("\n");
}

export const GotchiOrchRoute = async ({ directory, worktree }) => {
  const root = directory || worktree || process.cwd();
  const disabled = process.env.GOTCHIBOT_ORCH_ROUTE === "0" || process.argv.slice(1).includes("run");
  const routes = new Map();
  let classify = null;

  return {
    "chat.message": async (input, output) => {
      if (disabled) return;
      const sid = input?.sessionID;
      if (!sid) return;
      routes.delete(sid);
      const agent = input?.agent || readJson(join(root, "sessions", ".agent-mode.json"))?.agent;
      if (agent && agent !== "gotchi") return;
      if (String(input?.model?.providerID || "") === "openclaw") return;
      if (readJson(join(root, "sessions", ".focus.json"))?.mode === "sub") return;
      const text = userText(output?.parts);
      if (!text) return;
      try {
        classify ||= (await import(pathToFileURL(join(root, "scripts", "orch-route.mjs")).href)).classifyOrchRoute;
        const route = classify(text, { root });
        if (route.route !== "self") routes.set(sid, { ...route, text });
      } catch {
        // Router broken → orchestrator falls back to gotchi.md delegate-first.
      }
    },
    "experimental.chat.system.transform": async (input, output) => {
      const route = input?.sessionID && routes.get(input.sessionID);
      if (route) output.system.push(directive(route, route.text));
    },
  };
};
