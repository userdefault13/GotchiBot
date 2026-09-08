#!/usr/bin/env node
/**
 * Classify whether a user prompt (while SUB-focused) should escalate to the
 * GotchiBot orchestrator vs stay on the focused sub-agent.
 *
 *   node scripts/focus-classify.mjs "prompt" [--json]
 *
 * stdout: orch | sub
 */
const ORCH =
  /\b(\/?orch|\/?switch|orchestrat|gotchi\s*mode|unfocus|back\s+to\s+(gotchi|orch)|switch\s+to\s+(gotchi|orch)|multitask|fan[- ]?out|parallel\s+agents?|spawn(\s+an?)?\s+agents?|spin\s+up|new\s+agents?|delegate|\/delegate|\/list|list\s+agents?|another\s+(gotchi|agent|hero)|other\s+(gotchi|agent)|all\s+agents?|handoff|checkpoint|wallet|identity|onboarding|remote-(serve|push|sync)|attach(\s+imac)?|swarm|coordinate|decompose)\b/i;

const SUB_CONTINUE =
  /\b(continue|keep\s+going|resume|fix\s+this|in\s+this\s+file|this\s+hero|as\s+this\s+gotchi|for\s+me\s+here|same\s+session)\b/i;

export function classifyFocusRoute(prompt) {
  const text = String(prompt || "").trim();
  if (!text) return { route: "sub", reason: "empty" };

  if (ORCH.test(text)) {
    return { route: "orch", reason: "orchestrator keywords" };
  }

  // Explicit stay-with-sub
  if (SUB_CONTINUE.test(text)) {
    return { route: "sub", reason: "continue-on-sub" };
  }

  // Multi-clause / multi-task → orch. Only when it reads like WORK: a question
  // such as "who are you, what is your job, and who is your boss?" has three
  // clauses and zero tasks, and escalating it silently threw Julius off the hero
  // he had just /switch-ed to.
  const parts = text.split(/[,;]|\band\b|\bthen\b/i).map((s) => s.trim()).filter(Boolean);
  const TASK_VERB = /\b(build|implement|create|add|refactor|migrate|fix|write|deploy|update|install|run|test|edit|change|remove|delete|rename|spawn)\b/i;
  const looksLikeQuestion = /\?\s*$/.test(text) || /^(who|what|when|where|why|how|which|is|are|do|does|can|could|should)\b/i.test(text);
  if (parts.length >= 3 && TASK_VERB.test(text) && !(looksLikeQuestion && text.length < 200)) {
    return { route: "orch", reason: "multi-part task" };
  }

  // Long greenfield asks without "continue" → orch (delegate/spawn)
  if (text.length > 280 && /\b(build|implement|create|add|refactor|migrate)\b/i.test(text)) {
    return { route: "orch", reason: "large greenfield task" };
  }

  return { route: "sub", reason: "default sub focus" };
}

const isMain = process.argv[1]?.endsWith("focus-classify.mjs");
if (isMain) {
  const json = process.argv.includes("--json");
  const prompt = process.argv.slice(2).filter((a) => a !== "--json").join(" ").trim();
  const result = classifyFocusRoute(prompt);
  if (json) console.log(JSON.stringify(result));
  else console.log(result.route);
}
