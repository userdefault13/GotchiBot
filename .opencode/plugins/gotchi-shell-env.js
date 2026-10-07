/**
 * Gotchi shell env — tells commands which OpenCode session ran them.
 *
 * `./scripts/cursor-cli.mjs run` keys its Cursor chat by OPENCODE_SESSION_ID, so
 * each OpenCode session (a project desk, a sub-agent) continues its own Cursor
 * conversation instead of every bot on the host sharing one.
 *
 * Also GOTCHIBOT_PROJECT: the project whose desk chat this session is (from
 * sessions/.desk-session-projects.json, kept by the Hub desk runner), so the
 * bot's commands act on its chat's project, not the Hub machine's current one.
 *
 * Hook: shell.env (OpenCode >= 1.18).
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.GOTCHIBOT_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SESSION_PROJECTS = join(ROOT, "sessions", ".desk-session-projects.json");

/** Which project a Hub desk session belongs to (map kept by the desk runner). */
function projectOfSession(sessionID) {
  try {
    const slug = JSON.parse(readFileSync(SESSION_PROJECTS, "utf8"))?.[sessionID];
    return typeof slug === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(slug) ? slug : null;
  } catch {
    return null;
  }
}

export const GotchiShellEnv = async () => ({
  "shell.env": async (input, output) => {
    if (!input?.sessionID) return;
    output.env.OPENCODE_SESSION_ID = input.sessionID;
    // Commands from a project's chat act on that project (roles, tickets,
    // seats): GOTCHIBOT_PROJECT wins over the machine's current project.
    const project = projectOfSession(input.sessionID);
    if (project) output.env.GOTCHIBOT_PROJECT = project;
  },
});
