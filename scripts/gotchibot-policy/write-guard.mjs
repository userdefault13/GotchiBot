/**
 * AGENTS.md hard rule 4 — stay inside the GotchiBot tree.
 * Allowed outside: ~/.claude, ~/.cursor, OS temp, and /add-dir roots.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve, dirname, sep, join } from "node:path";
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

/** Extra roots from `gotchibot add-dir` (sessions/.gotchibot-add-dirs.json). */
export function readAddDirs(repo) {
  const store = join(repo, "sessions", ".gotchibot-add-dirs.json");
  if (!existsSync(store)) return [];
  try {
    const raw = JSON.parse(readFileSync(store, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.map((p) => real(String(p))).filter(Boolean);
  } catch {
    return [];
  }
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
    ...readAddDirs(REPO),
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
      `Writes are also allowed under ~/.claude, ~/.cursor, tmp, and dirs from /add-dir. ` +
      `If Julius wants another project opened: ./scripts/gotchibot add-dir <path>.`,
  };
}
