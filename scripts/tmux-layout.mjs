/**
 * Safe GotchiBot tmux layout runner.
 *
 * Always invoke orchestrator-layout.sh via `tmux run-shell` so kill-pane /
 * respawn-pane cannot abort a work.1/work.2 child mid-flight (Files-only crash).
 *
 *   import { runLayout, tmuxSessionName } from "./tmux-layout.mjs";
 *   runLayout("leave-meet-gallery", { background: true, target: "work.0" });
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = `${ROOT}/scripts/orchestrator-layout.sh`;

const ALLOWED = new Set([
  "ensure",
  "refresh",
  "refresh-soft",
  "fit",
  "fit-quiet",
  "install-mouse",
  "sidebar",
  "files-max",
  "enter-files-max",
  "show-avatar",
  "avatar",
  "avatar-max",
  "enter-avatar-max",
  "chat-max",
  "chat",
  "enter-chat-max",
  "enter-meet-gallery",
  "meet-gallery",
  "refresh-meet-gallery",
  "leave-meet-gallery",
  "require-three",
]);

export function tmuxSessionName(preferred) {
  const env = preferred || process.env.GOTCHIBOT_TMUX_SESSION || "gotchibot";
  if (process.env.TMUX) return env;
  const r = spawnSync("tmux", ["has-session", "-t", env], { stdio: "ignore" });
  return r.status === 0 ? env : null;
}

/**
 * @param {string} cmd
 * @param {{ background?: boolean, target?: string, sess?: string, env?: Record<string,string>, inheritStdio?: boolean }} [opts]
 */
export function runLayout(cmd, opts = {}) {
  const name = String(cmd || "").trim();
  if (!ALLOWED.has(name)) return { ok: false, reason: "unknown-cmd" };
  const sess = opts.sess || tmuxSessionName();
  if (!sess) return { ok: false, reason: "no-session" };

  const envExtra = opts.env || {};
  const exportEnv = Object.entries({
    GOTCHIBOT_TMUX_SESSION: sess,
    GOTCHIBOT_LAYOUT_SAFE: "1",
    ...envExtra,
  })
    .map(([k, v]) => `${k}=${JSON.stringify(String(v))}`)
    .join(" ");

  const shell = `cd ${JSON.stringify(ROOT)} && ${exportEnv} ${JSON.stringify(SCRIPT)} ${name}`;
  const args = ["run-shell"];
  if (opts.background) args.push("-b");
  if (opts.target) {
    const t = opts.target.includes(":") ? opts.target : `${sess}:${opts.target}`;
    args.push("-t", t);
  }
  args.push(shell);

  const r = spawnSync("tmux", args, {
    cwd: ROOT,
    stdio: opts.inheritStdio ? "inherit" : "ignore",
    env: { ...process.env, GOTCHIBOT_TMUX_SESSION: sess },
  });
  return { ok: r.status === 0, status: r.status ?? 1 };
}

export { ALLOWED as LAYOUT_CMDS, ROOT as LAYOUT_ROOT, SCRIPT as LAYOUT_SCRIPT };
