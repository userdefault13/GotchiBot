#!/usr/bin/env node
/**
 * PostToolUse(Write|Edit) — syntax gate.
 * Policy in scripts/gotchibot-policy/; Claude I/O only.
 * Skip when CURSOR_VERSION is set.
 */
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPolicy } from "./repo-root.mjs";

if (process.env.CURSOR_VERSION) process.exit(0);

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));

function block(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
}

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  process.exit(0);
}

const file = payload?.tool_response?.filePath || payload?.tool_input?.file_path || "";
const { checkFileSyntax } = await loadPolicy("syntax-check.mjs", HOOKS_DIR);
const err = checkFileSyntax(file);
if (err) block(err);
process.exit(0);
