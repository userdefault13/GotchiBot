/**
 * Commands a meeting gotchi may propose. A gotchi cannot run anything from a
 * meeting; it ends its reply with `ACTION: <command>`, the room shows it, and it
 * runs only when UserDefault types /run (scripts/gotchi-meet.mjs action run).
 *
 * Only desk-seat commands are proposable, with plain arguments: no shell
 * operators, no substitutions — the allowlist is the whole safety story.
 */
import { join } from "node:path";

/** gotchibot subcommands a meeting may propose (wondrstack: status, launch, login only). */
export const MEET_ACTION_SUBCOMMANDS = ["heroes", "seat", "roles", "wondrstack"];

const ALLOWED = new RegExp(
  "^(?:\\./scripts/)?gotchibot\\s+(?:(?:heroes|seat|roles)(?:\\s|$)|wondrstack\\s+(?:status|launch|login)\\s)",
);
/** Letters, digits, spaces and . _ : / @ - only (no ; | & $ ` < > quotes or newlines). */
const SAFE = /^[A-Za-z0-9 ._:/@-]+$/;

/** One proposed command, normalized to ./scripts/gotchibot …, with whether it may run. */
export function normalizeAction(raw) {
  const cmd = String(raw || "")
    .trim()
    .replace(/^`+|`+$/g, "")
    .replace(/^!/, "")
    .trim()
    .replace(/\s+/g, " ");
  if (!cmd || cmd.length > 200 || !SAFE.test(cmd) || !ALLOWED.test(cmd)) return { cmd, allowed: false };
  return { cmd: cmd.replace(/^(?:\.\/scripts\/)?gotchibot/, "./scripts/gotchibot"), allowed: true };
}

/** Split `ACTION: …` lines out of a reply: { text, actions: [{ cmd, allowed }] }. */
export function extractActions(text) {
  const actions = [];
  const body = String(text || "")
    .replace(/^[ \t]*ACTION:[ \t]*(.+?)[ \t]*$/gim, (_, c) => {
      actions.push(normalizeAction(c));
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: body, actions };
}

/** Where the room keeps the one command waiting for /run. */
export function pendingActionPath(meetingsRoot, meetingId) {
  return join(meetingsRoot, String(meetingId), "pending-action.json");
}
