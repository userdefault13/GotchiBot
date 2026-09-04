#!/usr/bin/env node
/**
 * PreToolUse(Bash) — enforce AGENTS.md hard rule 1: never install anything
 * autonomously. CLAUDE.md says the same for the Hub proxy ("Never install
 * packages, MCP servers, or skills on your own"). Text in a rules file is a
 * suggestion; this hook is the guarantee.
 *
 * Reads the hook payload on stdin, denies with a reason, exits 0 either way
 * (a non-zero exit would look like a broken hook, not a policy decision).
 */
import { readFileSync } from "node:fs";

/** [pattern, what it is] — matched against the whole command string. */
const BLOCKED = [
  [/\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b[^\n]*\s(-g|--global)\b/, "a global package install"],
  [/\bnpm\s+(i|install)\s+(?!--?(save|production|omit|no-|legacy|force|frozen)[\w-]*\b)[@\w][\w@./-]*/, "adding an npm dependency"],
  [/\b(pnpm|yarn|bun)\s+add\b/, "adding a dependency"],
  [/\bbrew\s+(install|tap)\b/, "a Homebrew install"],
  [/\bpip3?\s+install\b/, "a pip install"],
  [/\bpipx\s+install\b/, "a pipx install"],
  [/\bcargo\s+install\b/, "a cargo install"],
  [/\bgem\s+install\b/, "a gem install"],
  [/\bgo\s+install\b/, "a go install"],
  [/\bclaude\s+mcp\s+add\b/, "adding an MCP server"],
  [/\bclaude\s+plugin\s+(install|marketplace\s+add)\b/, "installing a Claude plugin"],
  [/\bopenclaw\s+(plugin|skill)s?\s+(install|add)\b/, "installing an OpenClaw plugin/skill"],
  [/\bnpm\s+publish\b/, "publishing this package to npm"],
];

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  process.exit(0);
}

/**
 * Match against invocations, not payloads. A heredoc that documents an install,
 * or an echoed JSON fixture, is text — denying it is a false positive that
 * teaches people to route around the hook. Quoted text handed to an interpreter
 * (`sh -c '…'`) is NOT stripped: that one is a real invocation.
 *
 * This is a policy guard, not a sandbox. It exists to stop a casual install,
 * and it does that.
 */
function invocationText(command) {
  return command
    .replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?^\s*\2\s*$/gm, " ")
    .replace(/(-c\s*)?'([^']*)'/g, (m, dashC) => (dashC ? m : " "))
    .replace(/(-c\s*)?`([^`]*)`/g, (m, dashC) => (dashC ? m : " "));
}

const command = String(payload?.tool_input?.command || "");
if (!command) process.exit(0);

const scanned = invocationText(command);

for (const [pattern, what] of BLOCKED) {
  if (pattern.test(scanned)) {
    deny(
      `Blocked by GotchiBot policy: this is ${what}. AGENTS.md hard rule 1 — never install anything autonomously (no npm i -g, no new MCP servers, no skill installs). ` +
        `If the tool is genuinely needed, append a request to the session's skill-requests.jsonl and continue without it, or ask Julius to install it. ` +
        `Restoring existing deps from the lockfile (bare "npm install", "npm ci") is allowed.`,
    );
  }
}
process.exit(0);
