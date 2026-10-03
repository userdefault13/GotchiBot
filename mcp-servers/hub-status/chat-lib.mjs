/**
 * Desk chat + task handoff against the pinned Hub API.
 *
 * Uses the existing routes only:
 *   POST /api/gotchibot/chats/send
 *   GET  /api/gotchibot/chats/pull
 *   GET  /api/gotchibot/hub/runner
 *
 * There is no hub ping RPC. A chat whose text is "ping" is an ordinary send.
 * The expected assistant reply is the single word "pong" when a phone-reply
 * runner writes one. This module never invents that word and never starts a
 * runner, bridge, or receiver.
 *
 * Desk-kind tokens are stored with reply.status "none" and are not queued.
 * A handoff that the hub accepts is enough when no runner reply arrives.
 *
 * Auth: GOTCHIBOT_DESK_TOKEN or sessions/.hub.json (gitignored). Never copied
 * into the result.
 */
import { assertChatDeskAllowed, deskAuthHeaders } from "../../scripts/infra-client.mjs";

export const PING_TEXT = "ping";
export const EXPECTED_PING_REPLY = "pong";

const TEXT_MAX = 32_000;
const WAIT_MAX = 20_000;
const THREAD_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function redactSecrets(value) {
  return String(value ?? "")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted key]")
    .replace(/gbd_[A-Za-z0-9_-]{6,}/g, "gbd_[redacted]")
    .replace(/gbv_[A-Za-z0-9_-]{6,}/g, "gbv_[redacted]")
    .replace(/\b(?:sk|rk|pk)_[A-Za-z0-9]{8,}\b/g, "[redacted]")
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted jwt]")
    .replace(/X-GotchiBot-Desk-Token:\s*\S+/gi, "X-GotchiBot-Desk-Token: [redacted]");
}

function clip(value, max = 240) {
  const s = redactSecrets(value).replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

export function normalizeChatArgs({ mode, text, threadId, waitMs } = {}) {
  const kind = mode === "handoff" ? "handoff" : mode === "chat" ? "chat" : "";
  if (!kind) {
    const err = new Error('mode must be "chat" or "handoff"');
    err.status = 400;
    throw err;
  }
  const body = String(text ?? "");
  if (!body.trim()) {
    const err = new Error(kind === "handoff" ? "task required" : "text required");
    err.status = 400;
    throw err;
  }
  if (body.length > TEXT_MAX) {
    const err = new Error(`text must be at most ${TEXT_MAX} characters`);
    err.status = 400;
    throw err;
  }
  let tid;
  if (threadId != null && String(threadId).trim() !== "") {
    tid = String(threadId).trim();
    if (!THREAD_ID.test(tid)) {
      const err = new Error("threadId must be 1-128 of [A-Za-z0-9_-]");
      err.status = 400;
      throw err;
    }
  }
  let wait = kind === "handoff" ? 0 : 8_000;
  if (waitMs != null && waitMs !== "") {
    const n = Number(waitMs);
    if (!Number.isFinite(n) || n < 0 || n > WAIT_MAX) {
      const err = new Error(`waitMs must be a number from 0 to ${WAIT_MAX}`);
      err.status = 400;
      throw err;
    }
    wait = n;
  }
  const ping = kind === "chat" && body.trim().toLowerCase() === PING_TEXT;
  return {
    mode: kind,
    text: body,
    title: kind === "handoff" ? "handoff" : ping ? "ping" : undefined,
    threadId: tid,
    waitMs: wait,
    ping,
  };
}

async function hubFetch(env, fetchImpl, method, path, { query, body, timeoutMs = 8_000 } = {}) {
  const { base } = assertChatDeskAllowed(env);
  const headers = { ...deskAuthHeaders(env) };
  const url = new URL(`${base}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v != null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  if (body != null) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetchImpl(url, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const err = new Error(clip(e?.message || e, 300));
    err.status = 0;
    throw err;
  }
  const raw = await res.text();
  let json;
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    json = { error: clip(raw, 200) };
  }
  if (!res.ok) {
    const err = new Error(clip(json.error || `HTTP ${res.status}`));
    err.status = res.status;
    throw err;
  }
  return json;
}

function publicRunner(json) {
  const runner = json?.runner;
  if (!runner || typeof runner !== "object") return null;
  const out = {};
  if (runner.status != null) out.status = clip(runner.status, 32);
  if (runner.detail != null) out.detail = clip(runner.detail, 200);
  if (runner.model != null) out.model = clip(runner.model, 80);
  if (runner.lastBeatAt != null) out.lastBeatAt = clip(runner.lastBeatAt, 40);
  return out;
}

function assistantAfter(pull, afterSeq) {
  const messages = Array.isArray(pull?.messages) ? pull.messages : [];
  const hits = messages.filter((m) => {
    if (!m || typeof m !== "object") return false;
    if (String(m.op || "message") !== "message") return false;
    if (String(m.role || "") !== "assistant") return false;
    if (Number(m.seq) <= Number(afterSeq)) return false;
    return typeof m.text === "string" && m.text.trim() !== "";
  });
  if (!hits.length) return null;
  const last = hits[hits.length - 1];
  return {
    role: "assistant",
    text: redactSecrets(last.text),
    messageId: String(last.messageId || ""),
    seq: last.seq,
  };
}

function noReplyNote({ mode, ack, runner }) {
  const status = ack?.status || "unknown";
  const runnerBit = runner?.status
    ? `runner ${runner.status}${runner.detail ? ` (${runner.detail})` : ""}`
    : "runner status unknown";
  if (status === "none") {
    return `Hub accepted the ${mode}. reply.status is none, so this desk token did not queue a phone-reply run. ${runnerBit}. No assistant reply was invented.`;
  }
  if (status === "pending" || status === "claimed") {
    return `Hub accepted the ${mode} and queued it (${status}). No assistant reply arrived before the wait ended. ${runnerBit}. Bridge and receiver were not started.`;
  }
  if (status === "error") {
    return `Hub accepted the ${mode} but the queued reply failed. ${runnerBit}.`;
  }
  return `Hub accepted the ${mode}. No assistant reply. ${runnerBit}.`;
}

/**
 * Send a chat message or a task handoff. Returns the hub ack plus an assistant
 * reply only when the hub actually wrote one.
 */
export async function talkToHub({
  mode,
  text,
  threadId,
  waitMs,
  env = process.env,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
} = {}) {
  const args = normalizeChatArgs({ mode, text, threadId, waitMs });
  const started = now();
  const sent = await hubFetch(env, fetchImpl, "POST", "/api/gotchibot/chats/send", {
    body: {
      text: args.text,
      ...(args.title ? { title: args.title } : {}),
      ...(args.threadId ? { threadId: args.threadId } : {}),
    },
  });
  const ackStatus = String(sent?.reply?.status || "unknown");
  const ack = { status: clip(ackStatus, 32) };
  const userSeq = Number(sent?.seq) || 0;
  let runner = null;
  try {
    runner = publicRunner(
      await hubFetch(env, fetchImpl, "GET", "/api/gotchibot/hub/runner", { timeoutMs: 5_000 }),
    );
  } catch (e) {
    runner = { status: "unreachable", detail: clip(e?.message || e, 200) };
  }

  let reply = null;
  const shouldWait = ack.status === "pending" || ack.status === "claimed";
  const deadline = started + (shouldWait ? args.waitMs : 0);
  let pullError = null;
  do {
    try {
      const pull = await hubFetch(env, fetchImpl, "GET", "/api/gotchibot/chats/pull", {
        query: { threadId: sent.threadId, after: userSeq, limit: 50 },
        timeoutMs: 5_000,
      });
      reply = assistantAfter(pull, userSeq);
      if (reply) break;
    } catch (e) {
      pullError = clip(e?.message || e, 200);
      break;
    }
    if (!shouldWait || now() >= deadline) break;
    const left = deadline - now();
    await sleep(Math.min(400, Math.max(0, left)));
  } while (now() < deadline);

  const ping = args.ping
    ? {
        sent: true,
        expected: EXPECTED_PING_REPLY,
        protocol:
          "ordinary POST /api/gotchibot/chats/send of the text ping; the hub does not define a separate ping reply",
        matched: Boolean(reply && reply.text.trim().toLowerCase() === EXPECTED_PING_REPLY),
      }
    : undefined;

  const out = {
    ok: sent?.ok !== false,
    mode: args.mode,
    accepted: true,
    threadId: sent?.threadId ? String(sent.threadId) : null,
    messageId: sent?.messageId ? String(sent.messageId) : null,
    seq: userSeq || null,
    ack,
    reply,
    ...(ping ? { ping } : {}),
    runner,
    waitedMs: Math.max(0, now() - started),
  };
  if (!reply) {
    out.note = noReplyNote({ mode: args.mode, ack, runner });
    if (pullError) out.pullError = pullError;
  }
  return out;
}
