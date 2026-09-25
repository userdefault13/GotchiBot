/**
 * platform-guard.mjs — macOS GUI / SSH awareness for graceful desk degradation.
 *
 * Local macOS sessions keep full GUI behavior. Linux and SSH sessions skip
 * window-opening / clipboard-native paths with a one-line stderr note.
 */
import { platform as osPlatform } from "node:os";

/**
 * @param {string} [plat] override for tests (default: process.platform / os.platform())
 */
export function isDarwin(plat = process.platform || osPlatform()) {
  return plat === "darwin";
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 */
export function isOverSsh(env = process.env) {
  return Boolean(env.SSH_TTY || env.SSH_CONNECTION);
}

/**
 * Explicit opt-in to draw on the Mac's screen even from an SSH session
 * (desk-terminals --host imac sets this: it runs over ssh ON PURPOSE to open
 * Terminal.app windows on the iMac console). GOTCHIBOT_ON_IMAC=1 counts too.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 */
export function macGuiForced(env = process.env) {
  return env.GOTCHIBOT_MAC_GUI === "1" || env.GOTCHIBOT_ON_IMAC === "1";
}

/**
 * True when macOS GUI actions (open, Terminal.app, pbcopy) are safe.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @param {string} [plat]
 */
export function macGuiAvailable(env = process.env, plat = process.platform || osPlatform()) {
  return isDarwin(plat) && (!isOverSsh(env) || macGuiForced(env));
}

/**
 * One-line stderr skip note.
 * @param {string} what
 * @param {string} reason e.g. "macOS only" or "over SSH"
 */
export function skipNote(what, reason) {
  console.error(`gotchibot: ${what} skipped (${reason})`);
}
