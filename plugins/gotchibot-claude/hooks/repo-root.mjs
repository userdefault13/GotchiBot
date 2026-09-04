/**
 * Find the GotchiBot checkout a hook is running against.
 *
 * The same hook scripts run from two places: this repo's .claude/hooks (where
 * walking up from the file lands in the repo) and the plugin cache on another
 * machine (where it does not, and where the checkout lives at a different path
 * under a different user). Anchor on a file only this repo has.
 */
import { existsSync } from "node:fs";
import { dirname, resolve, parse } from "node:path";

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
  const env = process.env.CLAUDE_PROJECT_DIR;
  if (looksLikeRepo(env)) return resolve(env);
  return walkUp(process.cwd()) || (fromFileDir ? walkUp(fromFileDir) : null) || resolve(env || process.cwd());
}
