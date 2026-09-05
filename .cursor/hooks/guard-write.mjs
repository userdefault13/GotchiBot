#!/usr/bin/env node
/**
 * preToolUse(Write|Delete) — AGENTS.md hard rule 4.
 * Cursor I/O: { permission, agent_message }
 */
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkWritePath } from "../../scripts/gotchibot-policy/write-guard.mjs";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  process.exit(0);
}

const raw =
  payload?.tool_input?.path ||
  payload?.tool_input?.file_path ||
  payload?.tool_input?.notebook_path ||
  payload?.file_path ||
  "";

const result = checkWritePath(raw, HOOKS_DIR);
if (result.ok) {
  process.stdout.write(JSON.stringify({ permission: "allow" }));
  process.exit(0);
}

process.stdout.write(
  JSON.stringify({
    permission: "deny",
    user_message: result.reason,
    agent_message: result.reason,
  }),
);
process.exit(0);
