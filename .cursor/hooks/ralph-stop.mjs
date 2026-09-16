#!/usr/bin/env node
/**
 * stop — ralph-loop iteration driver.
 *
 * When the agent finishes a turn and a ralph loop is active, this hook decides
 * whether to feed the same prompt back for another iteration or let the
 * session end. Runs FIRST in the stop event (before contexter-restore.mjs).
 *
 * Cursor stop hook API:
 *   Input:  { "status": "completed"|"aborted"|"error", "loop_count": N, ...common }
 *   Output: { "followup_message": "<text>" }  to continue, or exit 0 with no output to stop
 *
 * Rules:
 *   - no active loop            → exit 0 (contexter may still fire its capsule)
 *   - done flag present         → clear active, exit 0 (promise matched)
 *   - iteration >= max          → clear active, exit 0 (cap reached)
 *   - otherwise                 → bump iteration, emit followup with the
 *                                 original prompt (loop continues)
 *
 * loop_limit in hooks.json is null (upstream parity) so the loop is not cut
 * short by the followup cap; contexter-restore keeps loop_limit: 1. When ralph
 * is inactive this hook outputs nothing, so the two never fight.
 */
import { existsSync } from "node:fs";
import {
  activeSlug,
  readScratchpad,
  bumpIteration,
  clearActive,
  donePath,
} from "../../scripts/ralph-orch.mjs";

// ralph-orch resolves sessions/ralph from its own module path, so the hooks
// never pass a root — activeSlug() with no args reads the same checkout.

const slug = activeSlug();
if (!slug) process.exit(0);

const sp = readScratchpad(slug);
if (!sp) {
  // Corrupted scratchpad — stop the loop rather than loop forever.
  clearActive(slug);
  process.exit(0);
}

if (existsSync(donePath(slug))) {
  clearActive(slug);
  process.exit(0);
}

if (sp.max_iterations > 0 && sp.iteration >= sp.max_iterations) {
  clearActive(slug);
  process.exit(0);
}

const next = bumpIteration(slug);
const header = sp.completion_promise
  ? `[Ralph loop iteration ${next}. To complete: output <promise>${sp.completion_promise}</promise> ONLY when genuinely true.]`
  : `[Ralph loop iteration ${next}.]`;

process.stdout.write(
  JSON.stringify({
    followup_message: `${header}\n\n${sp.prompt}`,
  }),
);
process.exit(0);