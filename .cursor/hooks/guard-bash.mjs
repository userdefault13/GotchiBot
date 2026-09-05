#!/usr/bin/env node
/**
 * beforeShellExecution — AGENTS.md hard rule 1 + destructive denies.
 * Cursor I/O: { permission, agent_message, user_message }
 */
import { readFileSync } from "node:fs";
import { checkShellCommand } from "../../scripts/gotchibot-policy/install-guard.mjs";

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  process.exit(0);
}

const command = String(payload?.command || payload?.tool_input?.command || "");
const reason = checkShellCommand(command);
if (reason) {
  process.stdout.write(
    JSON.stringify({
      permission: "deny",
      user_message: reason,
      agent_message: reason,
    }),
  );
  process.exit(0);
}

process.stdout.write(JSON.stringify({ permission: "allow" }));
process.exit(0);
