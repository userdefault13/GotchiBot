#!/usr/bin/env node
/**
 * afterFileEdit + postToolUse(Write) — syntax gate.
 * Cursor afterFileEdit has no decision:block; surface failures via
 * additional_context so the agent must fix before continuing.
 */
import { readFileSync } from "node:fs";
import { checkFileSyntax } from "../../scripts/gotchibot-policy/syntax-check.mjs";

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  process.exit(0);
}

const file =
  payload?.file_path ||
  payload?.tool_input?.path ||
  payload?.tool_input?.file_path ||
  payload?.tool_response?.filePath ||
  "";

const err = checkFileSyntax(file);
if (err) {
  process.stdout.write(
    JSON.stringify({
      additional_context:
        `GotchiBot syntax gate blocked continuing with a broken file:\n${err}`,
    }),
  );
  process.exit(0);
}
process.exit(0);
