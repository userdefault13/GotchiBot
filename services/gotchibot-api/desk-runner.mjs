/**
 * Project desks — one OpenCode orchestrator session per project, shared by every
 * device. The Hub runs `opencode serve` on loopback; phones write into the
 * project's `desk-<slug>` thread, terminals attach to the same session
 * (`gotchibot hub desk open`), and this runner mirrors every finished turn of
 * that session back into the thread so all devices read one conversation.
 */
import { stripReasoningContent, sanitizeRunnerError } from "./runner.mjs";

export const DEFAULT_OPENCODE_URL = "http://127.0.0.1:4096";
export const DEFAULT_DESK_AGENT = "gotchi";
export const HUB_DESK_RUNNER_ID = "hub-desk";

export const PHONE_TURN_SYSTEM = [
  "This message comes from UserDefault's phone (GotchiBot app, project desk thread).",
  "Call the human UserDefault; never use their real name.",
  "Keep the reply readable on a phone screen.",
  "Nobody at a terminal can approve permission prompts for this turn, so pick commands that are already allowed.",
].join(" ");

/**
 * @param {{ baseUrl?: string, directory: string, password?: string|null, fetchImpl?: typeof fetch }} opts
 */
export function createOpencodeClient({
  baseUrl = DEFAULT_OPENCODE_URL,
  directory,
  password = null,
  fetchImpl = fetch,
} = {}) {
  const base = String(baseUrl).replace(/\/+$/, "");
  const headers = { "content-type": "application/json" };
  if (password) {
    headers.authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  }

  async function call(method, path, { body, timeoutMs = 15_000, query = {} } = {}) {
    const url = new URL(`${base}${path}`);
    if (directory) url.searchParams.set("directory", directory);
    for (const [k, v] of Object.entries(query)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
    const res = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`opencode ${method} ${path} → ${res.status}: ${text.slice(0, 160)}`);
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : null;
  }

  return {
    baseUrl: base,
    directory,
    async health() {
      return call("GET", "/global/health", { timeoutMs: 3_000 });
    },
    async createSession({ title, agent } = {}) {
      const s = await call("POST", "/session", { body: { title, ...(agent ? { agent } : {}) } });
      return String(s.id);
    },
    async deleteSession(sessionId) {
      await call("DELETE", `/session/${encodeURIComponent(sessionId)}`);
    },
    async getSession(sessionId) {
      return call("GET", `/session/${encodeURIComponent(sessionId)}`);
    },
    /** Blocks until the assistant turn finishes. */
    async sendMessage(sessionId, { text, agent, system }, { timeoutMs = 10 * 60_000 } = {}) {
      return call("POST", `/session/${encodeURIComponent(sessionId)}/message`, {
        body: {
          parts: [{ type: "text", text }],
          ...(agent ? { agent } : {}),
          ...(system ? { system } : {}),
        },
        timeoutMs,
      });
    },
    async listMessages(sessionId, { limit = 100 } = {}) {
      const rows = await call("GET", `/session/${encodeURIComponent(sessionId)}/message`, {
        query: { limit },
      });
      return Array.isArray(rows) ? rows : [];
    },
    async abort(sessionId) {
      await call("POST", `/session/${encodeURIComponent(sessionId)}/abort`, { body: {} });
    },
  };
}

/** Visible text of one OpenCode message (no reasoning, tool or synthetic parts). */
export function messageText(msg) {
  const parts = Array.isArray(msg?.parts) ? msg.parts : [];
  const texts = parts
    .filter((p) => p?.type === "text" && !p.synthetic && !p.ignored && typeof p.text === "string")
    .map((p) => p.text.trim())
    .filter(Boolean);
  return stripReasoningContent(texts.join("\n\n"));
}

function isFinished(msg) {
  const info = msg?.info || {};
  if (info.role !== "assistant") return true;
  return Boolean(info.time?.completed || info.error);
}

export function deskThreadTitle(project, slug) {
  return `${project?.title || slug} desk`;
}

/**
 * The project's session id, creating it on first use. Two callers racing get
 * the same session: the loser deletes the one it made.
 */
export async function ensureDeskSession({ store, client, slug, title, agent = DEFAULT_DESK_AGENT }) {
  const existing = await store.getDeskSession(slug);
  if (existing?.sessionId) {
    try {
      await client.getSession(existing.sessionId);
      return existing.sessionId;
    } catch (err) {
      if (err?.status !== 404) throw err;
      await store.resetDeskSession(slug, existing.sessionId);
    }
  }
  const created = await client.createSession({ title: title || `${slug} desk`, agent });
  const won = await store.claimDeskSession(slug, created);
  if (won !== created) {
    await client.deleteSession(created).catch(() => {});
  }
  return won;
}

/**
 * Copy finished session turns the thread doesn't have yet. User turns the phone
 * already wrote (same text) are skipped; everything else — desk-typed prompts
 * and every assistant reply — lands in the thread under its OpenCode message id,
 * so re-mirroring is idempotent.
 * @returns {Promise<Array<{ messageId: string, role: string, model: string|null }>>}
 */
export async function mirrorDeskSession({ store, client, slug, threadId, sessionId, heroId = null }) {
  const state = await store.getDeskSession(slug);
  const entry = (state?.sessions || []).find((s) => s.sessionId === sessionId);
  const after = entry
    ? entry.lastMirroredId || ""
    : state?.sessionId === sessionId
      ? state.lastMirroredId || ""
      : "";
  const rows = await client.listMessages(sessionId, { limit: 200 });
  rows.sort((a, b) => String(a?.info?.id).localeCompare(String(b?.info?.id)));

  const context = await store.getThreadMessagesForContext(threadId, { limit: 50 });
  const phoneTexts = new Set(
    context.filter((m) => m.originKind === "phone").map((m) => String(m.text || "").trim()),
  );

  const pushed = [];
  let last = after;
  for (const msg of rows) {
    const id = String(msg?.info?.id || "");
    if (!id || (after && id <= after)) continue;
    if (!isFinished(msg)) break;
    last = id;
    const role = msg.info.role === "assistant" ? "assistant" : "user";
    const text = messageText(msg);
    if (!text) continue;
    if (role === "user" && phoneTexts.has(text.trim())) continue;
    await store.pushMessages({
      threadId,
      deskId: HUB_DESK_RUNNER_ID,
      messages: [
        {
          messageId: id,
          role,
          text,
          op: "message",
          ts: new Date(Number(msg.info.time?.created) || Date.now()).toISOString(),
          ...(role === "assistant" && heroId ? { heroId } : {}),
        },
      ],
    });
    pushed.push({ messageId: id, role, model: msg.info.modelID || null });
  }
  if (last && last !== after) await store.setDeskMirrored(slug, sessionId, last);
  return pushed;
}

export function sessionDividerText(startedBy) {
  return `New session · started on ${startedBy || "a device"}`;
}

/**
 * Start a fresh agent context in the project's one chat: a new OpenCode session
 * becomes current and a divider lands in the thread so every device sees where
 * the new context begins. The old session keeps mirroring (listDeskSessions).
 * @returns {Promise<{ threadId: string, sessionId: string, startedAt: string }>}
 */
export async function startNewDeskSession({ store, client, slug, title, startedBy = null, agent = DEFAULT_DESK_AGENT }) {
  const { threadId } = await store.ensureDeskThread({ slug, title });
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const sessionId = await client.createSession({ title: `${title || `${slug} desk`} · ${stamp}`, agent });
  const { startedAt } = await store.startDeskSession(slug, sessionId, startedBy);
  await store.pushMessages({
    threadId,
    deskId: HUB_DESK_RUNNER_ID,
    messages: [
      {
        messageId: `session-${sessionId}`,
        role: "system",
        text: sessionDividerText(startedBy),
        op: "message",
        ts: startedAt,
      },
    ],
  });
  return { threadId, sessionId, startedAt };
}

export function sessionSwitchText(startedBy) {
  return `Switched session · on ${startedBy || "a device"}`;
}

/**
 * A terminal opened a session itself (OpenCode `/new`, or picked one from its
 * session list): make it the chat's current session so every device follows.
 * Sub-agent child sessions and other projects' sessions are refused.
 * @returns {Promise<{ threadId: string, sessionId: string, startedAt: string, resumed: boolean }>}
 */
export async function adoptDeskSessionFromTerminal({ store, client, slug, title, sessionId, startedBy = null }) {
  const info = await client.getSession(sessionId);
  if (info?.parentID) {
    throw Object.assign(new Error("that is a sub-agent session; only top-level sessions sync"), { status: 400 });
  }
  const owner = await store.deskSessionOwner(sessionId);
  if (owner && owner !== slug) {
    throw Object.assign(new Error(`that session belongs to the ${owner} chat`), { status: 409 });
  }
  const { threadId } = await store.ensureDeskThread({ slug, title });
  const current = await store.getDeskSession(slug);
  if (current?.sessionId === sessionId) {
    return { threadId, sessionId, startedAt: current.sessionStartedAt, resumed: true };
  }
  const { startedAt, resumed } = await store.adoptDeskSession(slug, sessionId, startedBy);
  const ts = new Date().toISOString();
  await store.pushMessages({
    threadId,
    deskId: HUB_DESK_RUNNER_ID,
    messages: [
      resumed
        ? {
            messageId: `switch-${sessionId}-${Date.now()}`,
            role: "system",
            text: sessionSwitchText(startedBy),
            op: "message",
            ts,
          }
        : {
            messageId: `session-${sessionId}`,
            role: "system",
            text: sessionDividerText(startedBy),
            op: "message",
            ts: startedAt,
          },
    ],
  });
  return { threadId, sessionId, startedAt, resumed };
}

/**
 * @param {{
 *   store: object,
 *   client: ReturnType<typeof createOpencodeClient>,
 *   orchestratorHeroId?: () => string|null,
 *   agent?: string,
 *   pollMs?: number,
 *   mirrorMs?: number,
 *   turnTimeoutMs?: number,
 *   staleMs?: number,
 *   logger?: { info?: Function, log?: Function },
 * }} opts
 */
export function createDeskRunner({
  store,
  client,
  orchestratorHeroId = () => null,
  agent = DEFAULT_DESK_AGENT,
  pollMs = 2_000,
  mirrorMs = 5_000,
  turnTimeoutMs = 10 * 60_000,
  staleMs = 15 * 60_000,
  logger = console,
} = {}) {
  let stopping = false;
  let busy = false;
  let timer = null;
  let lastMirrorAt = 0;
  let lastError = null;

  function log(event, fields = {}) {
    const parts = [`[desk-runner] ${event}`];
    for (const [k, v] of Object.entries(fields)) if (v != null && v !== "") parts.push(`${k}=${v}`);
    (logger.info || logger.log || console.log).call(logger, parts.join(" "));
  }

  async function mirrorAll() {
    for (const s of await store.listDeskSessions()) {
      if (!s.sessionId) continue;
      const ids = (s.sessions?.length ? s.sessions : [{ sessionId: s.sessionId }])
        .slice()
        .sort((a, b) => String(a.startedAt || "").localeCompare(String(b.startedAt || "")))
        .map((x) => x.sessionId);
      if (!ids.includes(s.sessionId)) ids.push(s.sessionId);
      for (const sessionId of ids) {
        try {
          const pushed = await mirrorDeskSession({
            store,
            client,
            slug: s.slug,
            threadId: s.threadId,
            sessionId,
            heroId: orchestratorHeroId(),
          });
          if (pushed.length) log("mirrored", { project: s.slug, session: sessionId, messages: pushed.length });
        } catch (err) {
          // An older session deleted in OpenCode just stops syncing; its turns stay in the thread.
          if (err?.status === 404 && sessionId !== s.sessionId) continue;
          log("mirror-error", { project: s.slug, session: sessionId, error: sanitizeRunnerError(err?.message || err) });
        }
      }
    }
  }

  async function answer(claimed) {
    const threadId = claimed.threadId;
    const messageId = claimed.messageId;
    const thread = await store.getThread(threadId);
    const slug = thread?.project;
    if (!slug) {
      await store.failReply({ threadId, messageId, error: "desk thread has no project" });
      return;
    }
    const title = thread.title || `${slug} desk`;
    const heroId = orchestratorHeroId();
    try {
      const sessionId = await ensureDeskSession({ store, client, slug, title, agent });
      await store.linkDeskThread(slug, threadId);
      await mirrorDeskSession({ store, client, slug, threadId, sessionId, heroId });
      try {
        await client.sendMessage(
          sessionId,
          { text: claimed.text, agent, system: PHONE_TURN_SYSTEM },
          { timeoutMs: turnTimeoutMs },
        );
      } catch (err) {
        if (err?.name === "TimeoutError" || err?.name === "AbortError") {
          await client.abort(sessionId).catch(() => {});
          throw new Error("timed out — open the desk on a terminal (gotchibot hub desk open) to see what it was waiting on");
        }
        throw err;
      }
      const pushed = await mirrorDeskSession({ store, client, slug, threadId, sessionId, heroId });
      const reply = pushed.filter((p) => p.role === "assistant").at(-1);
      if (!reply) throw new Error("the orchestrator finished without a text reply");
      await store.completeReply({ threadId, messageId, replyMessageId: reply.messageId, model: reply.model });
      log("replied", { project: slug, messageId });
    } catch (err) {
      const error = sanitizeRunnerError(err?.message || err);
      await store.failReply({ threadId, messageId, error });
      log("reply-error", { project: slug, messageId, error });
    }
  }

  /** @returns {Promise<boolean>} true when a phone message was handled */
  async function tick() {
    if (busy) return false;
    busy = true;
    try {
      try {
        await client.health();
        if (lastError) log("opencode-ok");
        lastError = null;
      } catch (err) {
        const detail = sanitizeRunnerError(err?.message || err);
        if (detail !== lastError) log("opencode-unreachable", { url: client.baseUrl, error: detail });
        lastError = detail;
        return false;
      }
      const claimed = await store.claimNextPendingReply({
        runnerId: HUB_DESK_RUNNER_ID,
        threadKind: "desk",
        staleMs,
      });
      if (claimed) {
        await answer(claimed);
        return true;
      }
      if (Date.now() - lastMirrorAt >= mirrorMs) {
        lastMirrorAt = Date.now();
        await mirrorAll();
      }
      return false;
    } finally {
      busy = false;
    }
  }

  async function loop() {
    if (stopping) return;
    let worked = false;
    try {
      worked = await tick();
    } catch (err) {
      log("tick-threw", { error: sanitizeRunnerError(err?.message || err) });
    }
    if (stopping) return;
    timer = setTimeout(() => loop().catch(() => {}), worked ? 250 : pollMs);
  }

  return {
    tick,
    mirrorAll,
    start() {
      stopping = false;
      log("start", { opencode: client.baseUrl, agent });
      loop().catch(() => {});
    },
    async stop() {
      stopping = true;
      if (timer) clearTimeout(timer);
      const deadline = Date.now() + 10_000;
      while (busy && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    },
  };
}
