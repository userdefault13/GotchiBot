#!/usr/bin/env node
/**
 * PreToolUse(Bash) — enforce AGENTS.md hard rule 1.
 * Policy lives in scripts/gotchibot-policy/; this file is Claude I/O only.
 *
 * When CURSOR_VERSION is set, Cursor's native .cursor/hooks own enforcement
 * (avoids double-deny from Claude third-party hook loading).
 */
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPolicy } from "./repo-root.mjs";

if (process.env.CURSOR_VERSION) process.exit(0);

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  process.exit(0);
}

const command = String(payload?.tool_input?.command || "");
const { checkShellCommand } = await loadPolicy("install-guard.mjs", HOOKS_DIR);
const reason = checkShellCommand(command);
if (reason) deny(reason);
process.exit(0);
