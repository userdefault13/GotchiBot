/**
 * AGENTS.md hard rule 4 — stay inside the GotchiBot tree.
 * Allowed outside: ~/.claude, ~/.cursor, and the OS temp dir.
 */
import { realpathSync } from "node:fs";
import { resolve, dirname, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { repoRoot } from "./repo-root.mjs";

/** Resolve through symlinks where possible — /tmp is /private/tmp on macOS. */
export function real(p) {
  try {
    return realpathSync(p);
  } catch {
    try {
      return `${realpathSync(dirname(p))}${sep}${p.split(sep).pop()}`;
    } catch {
      return p;
    }
  }
}

function inside(child, parent) {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

/**
 * @param {string} rawPath file path from the tool payload
 * @param {string} [fromFileDir] calling hook dir for repo discovery
 * @returns {{ ok: true } | { ok: false, reason: string, target: string, repo: string }}
 */
export function checkWritePath(rawPath, fromFileDir) {
  if (!rawPath) return { ok: true };

  const REPO = repoRoot(fromFileDir);
  const ALLOWED = [
    REPO,
    `${homedir()}${sep}.claude`,
    `${homedir()}${sep}.cursor`,
    tmpdir(),
    "/tmp",
    "/private/tmp",
  ].map(real);

  const target = real(resolve(REPO, String(rawPath)));
  if (ALLOWED.some((root) => inside(target, root))) return { ok: true };

  return {
    ok: false,
    target,
    repo: REPO,
    reason:
      `Blocked by GotchiBot policy: ${target} is outside the GotchiBot tree (${REPO}). ` +
      `AGENTS.md hard rule 4 — stay inside this working tree. ` +
      `Writes are also allowed under ~/.claude, ~/.cursor, and the session scratchpad. ` +
      `If Julius wants this file changed, say so and let him run it, or work in a path under the repo.`,
  };
}
