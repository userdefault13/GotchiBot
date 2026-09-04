#!/usr/bin/env node
/**
 * PreToolUse(Write|Edit|NotebookEdit) — enforce AGENTS.md hard rule 4 and the
 * CLAUDE.md hard limit: stay inside the GotchiBot tree.
 *
 * Allowed outside the repo, deliberately:
 *   - ~/.claude            Claude Code's own config (this hook lives there too)
 *   - the session scratchpad (/tmp/claude-*, /private/tmp/claude-*, $TMPDIR)
 * Everything else — another repo, /etc, ~/Library — is denied.
 */
import { readFileSync, realpathSync } from "node:fs";
import { resolve, dirname, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { repoRoot } from "./repo-root.mjs";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = repoRoot(HOOKS_DIR);

/** Resolve through symlinks where possible — /tmp is /private/tmp on macOS. */
function real(p) {
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

const ALLOWED = [REPO, `${homedir()}${sep}.claude`, tmpdir(), "/tmp", "/private/tmp"].map(real);

function inside(child, parent) {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  process.exit(0);
}

const raw = payload?.tool_input?.file_path || payload?.tool_input?.notebook_path || "";
if (!raw) process.exit(0);

const target = real(resolve(REPO, String(raw)));
if (ALLOWED.some((root) => inside(target, root))) process.exit(0);

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `Blocked by GotchiBot policy: ${target} is outside the GotchiBot tree (${REPO}). ` +
        `AGENTS.md hard rule 4 / CLAUDE.md hard limit — stay inside this working tree. ` +
        `Writes are also allowed under ~/.claude and the session scratchpad. ` +
        `If Julius wants this file changed, say so and let him run it, or work in a path under the repo.`,
    },
  }),
);
process.exit(0);
