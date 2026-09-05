#!/usr/bin/env node
/**
 * PreToolUse(Write|Edit|NotebookEdit) — AGENTS.md hard rule 4.
 * Policy in scripts/gotchibot-policy/; Claude I/O only.
 * Skip when CURSOR_VERSION is set (native Cursor hooks own it).
 */
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPolicy } from "./repo-root.mjs";

if (process.env.CURSOR_VERSION) process.exit(0);

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  process.exit(0);
}

const raw = payload?.tool_input?.file_path || payload?.tool_input?.notebook_path || "";
const { checkWritePath } = await loadPolicy("write-guard.mjs", HOOKS_DIR);
const result = checkWritePath(raw, HOOKS_DIR);
if (result.ok) process.exit(0);

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: result.reason,
    },
  }),
);
process.exit(0);
