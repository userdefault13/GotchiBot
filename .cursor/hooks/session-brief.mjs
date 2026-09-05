#!/usr/bin/env node
/**
 * sessionStart — desk brief (Cursor I/O).
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deskBriefContext } from "../../scripts/gotchibot-policy/desk-brief.mjs";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const ctx = deskBriefContext(HOOKS_DIR);
if (!ctx) process.exit(0);

process.stdout.write(JSON.stringify({ additional_context: ctx }));
process.exit(0);
