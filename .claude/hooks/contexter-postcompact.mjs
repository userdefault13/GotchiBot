#!/usr/bin/env node
/**
 * PostCompact — hand the saved capsule back to the freshly compacted window.
 *
 * This is the half that makes contexter worth having. The summary that survives
 * compaction is prose; the identifiers, the settled decisions and the dead ends
 * are what the next window needs in order not to redo the last one's work. Read
 * the newest capsule and inject its brief as context.
 */
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot } from "./repo-root.mjs";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = repoRoot(HOOKS_DIR);

const r = spawnSync(process.execPath, [`${ROOT}/scripts/contexter.mjs`, "latest", "--brief"], {
  cwd: ROOT,
  encoding: "utf8",
  timeout: 15_000,
});

const brief = (r.stdout || "").trim();
if (!brief || brief.startsWith("no context capsules")) process.exit(0);

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostCompact",
      additionalContext:
        `Context carried across the compaction boundary (from the capsule saved just before it).\n` +
        `Treat it as a snapshot: verify anything you act on, continue from Next step, and do not ` +
        `redo what Settled or Already failed covers.\n\n${brief}`,
    },
  }),
);
process.exit(0);
