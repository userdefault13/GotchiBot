/**
 * Find the GotchiBot checkout a hook is running against.
 *
 * The same hook scripts run from two places: this repo's .claude/hooks (where
 * walking up from the file lands in the repo) and the plugin cache on another
 * machine (where it does not). Anchor on a file only this repo has.
 *
 * Shared policy modules live under scripts/gotchibot-policy/ inside the
 * checkout — load them via repoRoot(), never via a path relative to this file.
 */
import { existsSync } from "node:fs";
import { dirname, resolve, parse } from "node:path";
import { pathToFileURL } from "node:url";

const MARKER = "scripts/gotchibot";

function looksLikeRepo(dir) {
  return !!dir && existsSync(resolve(dir, MARKER));
}

function walkUp(start) {
  let dir = resolve(start);
  const { root } = parse(dir);
  while (true) {
    if (looksLikeRepo(dir)) return dir;
    if (dir === root) return null;
    dir = dirname(dir);
  }
}

/** @param {string} fromFileDir directory of the calling hook, as a last resort. */
export function repoRoot(fromFileDir) {
  for (const env of [process.env.CURSOR_PROJECT_DIR, process.env.CLAUDE_PROJECT_DIR]) {
    if (looksLikeRepo(env)) return resolve(env);
  }
  return (
    walkUp(process.cwd()) ||
    (fromFileDir ? walkUp(fromFileDir) : null) ||
    resolve(process.env.CURSOR_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd())
  );
}

/** Dynamic-import a module under scripts/gotchibot-policy/ in the checkout. */
export async function loadPolicy(name, fromFileDir) {
  const root = repoRoot(fromFileDir);
  const href = pathToFileURL(resolve(root, "scripts/gotchibot-policy", name)).href;
  return import(href);
}
