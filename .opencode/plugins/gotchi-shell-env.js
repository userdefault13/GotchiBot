/**
 * Gotchi shell env — tells commands which OpenCode session ran them.
 *
 * `./scripts/cursor-cli.mjs run` keys its Cursor chat by OPENCODE_SESSION_ID, so
 * each OpenCode session (a project desk, a sub-agent) continues its own Cursor
 * conversation instead of every bot on the host sharing one.
 *
 * Hook: shell.env (OpenCode >= 1.18).
 */
export const GotchiShellEnv = async () => ({
  "shell.env": async (input, output) => {
    if (input?.sessionID) output.env.OPENCODE_SESSION_ID = input.sessionID;
  },
});
