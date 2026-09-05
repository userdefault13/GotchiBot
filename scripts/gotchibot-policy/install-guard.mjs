/**
 * AGENTS.md hard rule 1 — never install anything autonomously.
 * Shared by Claude PreToolUse(Bash) and Cursor beforeShellExecution.
 *
 * Match against invocations, not payloads. A heredoc that documents an install
 * is text; `sh -c '…'` is a real invocation.
 */

/** [pattern, what it is] — matched against the scanned command string. */
export const INSTALL_BLOCKED = [
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

/** Destructive patterns previously only in Claude permissions.deny. */
export const DESTRUCTIVE_BLOCKED = [
  [/\bgit\s+push\s+[^\n]*--force\b/, "a force-push"],
  [/\bgit\s+reset\s+--hard\b/, "a hard git reset"],
  [/\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|--force\s+)*\/\b/, "rm -rf of /"],
  [/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*|--recursive\s+--force)\s+\/\s*$/, "rm -rf of /"],
];

export function invocationText(command) {
  return String(command || "")
    .replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?^\s*\2\s*$/gm, " ")
    .replace(/(-c\s*)?'([^']*)'/g, (m, dashC) => (dashC ? m : " "))
    .replace(/(-c\s*)?`([^`]*)`/g, (m, dashC) => (dashC ? m : " "));
}

/**
 * @param {string} command
 * @returns {string | null} deny reason, or null if allowed
 */
export function checkShellCommand(command) {
  if (!command) return null;
  const scanned = invocationText(command);

  for (const [pattern, what] of INSTALL_BLOCKED) {
    if (pattern.test(scanned)) {
      return (
        `Blocked by GotchiBot policy: this is ${what}. AGENTS.md hard rule 1 — never install anything autonomously (no npm i -g, no new MCP servers, no skill installs). ` +
        `If the tool is genuinely needed, append a request to the session's skill-requests.jsonl and continue without it, or ask Julius to install it. ` +
        `Restoring existing deps from the lockfile (bare "npm install", "npm ci") is allowed.`
      );
    }
  }

  for (const [pattern, what] of DESTRUCTIVE_BLOCKED) {
    if (pattern.test(scanned)) {
      return (
        `Blocked by GotchiBot policy: this is ${what}. ` +
        `Destructive git/fs operations need Julius to run them explicitly outside the agent loop.`
      );
    }
  }

  return null;
}
