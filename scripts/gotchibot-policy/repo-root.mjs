/**
 * Find the GotchiBot checkout a hook is running against.
 *
 * Same scripts run from .claude/hooks, .cursor/hooks, and the Claude plugin
 * cache on another machine. Anchor on a file only this repo has.
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

/** @param {string} [fromFileDir] directory of the calling hook, as a last resort. */
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
