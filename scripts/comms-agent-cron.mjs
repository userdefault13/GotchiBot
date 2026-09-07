#!/usr/bin/env node
/**
 * comms-agent-cron.mjs — RETIRED. Kept only so old cron wrappers and docs that
 * still name it end up on the right path.
 *
 * This used to POST /communications-agent/run, which had Commsies (a small
 * model behind the iMac tunnel, before that Cloudflare Workers AI) write the
 * newsfeed and tweet. Julius retired that: comms are written by a real Claude
 * terminal on the iMac and published by scripts/comms-claude-cycle.mjs, and
 * Claude's reply is relayed verbatim. Nothing in GotchiBot may call /run.
 *
 * Every invocation execs the Claude cycle with the same arguments.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
console.error(
  "[comms-agent-cron] retired — Commsies / Cloudflare AI is no longer used; running scripts/comms-claude-cycle.mjs instead",
);
const r = spawnSync(process.execPath, [`${ROOT}/scripts/comms-claude-cycle.mjs`, ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: "inherit",
});
process.exit(r.status ?? 1);
