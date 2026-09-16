#!/usr/bin/env node
/**
 * afterAgentResponse — ralph-loop completion capture.
 *
 * Watches each agent response for a <promise>TEXT</promise> tag matching the
 * active loop's completion_promise. On a match, writes the done flag under
 * sessions/ralph/<slug>/done so ralph-stop.mjs ends the loop.
 *
 * Input:  { "text": "<assistant response text>" }
 * Output: none (fire-and-forget)
 *
 * No active loop → exit 0 silently. Never fights contexter-restore: it only
 * writes a flag; the stop hook decides whether to emit a followup.
 */
import { readFileSync } from "node:fs";
import { activeSlug, readScratchpad, markDone } from "../../scripts/ralph-orch.mjs";

// ralph-orch resolves sessions/ralph from its own module path, so the hooks
// never pass a root — activeSlug() with no args reads the same checkout.

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  process.exit(0);
}

const text = typeof payload?.text === "string" ? payload.text : "";
if (!text) process.exit(0);

const slug = activeSlug();
if (!slug) process.exit(0);

const sp = readScratchpad(slug);
if (!sp || !sp.completion_promise) process.exit(0);

const m = /<promise>([\s\S]*?)<\/promise>/.exec(text);
if (!m) process.exit(0);

const promiseText = m[1].trim().replace(/\s+/g, " ");
if (promiseText === sp.completion_promise) {
  markDone(slug);
}
process.exit(0);