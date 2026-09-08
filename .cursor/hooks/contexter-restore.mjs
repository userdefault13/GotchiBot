#!/usr/bin/env node
/**
 * stop — after compaction, inject the newest capsule brief once.
 *
 * preCompact cannot add agent context in Cursor; it only sets a pending marker.
 * On the next completed agent stop, hand the brief back as a follow-up message
 * (loop_limit: 1 in hooks.json) so the window does not redo settled work.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot } from "../../scripts/gotchibot-policy/repo-root.mjs";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = repoRoot(HOOKS_DIR);
const PENDING = resolve(ROOT, "sessions/.cursor-capsule-pending");

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  process.exit(0);
}

if (payload?.status !== "completed") process.exit(0);
if (!existsSync(PENDING)) process.exit(0);

try {
  unlinkSync(PENDING);
} catch {
  process.exit(0);
}

const r = spawnSync(process.execPath, [`${ROOT}/scripts/contexter.mjs`, "latest", "--brief"], {
  cwd: ROOT,
  encoding: "utf8",
  timeout: 15_000,
});

const brief = (r.stdout || "").trim();
if (!brief || brief.startsWith("no context capsules")) process.exit(0);

process.stdout.write(
  JSON.stringify({
    followup_message:
      `Context carried across the compaction boundary (GotchiBot contexter).\n` +
      `Treat it as a snapshot: verify anything you act on, continue from Next step, and do not ` +
      `redo what Settled or Already failed covers.\n\n${brief}`,
  }),
);
process.exit(0);
