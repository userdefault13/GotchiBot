#!/usr/bin/env node
/**
 * PreCompact — save a context capsule before the window is summarised.
 *
 * A compaction summary keeps the story and loses the identifiers: the session
 * id an agent runs under, the container that answers, the port that works, the
 * approach already proved wrong. This writes those to disk while they are still
 * in reach, so the post-compact hook can hand them back.
 *
 * Facts only: a hook cannot know the narrative half (decisions, dead ends, next
 * step). Claude should call `gotchibot contexter save --task … --decision … `
 * itself at natural checkpoints; this is the safety net for when it did not.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot } from "./repo-root.mjs";

/** Cursor owns compaction via .cursor/hooks — avoid double-save. */
if (process.env.CURSOR_VERSION) process.exit(0);

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = repoRoot(HOOKS_DIR);

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  /* stdin optional */
}
const trigger = payload?.matcher || payload?.trigger || "auto";

const r = spawnSync(
  process.execPath,
  [`${ROOT}/scripts/contexter.mjs`, "save", "--reason", `precompact-${trigger}`, "--json"],
  { cwd: ROOT, encoding: "utf8", timeout: 20_000 },
);

let id = null;
try {
  id = JSON.parse(r.stdout || "{}").id || null;
} catch {
  /* fall through to the generic message */
}

process.stdout.write(
  JSON.stringify({
    systemMessage: id
      ? `Context capsule ${id} saved before compaction (sessions/context/${id}.md) — key values and desk state will be handed back after.`
      : "Context capsule could not be saved before compaction; identifiers may be lost.",
    suppressOutput: true,
  }),
);
process.exit(0);
