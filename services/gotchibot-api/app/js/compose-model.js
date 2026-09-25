/**
 * Pure compose / reply UI helpers for the phone PWA (S2).
 * No DOM — unit-testable; main.js wires these into the thread view.
 */

/** Normal poll while idle. */
export const POLL_INTERVAL_NORMAL_MS = 4000;
/** Faster poll while waiting for hub-runner reply. */
export const POLL_INTERVAL_FAST_MS = 1750;
/** Min gap between GET /hub/runner while waiting. */
export const RUNNER_CHECK_MIN_MS = 10_000;

/** clientMessageId / messageId shape from Hub API. */
export const CLIENT_MESSAGE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Generate an idempotent client message id (UUID hex, no dashes).
 * @returns {string}
 */
export function newClientMessageId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    const id = crypto.randomUUID().replace(/-/g, "");
    if (CLIENT_MESSAGE_ID_RE.test(id)) return id;
  }
  // Fallback: time + random (still matches the charset)
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 14);
  const id = `${t}${r}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128);
  return id || `m${Date.now()}`;
}

/**
 * @param {unknown} id
 * @returns {boolean}
 */
export function isValidClientMessageId(id) {
  return typeof id === "string" && CLIENT_MESSAGE_ID_RE.test(id);
}

/**
 * Settings / notice line for hub-runner status.
 * @param {{ status?: string, detail?: string|null, model?: string|null }|null|undefined} runner
 * @returns {string}
 */
export function formatRunnerStatusLine(runner) {
  if (!runner || typeof runner !== "object") return "unknown";
  const st = String(runner.status || "unknown");
  const bits = [st];
  if (runner.model) bits.push(String(runner.model));
  if ((st === "error" || st === "offline") && runner.detail) {
    bits.push(String(runner.detail));
  }
  return bits.join(" · ");
}

/**
 * Non-blocking notice under the thinking indicator.
 * @param {{ status?: string, detail?: string|null }|null|undefined} runner
 * @returns {string|null}
 */
export function formatRunnerNotice(runner) {
  if (!runner || typeof runner !== "object") return null;
  const st = String(runner.status || "");
  if (st !== "error" && st !== "offline") return null;
  const detail = runner.detail != null ? String(runner.detail).trim() : "";
  if (st === "offline") {
    return detail
      ? detail
      : "Hub runner offline — reply will arrive when it's back";
  }
  // error
  return detail || "Hub runner error — reply will arrive when it's back";
}

/**
 * Latest phone-originated user message (by seq), if any.
 * @param {Array<{ seq?: number, role?: string, originKind?: string, reply?: { status?: string } }>} messages
 */
export function latestPhoneUserMessage(messages) {
  if (!Array.isArray(messages)) return null;
  let best = null;
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    if (m.originKind !== "phone") continue;
    const role = String(m.role || "").toLowerCase();
    if (role && role !== "user" && role !== "human") continue;
    if (!best || Number(m.seq) > Number(best.seq)) best = m;
  }
  return best;
}

/**
 * Pull `after` cursor so in-place reply.status updates are re-fetched.
 * When waiting (pending/claimed) or showing reply error, re-include that message.
 * @param {Array<{ seq?: number, originKind?: string, reply?: { status?: string } }>} messages
 * @param {number} lastSeq
 * @returns {number}
 */
export function pullAfterForReplyWatch(messages, lastSeq) {
  const phone = latestPhoneUserMessage(messages);
  const st = phone?.reply?.status;
  if (
    phone &&
    (st === "pending" || st === "claimed" || st === "error")
  ) {
    const seq = Number(phone.seq) || 0;
    return Math.max(0, seq - 1);
  }
  return Number(lastSeq) || 0;
}

/**
 * @typedef {{
 *   clientMessageId: string,
 *   text: string,
 *   status: "sending"|"failed",
 *   error?: string,
 *   forbidden?: boolean,
 * }} PendingSend
 */

/**
 * Derive thread composer UI flags from confirmed messages + local pending sends.
 *
 * @param {{
 *   messages?: Array<object>,
 *   pendingSends?: PendingSend[],
 *   runner?: { status?: string, detail?: string|null, model?: string|null }|null,
 * }} [input]
 */
export function deriveComposeUi({
  messages = [],
  pendingSends = [],
  runner = null,
} = {}) {
  const confirmedIds = new Set();
  for (const m of messages || []) {
    if (m?.messageId) confirmedIds.add(String(m.messageId));
  }

  /** @type {PendingSend[]} */
  const optimistic = [];
  for (const p of pendingSends || []) {
    if (!p || !p.clientMessageId) continue;
    if (confirmedIds.has(String(p.clientMessageId))) continue;
    optimistic.push(p);
  }

  const phone = latestPhoneUserMessage(messages);
  const replyStatus = phone?.reply?.status
    ? String(phone.reply.status)
    : null;

  const waitingForReply =
    replyStatus === "pending" || replyStatus === "claimed";

  /** @type {{ messageId: string, error: string }|null} */
  let replyError = null;
  if (replyStatus === "error" && phone?.messageId) {
    replyError = {
      messageId: String(phone.messageId),
      error:
        phone.reply?.error != null
          ? String(phone.reply.error)
          : "Reply failed",
    };
  }

  /** messageId → model caption (assistant replyMessageId preferred; phone msg as fallback) */
  /** @type {Map<string, string>} */
  const viaModelByMessageId = new Map();
  for (const m of messages || []) {
    if (
      m?.originKind !== "phone" ||
      m.reply?.status !== "replied" ||
      !m.reply?.model
    ) {
      continue;
    }
    const model = String(m.reply.model);
    if (m.reply.replyMessageId) {
      viaModelByMessageId.set(String(m.reply.replyMessageId), model);
    }
    if (m.messageId) {
      viaModelByMessageId.set(String(m.messageId), model);
    }
  }

  const runnerNotice = waitingForReply ? formatRunnerNotice(runner) : null;

  return {
    optimistic,
    waitingForReply,
    waitingMessageId: waitingForReply && phone?.messageId
      ? String(phone.messageId)
      : null,
    waitingSeq: waitingForReply && phone?.seq != null
      ? Number(phone.seq)
      : null,
    replyError,
    viaModelByMessageId,
    pollIntervalMs: waitingForReply
      ? POLL_INTERVAL_FAST_MS
      : POLL_INTERVAL_NORMAL_MS,
    runnerNotice,
    shouldCheckRunner: waitingForReply,
  };
}
