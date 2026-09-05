#!/usr/bin/env node
/**
 * Assert the Cursor GotchiBot layer is present and wired to shared policy.
 *
 *   node scripts/cursor-layer-check.mjs [--json]
 *   ./scripts/gotchibot cursor-layer check
 *
 * Cheap drift check — not a generate/copy like claude-plugin build.
 * Distribution is the git checkout (MBP + iMac pull the same tree).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const REQUIRED = [
  "CURSOR.md",
  ".cursor/hooks.json",
  ".cursor/hooks/guard-bash.mjs",
  ".cursor/hooks/guard-write.mjs",
  ".cursor/hooks/check-syntax.mjs",
  ".cursor/hooks/session-brief.mjs",
  ".cursor/rules/gotchi-cursor-layer.mdc",
  ".cursor/rules/gotchi-orchestrator.mdc",
  ".cursor/skills/passoff/SKILL.md",
  ".cursor/skills/gotchibot-mesh/SKILL.md",
  ".cursor/skills/gotchibot-meet/SKILL.md",
  "scripts/gotchibot-policy/repo-root.mjs",
  "scripts/gotchibot-policy/install-guard.mjs",
  "scripts/gotchibot-policy/write-guard.mjs",
  "scripts/gotchibot-policy/syntax-check.mjs",
  "scripts/gotchibot-policy/desk-brief.mjs",
  ".claude/hooks/guard-bash.mjs",
  ".claude/hooks/session-brief.mjs",
];

/** Claude adapters must skip under Cursor and load shared policy. */
const CLAUDE_HOOK_MARKERS = [
  [".claude/hooks/guard-bash.mjs", ["CURSOR_VERSION", "install-guard"]],
  [".claude/hooks/guard-write.mjs", ["CURSOR_VERSION", "write-guard"]],
  [".claude/hooks/check-syntax.mjs", ["CURSOR_VERSION", "syntax-check"]],
  [".claude/hooks/session-brief.mjs", ["CURSOR_VERSION", "desk-brief"]],
];

/** Cursor hooks must import shared policy (relative). */
const CURSOR_HOOK_MARKERS = [
  [".cursor/hooks/guard-bash.mjs", ["gotchibot-policy/install-guard"]],
  [".cursor/hooks/guard-write.mjs", ["gotchibot-policy/write-guard"]],
  [".cursor/hooks/check-syntax.mjs", ["gotchibot-policy/syntax-check"]],
  [".cursor/hooks/session-brief.mjs", ["gotchibot-policy/desk-brief"]],
];

function check() {
  const problems = [];

  for (const rel of REQUIRED) {
    if (!existsSync(resolve(ROOT, rel))) problems.push(`missing: ${rel}`);
  }

  try {
    const hooks = JSON.parse(readFileSync(resolve(ROOT, ".cursor/hooks.json"), "utf8"));
    if (hooks.version !== 1) problems.push("stale: .cursor/hooks.json version must be 1");
    for (const key of ["beforeShellExecution", "preToolUse", "afterFileEdit", "sessionStart"]) {
      if (!hooks.hooks?.[key]?.length) problems.push(`hooks.json missing event: ${key}`);
    }
  } catch (e) {
    problems.push(`hooks.json unreadable: ${e?.message || e}`);
  }

  for (const [rel, needles] of [...CLAUDE_HOOK_MARKERS, ...CURSOR_HOOK_MARKERS]) {
    const p = resolve(ROOT, rel);
    if (!existsSync(p)) continue;
    const body = readFileSync(p, "utf8");
    for (const n of needles) {
      if (!body.includes(n)) problems.push(`unwired: ${rel} missing "${n}"`);
    }
  }

  return problems;
}

function main() {
  const json = process.argv.includes("--json");
  const problems = check();
  if (json) {
    console.log(JSON.stringify({ ok: !problems.length, problems }, null, 2));
  } else if (problems.length) {
    console.error(`cursor layer check failed (${problems.length}):`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  } else {
    console.log(`cursor layer ok (${REQUIRED.length} files, hooks + policy wired)`);
  }
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(e?.message || e);
    process.exit(1);
  }
}

export { check };
