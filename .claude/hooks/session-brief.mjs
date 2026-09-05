#!/usr/bin/env node
/**
 * SessionStart — desk brief.
 * Policy in scripts/gotchibot-policy/; Claude I/O only.
 * Skip when CURSOR_VERSION is set (avoids double brief with .cursor/hooks).
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPolicy } from "./repo-root.mjs";

if (process.env.CURSOR_VERSION) process.exit(0);

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const { deskBriefContext } = await loadPolicy("desk-brief.mjs", HOOKS_DIR);
const ctx = deskBriefContext(HOOKS_DIR);
if (!ctx) process.exit(0);

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: ctx,
    },
  }),
);
process.exit(0);
