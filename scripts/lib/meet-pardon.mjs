/**
 * Meet "pardon me" cooperative pause / stack helpers.
 * Used by gotchi-meet.mjs (and optionally the room prompter).
 *
 * Files under sessions/meetings/<id>/:
 *   pardon.request      — prompter asks sayTurn to pause after current speaker
 *   pardon-round.json   — in-flight multi-speaker round (for crash/SIGTERM recovery)
 *   pardon-stack.json   — parked round (remaining speakers + original prompt)
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MEETINGS = `${ROOT}/sessions/meetings`;

export function meetingDir(id) {
  return `${MEETINGS}/${id}`;
}

export function pardonRequestPath(id) {
  return `${meetingDir(id)}/pardon.request`;
}

export function pardonStackPath(id) {
  return `${meetingDir(id)}/pardon-stack.json`;
}

export function pardonRoundPath(id) {
  return `${meetingDir(id)}/pardon-round.json`;
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`);
}

export function stripPardonPrefix(text) {
  let t = String(text || "").trim();
  // /pardon <question>
  t = t.replace(/^\/pardon(?:me)?\s+/i, "").trim();
  // pardon me, / pardon me: / pardon me
  t = t.replace(/^pardon\s+me\s*[,:]?\s*/i, "").trim();
  return t;
}

/** True if line is a pardon trigger (slash or "pardon me," / "pardon me:"). */
export function isPardonTrigger(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (/^\/pardon(?:me)?(?:\s|$)/i.test(t)) return true;
  if (/^pardon\s+me\s*[,:]?\s*/i.test(t)) return true;
  return false;
}

export function isContinueTrigger(text) {
  const t = String(text || "").trim().toLowerCase();
  return t === "/continue" || t === "/resume";
}

export function writePardonRequest(meetingId, payload) {
  const id = String(meetingId || "").trim();
  if (!id) return;
  writeJson(pardonRequestPath(id), {
    question: String(payload?.question || "").trim(),
    raw: String(payload?.raw || payload?.question || "").trim(),
    requestedAt: new Date().toISOString(),
  });
}

export function readPardonRequest(meetingId) {
  const id = String(meetingId || "").trim();
  if (!id) return null;
  return readJson(pardonRequestPath(id), null);
}

export function clearPardonRequest(meetingId) {
  try {
    unlinkSync(pardonRequestPath(meetingId));
  } catch {
    /* ok */
  }
}

export function writePardonRound(meetingId, round) {
  writeJson(pardonRoundPath(meetingId), {
    ...round,
    meetingId,
    updatedAt: new Date().toISOString(),
  });
}

export function readPardonRound(meetingId) {
  return readJson(pardonRoundPath(meetingId), null);
}

export function clearPardonRound(meetingId) {
  try {
    unlinkSync(pardonRoundPath(meetingId));
  } catch {
    /* ok */
  }
}

export function writePardonStack(meetingId, stack) {
  writeJson(pardonStackPath(meetingId), {
    ...stack,
    meetingId,
    parkedAt: stack?.parkedAt || new Date().toISOString(),
  });
}

export function readPardonStack(meetingId) {
  return readJson(pardonStackPath(meetingId), null);
}

export function clearPardonStack(meetingId) {
  try {
    unlinkSync(pardonStackPath(meetingId));
  } catch {
    /* ok */
  }
}

export function hasPardonStack(meetingId) {
  return Boolean(readPardonStack(meetingId)?.remainingSpeakerIds?.length);
}

/**
 * Build a stack from an in-flight round (after cooperative pause or SIGTERM).
 * remaining = speakers not yet in spokenIds.
 */
export function stackFromRound(round, { reason = "pardon" } = {}) {
  if (!round) return null;
  const speakers = Array.isArray(round.speakers) ? round.speakers : [];
  const spoken = Array.isArray(round.spokenIds) ? round.spokenIds : [];
  const remaining = speakers.filter((id) => !spoken.includes(id));
  if (!remaining.length && !spoken.length) return null;
  return {
    originalUserText: round.originalUserText || "",
    remainingSpeakerIds: remaining,
    spokenIds: spoken,
    speakers,
    pickNote: round.pickNote || null,
    meetingId: round.meetingId,
    reason,
    parkedAt: new Date().toISOString(),
  };
}

export const PARDON_PAUSE_MARKER = "⏸ Pardon me — round paused";
export const PARDON_CONTINUE_MARKER = "▶ Continuing parked round";
export const PARDON_HELP =
  "Pardon resolved. /continue — resume remaining speakers · new say / @everyone / steer — clears parked round.";
