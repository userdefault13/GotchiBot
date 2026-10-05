/**
 * Project desks — one OpenCode orchestrator session per project, shared by every
 * device. The Hub runs `opencode serve` on loopback; phones write into the
 * project's `desk-<slug>` thread, terminals attach to the same session
 * (`gotchibot hub desk open`), and this runner mirrors every finished turn of
 * that session back into the thread so all devices read one conversation.
 */
import { stripReasoningContent, sanitizeRunnerError } from "./runner.mjs";
import {
  classifyModelError,
  hubModelChain,
  hubPrefer,
  loadCooldowns,
  markModelFailed,
  splitModel,
} from "../../scripts/hub-model-chain.mjs";

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
    /** Blocks until the assistant turn finishes. `model` = "provider/model" (else OpenCode's default). */
    async sendMessage(sessionId, { text, agent, system, model }, { timeoutMs = 10 * 60_000 } = {}) {
      const pick = model ? splitModel(model) : null;
      return call("POST", `/session/${encodeURIComponent(sessionId)}/message`, {
        body: {
          parts: [{ type: "text", text }],
          ...(agent ? { agent } : {}),
          ...(system ? { system } : {}),
          ...(pick ? { model: pick } : {}),
        },
        timeoutMs,
      });
    },
    /** Providers + models this OpenCode can use (keys configured). */
    async providers() {
      const r = await call("GET", "/config/providers", { timeoutMs: 5_000 });
      return Array.isArray(r?.providers) ? r.providers : [];
    },
    /** OpenCode's configured default model ("provider/model"). */
    async configModel() {
      const r = await call("GET", "/config", { timeoutMs: 5_000 });
      return r?.model || null;
    },
    /** Custom commands and skills OpenCode can run by name (`/name args`). */
    async listCommands() {
      const rows = await call("GET", "/command");
      return Array.isArray(rows) ? rows : [];
    },
    /** Blocks until the command's assistant turn finishes. */
    async runCommand(sessionId, { command, args = "", agent }, { timeoutMs = 10 * 60_000 } = {}) {
      return call("POST", `/session/${encodeURIComponent(sessionId)}/command`, {
        body: { command, arguments: args, ...(agent ? { agent } : {}) },
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

/**
 * Walk the Hub model chain for one turn. A model failure (quota, auth, rate
 * limit, stuck) cools that model or its provider down and tries the next one;
 * any other error ends the turn. Returns which model answered.
 */
export async function turnWithModelFallback(client, sessionId, attempt, { log = () => {}, root, now } = {}) {
  let providers = [];
  let configModel = null;
  try {
    [providers, configModel] = await Promise.all([client.providers(), client.configModel()]);
  } catch {
    /* OpenCode listing failed: let it use its default */
  }
  const chain = providers.length || configModel
    ? hubModelChain({ configModel, providers, prefer: hubPrefer(root), state: loadCooldowns(root), now })
    : [];
  if (!chain.length) {
    await attempt(undefined);
    return { model: null, fellBack: false };
  }
  const skipped = [];
  let lastErr = null;
  for (const model of chain) {
    try {
      await attempt(model);
      const fellBack = model !== chain[0] || skipped.length > 0;
      return {
        model,
        fellBack,
        note: fellBack ? `answered by ${model} · ${skipped.map((s) => `${s.model} ${s.reason}`).join(" · ")}` : null,
      };
    } catch (err) {
      const cls = classifyModelError(err?.message || err);
      if (!cls) throw err;
      const key = markModelFailed(model, cls, { root });
      skipped.push({ model, reason: cls.reason });
      log("model-fallback", { from: model, cooled: key, reason: cls.reason });
      lastErr = err;
      await client.abort(sessionId).catch(() => {});
    }
  }
  throw new Error(`no model available — ${skipped.map((s) => `${s.model}: ${s.reason}`).join(" · ")}${lastErr ? ` (last: ${String(lastErr.message || lastErr).slice(0, 80)})` : ""}`);
}

/** One line from an OpenCode assistant `info.error` (e.g. "Go usage limit exceeded"). */
export function modelErrorText(error) {
  if (!error) return "";
  const msg = error?.data?.message || error?.message || error?.name || String(error);
  return String(msg).replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Run one turn, but stop early when the model has already failed. OpenCode
 * records a provider error (quota, auth, 5xx) on the assistant message yet can
 * keep the /message request open; the phone used to wait 5 minutes for a bare
 * "fetch failed". Polls the session and aborts with the model's own error.
 */
export async function turnWithModelWatch(client, sessionId, run, { pollMs = 4000, sleepFn } = {}) {
  const since = Date.now() - 2000;
  const wait = sleepFn || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let stop = false;
  const watch = (async () => {
    while (!stop) {
      await wait(pollMs);
      if (stop) return null;
      const rows = await client.listMessages(sessionId, { limit: 5 }).catch(() => []);
      const mine = rows.filter((m) => m?.info?.role === "assistant" && (m.info.time?.created || 0) >= since);
      const failed = mine.findLast((m) => m.info.error);
      if (failed) return modelErrorText(failed.info.error) || "model error";
    }
    return null;
  })();
  try {
    const outcome = await Promise.race([
      run().then((result) => ({ result })),
      watch.then((error) => (error ? { error } : new Promise(() => {}))),
    ]);
    if (outcome.error) {
      await client.abort(sessionId).catch(() => {});
      throw new Error(`model error: ${outcome.error}`);
    }
    return outcome.result;
  } finally {
    stop = true;
  }
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

/** Terminal-only commands (they drive tmux panes); the phone does new/switch itself. */
const PHONE_HIDDEN_COMMANDS = new Set(["new", "resume"]);
const COMMAND_NAME = /^[A-Za-z0-9][\w:./-]{0,63}$/;

/**
 * OpenCode commands a phone may run, trimmed for the wire (no templates).
 * @returns {Array<{ name: string, description: string, source: string, hints: string[] }>}
 */
export function phoneCommands(rows) {
  const seen = new Set();
  const out = [];
  for (const c of Array.isArray(rows) ? rows : []) {
    const name = String(c?.name || "");
    if (!COMMAND_NAME.test(name) || name.startsWith("_") || name.includes("/_")) continue;
    if (PHONE_HIDDEN_COMMANDS.has(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      description: String(c?.description || "").slice(0, 200),
      source: c?.source === "skill" ? "skill" : "command",
      hints: Array.isArray(c?.hints) ? c.hints.map(String).slice(0, 8) : [],
    });
  }
  return out.sort((a, b) => (a.source === b.source ? a.name.localeCompare(b.name) : a.source === "command" ? -1 : 1));
}

/** `/name rest…` → { command, args }, or null for plain text. */
export function parseSlashCommand(text) {
  const m = String(text || "").trim().match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  if (!m || !COMMAND_NAME.test(m[1])) return null;
  return { command: m[1], args: (m[2] || "").trim() };
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
 * so re-mirroring is idempotent. `skipUserTurns` drops every user turn in this
 * pass (a phone slash command's expanded template).
 * @returns {Promise<Array<{ messageId: string, role: string, model: string|null }>>}
 */
export async function mirrorDeskSession({ store, client, slug, threadId, sessionId, heroId = null, skipUserTurns = false }) {
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
    if (role === "user" && (skipUserTurns || phoneTexts.has(text.trim()))) continue;
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

/**
 * The project chat's sessions, most recently active first, with OpenCode titles.
 * Sessions OpenCode no longer has are left out (their turns stay in the thread).
 */
export async function listProjectSessions({ store, client, slug, limit = 30 }) {
  const state = await store.getDeskSession(slug);
  const list = (state?.sessions || []).slice();
  if (state?.sessionId && !list.some((s) => s.sessionId === state.sessionId)) {
    list.push({ sessionId: state.sessionId, startedAt: state.sessionStartedAt || null });
  }
  const at = (s) => String(s.lastActiveAt || s.startedAt || "");
  list.sort((a, b) => at(b).localeCompare(at(a)));
  const infos = await Promise.allSettled(list.slice(0, limit).map((s) => client.getSession(s.sessionId)));
  const out = [];
  infos.forEach((r, i) => {
    const s = list[i];
    if (r.status === "rejected" && r.reason?.status === 404) return;
    const info = r.status === "fulfilled" ? r.value : null;
    const updated = Number(info?.time?.updated) || 0;
    out.push({
      sessionId: s.sessionId,
      title: String(info?.title || "").slice(0, 120) || null,
      startedAt: s.startedAt || null,
      startedBy: s.startedBy || null,
      lastActiveAt: updated ? new Date(updated).toISOString() : s.lastActiveAt || s.startedAt || null,
      current: s.sessionId === state?.sessionId,
    });
  });
  out.sort((a, b) => String(b.lastActiveAt || "").localeCompare(String(a.lastActiveAt || "")));
  return { current: state?.sessionId || null, sessions: out };
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
  graphWatchMs = 120_000,
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

  /** A phone `/name args` naming a runnable OpenCode command; anything else is a prompt. */
  async function resolveSlashCommand(text) {
    const parsed = parseSlashCommand(text);
    if (!parsed) return null;
    const known = phoneCommands(await client.listCommands().catch(() => []));
    return known.some((c) => c.name === parsed.command) ? parsed : null;
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
      const slash = await resolveSlashCommand(claimed.text);
      let fallbackNote = null;
      try {
        if (slash) {
          await turnWithModelWatch(client, sessionId, () =>
            client.runCommand(sessionId, { ...slash, agent }, { timeoutMs: turnTimeoutMs }),
          );
        } else {
          // The Hub picks the model: its configured one first, then the next
          // available model when a provider is out of quota or failing.
          const r = await turnWithModelFallback(client, sessionId, (model) =>
            turnWithModelWatch(client, sessionId, () =>
              client.sendMessage(
                sessionId,
                { text: claimed.text, agent, system: PHONE_TURN_SYSTEM, model },
                { timeoutMs: turnTimeoutMs },
              ),
            ),
          { log },
          );
          if (r.fellBack) fallbackNote = r.note;
        }
      } catch (err) {
        if (err?.name === "TimeoutError" || err?.name === "AbortError") {
          await client.abort(sessionId).catch(() => {});
          throw new Error("timed out — open the desk on a terminal (gotchibot hub desk open) to see what it was waiting on");
        }
        // Node's fetch gives up after 5 min without response headers and only
        // says "fetch failed"; OpenCode answers /message when the turn ends.
        if (err?.message === "fetch failed") {
          await client.abort(sessionId).catch(() => {});
          const code = err?.cause?.code || "";
          throw new Error(
            code === "UND_ERR_HEADERS_TIMEOUT"
              ? "no reply from the model for 5 minutes — it may be stuck or out of quota (check the Hub's opencode log)"
              : `could not reach the Hub's OpenCode${code ? ` (${code})` : ""}`,
          );
        }
        throw err;
      }
      const pushed = await mirrorDeskSession({
        store,
        client,
        slug,
        threadId,
        sessionId,
        heroId,
        skipUserTurns: Boolean(slash),
      });
      let reply = pushed.filter((p) => p.role === "assistant").at(-1);
      if (!reply && slash) {
        reply = { messageId: `cmd-${messageId}`, model: null };
        await store.pushMessages({
          threadId,
          deskId: HUB_DESK_RUNNER_ID,
          messages: [
            {
              messageId: reply.messageId,
              role: "system",
              text: `/${slash.command} finished with no text reply · open the desk on a terminal for its output`,
              op: "message",
              ts: new Date().toISOString(),
            },
          ],
        });
      }
      if (!reply) throw new Error("the orchestrator finished without a text reply");
      if (fallbackNote) {
        await store.pushMessages({
          threadId,
          deskId: HUB_DESK_RUNNER_ID,
          messages: [{ messageId: `model-${messageId}`, role: "system", text: fallbackNote, op: "message", ts: new Date().toISOString() }],
        });
      }
      await store.completeReply({ threadId, messageId, replyMessageId: reply.messageId, model: reply.model });
      log("replied", { project: slug, messageId, ...(slash ? { command: slash.command } : {}) });
    } catch (err) {
      const error = sanitizeRunnerError(err?.message || err);
      await store.failReply({ threadId, messageId, error });
      log("reply-error", { project: slug, messageId, error });
    }
  }

  /** @returns {Promise<boolean>} true when a phone message was handled */
  /**
   * Agent graph watch on the Hub (kanban-manager duty, so it runs with no desk
   * open): stalled / failed handoffs fire once → PM alert + Handoffs card.
   */
  let lastGraphWatchAt = 0;
  async function graphWatch() {
    if (!graphWatchMs || typeof store.listEdges !== "function") return;
    if (Date.now() - lastGraphWatchAt < graphWatchMs) return;
    lastGraphWatchAt = Date.now();
    try {
      const { watchEdges } = await import("../../scripts/agent-graph.mjs");
      const edges = await store.listEdges({});
      const r = await watchEdges({
        edges,
        mark: (e, reason, at) => store.putEdges(HUB_DESK_RUNNER_ID, [{ edgeId: e.edgeId, alertedAt: at, alertReason: reason }]),
      });
      if (r.fired.length) log("graph-watch", { fired: r.fired.length });
    } catch (err) {
      log("graph-watch-error", { error: sanitizeRunnerError(err?.message || err) });
    }
  }

  async function tick() {
    if (busy) return false;
    busy = true;
    try {
      await graphWatch();
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
