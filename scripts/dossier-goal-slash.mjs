#!/usr/bin/env node
/**
 * Chat slash adapter for dossier goal verbs.
 *
 *   node scripts/dossier-goal-slash.mjs "/dossier goal set <text>"
 *
 * Parses one slash line and, on success, spawns scripts/pstack-dossier.mjs.
 * This module does not write dossier.json or milestones.json.
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOSSIER_SCRIPT = join(ROOT, "scripts", "pstack-dossier.mjs");
const VERB_LIST = "set|edit|complete|show|clear, milestone";
const NO_ARG_GOAL = new Set(["complete", "show", "clear"]);

/**
 * Parse a chat line into pstack-dossier argv.
 * Non-dossier lines (including /goal) return null.
 * @param {string} input
 * @returns {{ ok: true, argv: string[] } | { ok: false, error: string } | null}
 */
export function parseDossierGoalSlash(input) {
  if (typeof input !== "string") return null;
  let rest = input.trim();
  if (!rest) return null;
  if (rest.startsWith("/")) rest = rest.slice(1);

  const take = () => {
    rest = rest.replace(/^\s+/, "");
    if (!rest) return "";
    const token = /^\S+/.exec(rest)[0];
    rest = rest.slice(token.length);
    return token;
  };

  const head = take();
  if (head.toLowerCase() !== "dossier") return null;

  const next = take();
  if (!next) return { ok: false, error: VERB_LIST };

  const second = next.toLowerCase();
  if (second === "milestone") {
    if (take()) return { ok: false, error: "extra arguments" };
    return { ok: true, argv: ["milestone"] };
  }
  if (second !== "goal") return { ok: false, error: `unknown verb: ${next}` };

  const verbToken = take();
  if (!verbToken) return { ok: false, error: VERB_LIST };

  const verb = verbToken.toLowerCase();
  if (verb === "milestone") {
    if (take()) return { ok: false, error: "extra arguments" };
    return { ok: true, argv: ["milestone"] };
  }
  if (verb === "set" || verb === "edit") {
    const text = rest.trim();
    if (!text) return { ok: false, error: "empty goal" };
    return { ok: true, argv: ["goal", verb, text] };
  }
  if (NO_ARG_GOAL.has(verb)) {
    if (take()) return { ok: false, error: "extra arguments" };
    return { ok: true, argv: ["goal", verb] };
  }
  return { ok: false, error: `unknown verb: ${verbToken}` };
}

function main() {
  const parsed = parseDossierGoalSlash(process.argv[2] ?? "");
  if (parsed == null) process.exit(2);
  if (!parsed.ok) {
    console.error(parsed.error);
    process.exit(1);
  }
  const result = spawnSync(process.execPath, [DOSSIER_SCRIPT, ...parsed.argv], {
    stdio: "inherit",
  });
  if (result.error && result.status == null) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

if (isMainModule(import.meta.url)) main();
