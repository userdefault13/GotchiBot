/**
 * In-memory thread message model for the phone viewer.
 * Pure ES module — no DOM; never persists chat bodies.
 */

/**
 * @typedef {{
 *   threadId?: string,
 *   messageId?: string,
 *   seq: number,
 *   role?: string,
 *   text?: string,
 *   ts?: string,
 *   op?: string,
 *   targetMessageId?: string,
 *   deskId?: string,
 *   heroId?: string,
 *   edited?: boolean,
 *   deleted?: boolean,
 * }} ThreadMessage
 */

export function createThreadModel() {
  /** @type {Map<string, ThreadMessage>} */
  const byKey = new Map();
  let lastSeq = 0;

  function keyOf(msg) {
    if (msg.messageId) return `id:${msg.messageId}`;
    return `seq:${msg.seq}`;
  }

  function findTarget(targetMessageId) {
    if (!targetMessageId) return null;
    return byKey.get(`id:${targetMessageId}`) || null;
  }

  function touchSeq(seq) {
    const n = Number(seq);
    if (Number.isFinite(n) && n > lastSeq) lastSeq = n;
  }

  /**
   * Apply a batch of pull messages (op message|edit|delete).
   * @param {ThreadMessage[]} msgs
   */
  function applyMessages(msgs) {
    if (!Array.isArray(msgs)) return;
    for (const raw of msgs) {
      if (!raw || typeof raw !== "object") continue;
      const op = raw.op || "message";

      if (op === "edit") {
        const target = findTarget(raw.targetMessageId);
        if (target) {
          if (raw.text != null) target.text = String(raw.text);
          target.edited = true;
          touchSeq(raw.seq);
        }
        continue;
      }

      if (op === "delete") {
        const target = findTarget(raw.targetMessageId);
        if (target) {
          target.deleted = true;
          touchSeq(raw.seq);
        }
        continue;
      }

      // op "message" (default): append, de-dupe by messageId / seq
      const k = keyOf(raw);
      if (byKey.has(k)) {
        touchSeq(raw.seq);
        continue;
      }
      // Also skip if same messageId already stored under another key shape
      if (raw.messageId && byKey.has(`id:${raw.messageId}`)) {
        touchSeq(raw.seq);
        continue;
      }
      if (raw.seq != null && byKey.has(`seq:${raw.seq}`) && !raw.messageId) {
        touchSeq(raw.seq);
        continue;
      }

      const entry = {
        threadId: raw.threadId,
        messageId: raw.messageId,
        seq: Number(raw.seq) || 0,
        role: raw.role,
        text: raw.text != null ? String(raw.text) : "",
        ts: raw.ts,
        deskId: raw.deskId,
        heroId: raw.heroId,
        edited: false,
        deleted: false,
      };
      byKey.set(k, entry);
      touchSeq(entry.seq);
    }
  }

  /** Visible messages in seq order (deleted hidden). */
  function list() {
    return [...byKey.values()]
      .filter((m) => !m.deleted)
      .sort((a, b) => a.seq - b.seq || String(a.messageId || "").localeCompare(String(b.messageId || "")));
  }

  return {
    applyMessages,
    list,
    get lastSeq() {
      return lastSeq;
    },
  };
}

/**
 * Relative time label from an ISO timestamp.
 * @param {string} iso
 * @param {number|Date} [now]
 */
export function relativeTime(iso, now = Date.now()) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const n = now instanceof Date ? now.getTime() : Number(now);
  let sec = Math.round((n - t) / 1000);
  if (sec < 0) sec = 0;
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 14) return `${days}d ago`;
  try {
    return new Date(t).toLocaleDateString();
  } catch {
    return iso;
  }
}

/** Map Hub role → CSS class: user | assistant | tool | system */
export function roleClass(role) {
  const r = String(role || "")
    .trim()
    .toLowerCase();
  if (r === "user" || r === "human") return "user";
  if (r === "assistant" || r === "ai" || r === "bot" || r === "model") return "assistant";
  if (r === "tool" || r === "function") return "tool";
  if (r === "system") return "system";
  if (r === "assistant") return "assistant";
  return "system";
}
