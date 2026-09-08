#!/usr/bin/env node
/**
 * preCompact — save a context capsule before Cursor summarises the window.
 *
 * Cursor's preCompact is observational only (user_message). The restore half
 * is contexter-restore.mjs on `stop`, gated by sessions/.cursor-capsule-pending.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  /* stdin optional */
}
const trigger = payload?.trigger || "auto";

const r = spawnSync(
  process.execPath,
  [`${ROOT}/scripts/contexter.mjs`, "save", "--reason", `cursor-precompact-${trigger}`, "--json"],
  { cwd: ROOT, encoding: "utf8", timeout: 20_000 },
);

let id = null;
try {
  id = JSON.parse(r.stdout || "{}").id || null;
} catch {
  /* fall through */
}

if (id) {
  try {
    mkdirSync(dirname(PENDING), { recursive: true });
    writeFileSync(
      PENDING,
      JSON.stringify({ id, trigger, at: new Date().toISOString() }) + "\n",
    );
  } catch {
    /* best-effort marker */
  }
}

process.stdout.write(
  JSON.stringify({
    user_message: id
      ? `GotchiBot contexter: capsule ${id} saved before compaction — brief will be handed back after.`
      : "GotchiBot contexter: capsule could not be saved before compaction; identifiers may be lost.",
  }),
);
process.exit(0);
