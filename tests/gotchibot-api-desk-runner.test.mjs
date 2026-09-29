/**
 * Project desks: one OpenCode orchestrator session per project, mirrored into a
 * shared `desk-<slug>` Hub thread that every device sees.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoClient } from "mongodb";
import {
  adoptDeskSessionFromTerminal,
  createDeskRunner,
  ensureDeskSession,
  listProjectSessions,
  messageText,
  mirrorDeskSession,
  parseSlashCommand,
  phoneCommands,
  sessionDividerText,
  sessionSwitchText,
  startNewDeskSession,
} from "../services/gotchibot-api/desk-runner.mjs";
import { connectStore, deskThreadId } from "../services/gotchibot-api/store.mjs";
import { createApiServer } from "../services/gotchibot-api/server.mjs";
import { createProjectSource } from "../services/gotchibot-api/projects.mjs";
import { deskDeviceLabel, deskSyncEnv, remoteAttachCommand, renderDeskUnit } from "../scripts/hub-desk.mjs";
import {
  deskThreadId as appDeskThreadId,
  filterSlashCommands,
  phoneSlashCommand,
  slashQuery,
} from "../services/gotchibot-api/app/js/desk-model.js";

let clock = 1_790_000_000_000;
const nextId = () => `msg_${(clock++).toString(16)}`;

function userMsg(text, id = nextId()) {
  return { info: { id, role: "user", time: { created: clock } }, parts: [{ type: "text", text }] };
}

function assistantMsg(text, { id = nextId(), done = true } = {}) {
  return {
    info: { id, role: "assistant", modelID: "glm-5.2", time: { created: clock, ...(done ? { completed: clock } : {}) } },
    parts: [
      { type: "reasoning", text: "thinking…" },
      { type: "tool", tool: "bash" },
      { type: "text", text },
    ],
  };
}

/** In-memory stand-in for the OpenCode server. */
function fakeOpencode({ reply = (text) => `re: ${text}`, hang = false } = {}) {
  const sessions = new Map();
  let n = 0;
  const notFound = () => Object.assign(new Error("not found"), { status: 404 });
  return {
    baseUrl: "http://127.0.0.1:4096",
    sessions,
    created: [],
    deleted: [],
    aborted: [],
    async health() {
      return { healthy: true };
    },
    async createSession() {
      const id = `ses_${++n}`;
      sessions.set(id, []);
      this.created.push(id);
      return id;
    },
    parents: new Map(),
    titles: new Map(),
    async getSession(id) {
      if (!sessions.has(id)) throw notFound();
      const parentID = this.parents.get(id);
      const title = this.titles.get(id);
      return { id, ...(parentID ? { parentID } : {}), ...(title ? { title } : {}) };
    },
    commands: [
      { name: "review", description: "Review the diff", source: "command", template: "Review $ARGUMENTS", hints: ["$ARGUMENTS"] },
      { name: "quiet", description: "No text", source: "command", template: "q" },
      { name: "new", description: "TUI new", source: "command", template: "x" },
      { name: "_disabled/prof", description: "", source: "command", template: "x" },
      { name: "Gotchiverse map", description: "spaced", source: "skill", template: "x" },
      { name: "jev", description: "Jev skill", source: "skill", template: "x" },
    ],
    ran: [],
    async listCommands() {
      return this.commands;
    },
    async runCommand(id, { command, args, agent }) {
      const rows = sessions.get(id);
      if (!rows) throw notFound();
      this.ran.push({ id, command, args, agent });
      const tpl = this.commands.find((c) => c.name === command)?.template || "";
      rows.push(userMsg(tpl.replace("$ARGUMENTS", args)));
      const out = command === "quiet" ? { info: { id: nextId(), role: "assistant", time: { created: clock, completed: clock } }, parts: [{ type: "tool" }] } : assistantMsg(`ran ${command}: ${args}`);
      rows.push(out);
      return out;
    },
    async deleteSession(id) {
      sessions.delete(id);
      this.deleted.push(id);
    },
    async sendMessage(id, { text }) {
      if (hang) throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      const rows = sessions.get(id);
      if (!rows) throw notFound();
      rows.push(userMsg(text));
      const out = assistantMsg(reply(text));
      rows.push(out);
      return out;
    },
    async listMessages(id) {
      return [...(sessions.get(id) || [])];
    },
    async abort(id) {
      this.aborted.push(id);
    },
  };
}

/** The subset of the Mongo store the desk runner uses. */
function memoryStore() {
  const desk = new Map();
  const threads = new Map();
  const messages = [];
  const replies = [];
  return {
    desk,
    threads,
    messages,
    replies,
    async getDeskSession(slug) {
      const d = desk.get(slug);
      return d ? structuredClone({ slug, ...d }) : null;
    },
    async listDeskSessions() {
      return [...desk.entries()].filter(([, d]) => d.sessionId).map(([slug, d]) => structuredClone({ slug, ...d }));
    },
    async linkDeskThread(slug, threadId) {
      desk.set(slug, { sessionId: null, lastMirroredId: null, sessions: [], ...desk.get(slug), threadId });
    },
    async ensureDeskThread({ slug, title }) {
      const threadId = deskThreadId(slug);
      if (!threads.has(threadId)) threads.set(threadId, { threadId, project: slug, kind: "desk", title });
      if (!desk.has(slug)) await this.linkDeskThread(slug, threadId);
      return { threadId };
    },
    async claimDeskSession(slug, sessionId) {
      const d = desk.get(slug) || { threadId: deskThreadId(slug), sessions: [] };
      if (d.sessionId) return d.sessionId;
      const startedAt = new Date(clock++).toISOString();
      const entry = { sessionId, startedAt, startedBy: null, lastMirroredId: null, lastActiveAt: startedAt };
      desk.set(slug, { ...d, sessionId, lastMirroredId: null, sessions: [...(d.sessions || []), entry] });
      return sessionId;
    },
    async startDeskSession(slug, sessionId, startedBy = null) {
      const d = desk.get(slug) || { threadId: deskThreadId(slug), sessions: [] };
      const startedAt = new Date(clock++).toISOString();
      const entry = { sessionId, startedAt, startedBy, lastMirroredId: null, lastActiveAt: startedAt };
      desk.set(slug, { ...d, sessionId, lastMirroredId: null, sessions: [...(d.sessions || []), entry] });
      return { sessionId, startedAt };
    },
    async deskSessionOwner(sessionId) {
      for (const [slug, d] of desk) {
        if (d.sessionId === sessionId || (d.sessions || []).some((s) => s.sessionId === sessionId)) return slug;
      }
      return null;
    },
    async adoptDeskSession(slug, sessionId, startedBy = null) {
      const d = desk.get(slug);
      const known = (d?.sessions || []).find((s) => s.sessionId === sessionId);
      if (!known) return { ...(await this.startDeskSession(slug, sessionId, startedBy)), resumed: false };
      desk.set(slug, { ...d, sessionId, lastMirroredId: known.lastMirroredId });
      return { sessionId, startedAt: known.startedAt, resumed: true };
    },
    async resetDeskSession(slug, sessionId) {
      const d = desk.get(slug);
      if (d?.sessionId !== sessionId) return;
      const sessions = (d.sessions || []).filter((s) => s.sessionId !== sessionId);
      desk.set(slug, { ...d, sessionId: null, lastMirroredId: null, sessions });
    },
    async setDeskMirrored(slug, sessionId, lastMirroredId) {
      const d = desk.get(slug);
      if (!d) return;
      const sessions = (d.sessions || []).map((s) => (s.sessionId === sessionId ? { ...s, lastMirroredId } : s));
      desk.set(slug, { ...d, sessions, ...(d.sessionId === sessionId ? { lastMirroredId } : {}) });
    },
    async getThread(threadId) {
      return threads.get(threadId) || null;
    },
    async getThreadMessagesForContext(threadId) {
      return messages.filter((m) => m.threadId === threadId);
    },
    async pushMessages({ threadId, messages: rows }) {
      for (const m of rows) {
        if (messages.some((x) => x.threadId === threadId && x.messageId === m.messageId)) continue;
        messages.push({ threadId, ...m });
      }
    },
    queue: [],
    async claimNextPendingReply({ threadKind }) {
      assert.equal(threadKind, "desk");
      return this.queue.shift() || null;
    },
    async completeReply(r) {
      replies.push({ ok: true, ...r });
    },
    async failReply(r) {
      replies.push({ ok: false, ...r });
    },
  };
}

describe("desk runner (unit)", () => {
  it("messageText keeps only visible text parts", () => {
    assert.equal(messageText(assistantMsg("hello")), "hello");
    assert.equal(
      messageText({ parts: [{ type: "text", text: "<think>x</think>hi", synthetic: false }, { type: "text", text: "sys", synthetic: true }] }),
      "hi",
    );
    assert.equal(messageText({ parts: [{ type: "tool" }] }), "");
  });

  it("ensureDeskSession reuses, replaces a vanished session, and yields to a racing winner", async () => {
    const store = memoryStore();
    const client = fakeOpencode();
    const a = await ensureDeskSession({ store, client, slug: "alpha", title: "Alpha desk" });
    assert.equal(await ensureDeskSession({ store, client, slug: "alpha" }), a);

    client.sessions.delete(a);
    const b = await ensureDeskSession({ store, client, slug: "alpha" });
    assert.notEqual(b, a);

    const racing = memoryStore();
    racing.claimDeskSession = async () => "ses_winner";
    const won = await ensureDeskSession({ store: racing, client, slug: "beta" });
    assert.equal(won, "ses_winner");
    assert.equal(client.deleted.length, 1, "loser deletes the session it created");
  });

  it("mirror copies desk turns once, skips the phone's own text, stops at an unfinished reply", async () => {
    const store = memoryStore();
    const client = fakeOpencode();
    const threadId = deskThreadId("alpha");
    const sid = await ensureDeskSession({ store, client, slug: "alpha" });
    store.messages.push({ threadId, messageId: "phone1", role: "user", text: "from phone", originKind: "phone" });
    const rows = client.sessions.get(sid);
    rows.push(userMsg("typed at the desk"), assistantMsg("desk answer"), userMsg("from phone"), assistantMsg("phone answer"));

    const first = await mirrorDeskSession({ store, client, slug: "alpha", threadId, sessionId: sid, heroId: "owned-7" });
    assert.deepEqual(first.map((p) => p.role), ["user", "assistant", "assistant"]);
    const texts = store.messages.filter((m) => m.threadId === threadId).map((m) => m.text);
    assert.deepEqual(texts, ["from phone", "typed at the desk", "desk answer", "phone answer"]);
    assert.equal(store.messages.find((m) => m.text === "desk answer").heroId, "owned-7");

    assert.deepEqual(await mirrorDeskSession({ store, client, slug: "alpha", threadId, sessionId: sid }), []);

    rows.push(userMsg("next"), assistantMsg("still typing", { done: false }));
    const partial = await mirrorDeskSession({ store, client, slug: "alpha", threadId, sessionId: sid });
    assert.deepEqual(partial.map((p) => p.role), ["user"]);
    rows[rows.length - 1].info.time.completed = clock;
    const rest = await mirrorDeskSession({ store, client, slug: "alpha", threadId, sessionId: sid });
    assert.deepEqual(rest.map((p) => p.role), ["assistant"]);
  });

  it("a phone turn gets the orchestrator's reply and completes; a hang aborts and fails", async () => {
    const store = memoryStore();
    const client = fakeOpencode();
    const threadId = deskThreadId("alpha");
    store.threads.set(threadId, { threadId, project: "alpha", kind: "desk", title: "Alpha desk" });
    store.messages.push({ threadId, messageId: "p1", role: "user", text: "status?", originKind: "phone" });
    store.queue.push({ threadId, messageId: "p1", text: "status?" });
    const runner = createDeskRunner({ store, client, logger: { info() {} } });
    assert.equal(await runner.tick(), true);
    const done = store.replies.at(-1);
    assert.equal(done.ok, true);
    const reply = store.messages.find((m) => m.messageId === done.replyMessageId);
    assert.equal(reply.text, "re: status?");
    assert.equal(store.messages.filter((m) => m.text === "status?").length, 1, "phone text not duplicated");

    const hung = memoryStore();
    const hangClient = fakeOpencode({ hang: true });
    hung.threads.set(threadId, { threadId, project: "alpha", kind: "desk", title: "Alpha desk" });
    hung.queue.push({ threadId, messageId: "p2", text: "long job" });
    await createDeskRunner({ store: hung, client: hangClient, logger: { info() {} } }).tick();
    assert.equal(hung.replies.at(-1).ok, false);
    assert.match(hung.replies.at(-1).error, /timed out/);
    assert.equal(hangClient.aborted.length, 1);
  });

  it("New session: divider in the one chat, old + new sessions both keep mirroring in order", async () => {
    const store = memoryStore();
    const client = fakeOpencode();
    const logs = [];
    const runner = createDeskRunner({ store, client, mirrorMs: 0, logger: { info: (l) => logs.push(l) } });
    const threadId = deskThreadId("alpha");
    const first = await ensureDeskSession({ store, client, slug: "alpha" });
    client.sessions.get(first).push(userMsg("old q"), assistantMsg("old a"));
    await runner.tick();

    const started = await startNewDeskSession({ store, client, slug: "alpha", title: "Alpha desk", startedBy: "iPhone" });
    assert.equal(started.threadId, threadId);
    assert.notEqual(started.sessionId, first);
    const state = await store.getDeskSession("alpha");
    assert.equal(state.sessionId, started.sessionId);
    assert.deepEqual(state.sessions.map((s) => s.sessionId), [first, started.sessionId]);

    client.sessions.get(first).push(userMsg("late q"), assistantMsg("late a"));
    client.sessions.get(started.sessionId).push(userMsg("new q"), assistantMsg("new a"));
    await runner.tick();
    const texts = store.messages.filter((m) => m.threadId === threadId).map((m) => m.text);
    assert.deepEqual(texts, ["old q", "old a", sessionDividerText("iPhone"), "late q", "late a", "new q", "new a"]);
    const divider = store.messages.find((m) => m.messageId === `session-${started.sessionId}`);
    assert.equal(divider.role, "system");

    client.sessions.delete(first);
    await runner.tick();
    assert.equal(logs.filter((l) => l.includes("mirror-error")).length, 0, "a deleted old session is skipped quietly");
  });

  it("terminal /new is adopted: divider once, switching back says Switched, children and other projects refused", async () => {
    const store = memoryStore();
    const client = fakeOpencode();
    const threadId = deskThreadId("alpha");
    const first = await ensureDeskSession({ store, client, slug: "alpha" });
    const typed = await client.createSession();

    const a = await adoptDeskSessionFromTerminal({ store, client, slug: "alpha", title: "Alpha desk", sessionId: typed, startedBy: "Mac desk" });
    assert.equal(a.resumed, false);
    assert.equal((await store.getDeskSession("alpha")).sessionId, typed);
    assert.equal(store.messages.find((m) => m.messageId === `session-${typed}`).text, sessionDividerText("Mac desk"));

    const again = await adoptDeskSessionFromTerminal({ store, client, slug: "alpha", sessionId: typed });
    assert.equal(again.resumed, true);
    assert.equal(store.messages.filter((m) => m.threadId === threadId).length, 1, "re-adopting the current session is a no-op");

    const back = await adoptDeskSessionFromTerminal({ store, client, slug: "alpha", sessionId: first, startedBy: "Mac desk" });
    assert.equal(back.resumed, true);
    assert.equal((await store.getDeskSession("alpha")).sessionId, first);
    assert.equal(store.messages.at(-1).text, sessionSwitchText("Mac desk"));

    const child = await client.createSession();
    client.parents.set(child, typed);
    await assert.rejects(adoptDeskSessionFromTerminal({ store, client, slug: "alpha", sessionId: child }), (e) => e.status === 400);
    const other = await ensureDeskSession({ store, client, slug: "beta" });
    await assert.rejects(adoptDeskSessionFromTerminal({ store, client, slug: "alpha", sessionId: other }), (e) => e.status === 409);
    await assert.rejects(adoptDeskSessionFromTerminal({ store, client, slug: "alpha", sessionId: "ses_gone" }), (e) => e.status === 404);
    assert.equal(appDeskThreadId("alpha"), deskThreadId("alpha"));
  });

  it("phoneCommands hides terminal-only and unusable names; parseSlashCommand splits name and args", () => {
    const names = phoneCommands(fakeOpencode().commands).map((c) => c.name);
    assert.deepEqual(names, ["quiet", "review", "jev"], "commands before skills; new/_disabled/spaced dropped");
    assert.equal(phoneCommands(fakeOpencode().commands)[0].template, undefined, "templates never go to the phone");
    assert.deepEqual(parseSlashCommand("/review  the auth diff\nplease"), { command: "review", args: "the auth diff\nplease" });
    assert.deepEqual(parseSlashCommand(" /jev "), { command: "jev", args: "" });
    assert.equal(parseSlashCommand("not / a command"), null);
    assert.equal(parseSlashCommand("/"), null);
    assert.equal(parseSlashCommand("/<b>"), null);
  });

  it("a phone slash command runs through OpenCode's command API; unknown ones stay prompts", async () => {
    const store = memoryStore();
    const client = fakeOpencode();
    const threadId = deskThreadId("alpha");
    store.threads.set(threadId, { threadId, project: "alpha", kind: "desk", title: "Alpha desk" });
    const runner = createDeskRunner({ store, client, logger: { info() {} } });

    store.messages.push({ threadId, messageId: "c1", role: "user", text: "/review auth", originKind: "phone" });
    store.queue.push({ threadId, messageId: "c1", text: "/review auth" });
    await runner.tick();
    assert.deepEqual(client.ran.map((r) => [r.command, r.args, r.agent]), [["review", "auth", "gotchi"]]);
    const done = store.replies.at(-1);
    assert.equal(done.ok, true);
    assert.equal(store.messages.find((m) => m.messageId === done.replyMessageId).text, "ran review: auth");
    assert.equal(store.messages.some((m) => m.text === "Review auth"), false, "the expanded template is not mirrored");

    store.messages.push({ threadId, messageId: "c2", role: "user", text: "/quiet", originKind: "phone" });
    store.queue.push({ threadId, messageId: "c2", text: "/quiet" });
    await runner.tick();
    const quiet = store.replies.at(-1);
    assert.equal(quiet.ok, true);
    const note = store.messages.find((m) => m.messageId === quiet.replyMessageId);
    assert.equal(note.role, "system");
    assert.match(note.text, /^\/quiet finished with no text reply/);

    store.messages.push({ threadId, messageId: "c3", role: "user", text: "/new", originKind: "phone" });
    store.queue.push({ threadId, messageId: "c3", text: "/new" });
    await runner.tick();
    assert.equal(client.ran.length, 2, "hidden commands are not run");
    assert.equal(store.messages.find((m) => m.messageId === store.replies.at(-1).replyMessageId).text, "re: /new");
  });

  it("listProjectSessions: newest activity first, titles from OpenCode, deleted sessions dropped", async () => {
    const store = memoryStore();
    const client = fakeOpencode();
    const first = await ensureDeskSession({ store, client, slug: "alpha" });
    const second = (await startNewDeskSession({ store, client, slug: "alpha", title: "Alpha desk", startedBy: "iPhone" })).sessionId;
    const third = (await startNewDeskSession({ store, client, slug: "alpha", title: "Alpha desk", startedBy: "Mac desk" })).sessionId;
    client.titles.set(second, "Fix the cheeks");
    client.sessions.delete(third);
    await adoptDeskSessionFromTerminal({ store, client, slug: "alpha", sessionId: second });

    const listed = await listProjectSessions({ store, client, slug: "alpha" });
    assert.equal(listed.current, second);
    assert.deepEqual(listed.sessions.map((s) => s.sessionId), [second, first]);
    assert.deepEqual(listed.sessions.map((s) => [s.title, s.startedBy, s.current]), [
      ["Fix the cheeks", "iPhone", true],
      [null, null, false],
    ]);
    assert.deepEqual(await listProjectSessions({ store, client, slug: "nobody" }), { current: null, sessions: [] });
  });

  it("phone slash menu: /partial query, phone commands first, prefix before substring", () => {
    assert.equal(slashQuery("/"), "");
    assert.equal(slashQuery("/Rev"), "rev");
    assert.equal(slashQuery("/review x"), null);
    assert.equal(slashQuery("hi /x"), null);
    const hub = [{ name: "review", source: "command" }, { name: "preview", source: "skill" }, { name: "new", source: "command" }];
    assert.deepEqual(filterSlashCommands("", hub).map((c) => c.name), ["new", "sessions", "review", "preview"]);
    assert.deepEqual(filterSlashCommands("rev", hub).map((c) => c.name), ["review", "preview"]);
    assert.equal(filterSlashCommands("s", hub)[0].source, "phone");
    assert.equal(phoneSlashCommand(" /New "), "new");
    assert.equal(phoneSlashCommand("/sessions now"), null);
    assert.equal(phoneSlashCommand("/review"), null);
  });

  it("terminal attach command carries the sync env; the device label never leaks the hostname", () => {
    const cmd = remoteAttachCommand({ repoDir: "/home/u/dev/GotchiBot", opencodeUrl: "http://127.0.0.1:4096", sessionId: "ses_1" });
    assert.match(cmd, /^cd '\/home\/u\/dev\/GotchiBot' && exec .* attach 'http:\/\/127\.0\.0\.1:4096' --session 'ses_1' --dir '\/home\/u\/dev\/GotchiBot'$/);
    const synced = remoteAttachCommand(
      { repoDir: "/r", opencodeUrl: "http://h", sessionId: "ses_1" },
      { GOTCHIBOT_DESK_SLUG: "alpha", GOTCHIBOT_DESK_DEVICE: "it's mine", "bad name": "x", EMPTY: "" },
    );
    assert.match(synced, /&& GOTCHIBOT_DESK_SLUG='alpha' GOTCHIBOT_DESK_DEVICE='it'\\''s mine' exec /);
    assert.doesNotMatch(synced, /bad name|EMPTY/);
    assert.equal(deskDeviceLabel({}, "darwin"), "Mac desk");
    assert.equal(deskDeviceLabel({}, "linux"), "Linux desk");
    assert.equal(deskDeviceLabel({ GOTCHIBOT_DESK_LABEL: "Studio" }, "darwin"), "Studio");
    assert.deepEqual(deskSyncEnv("alpha", {}), { GOTCHIBOT_DESK_SLUG: "alpha", GOTCHIBOT_DESK_DEVICE: deskDeviceLabel({}) });
    assert.equal(renderDeskUnit("x=@REPO@ y=@MISSING@", { REPO: "/r" }), "x=/r y=@MISSING@");
  });
});

async function mongoReachable(uri, ms = 1500) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: ms, connectTimeoutMS: ms });
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    return true;
  } catch {
    return false;
  } finally {
    await client.close().catch(() => {});
  }
}

describe("desk threads on the Hub (Mongo)", async () => {
  const uri = process.env.GOTCHIBOT_TEST_MONGODB_URI || "mongodb://127.0.0.1:27017";
  if (!(await mongoReachable(uri))) {
    it("skips when Mongo unreachable", { skip: "Mongo not reachable within 1.5s" }, () => {});
    return;
  }
  const dbName = `gotchibot_test_${randomBytes(6).toString("hex")}`;
  const root = mkdtempSync(join(tmpdir(), "gb-deskrun-"));
  mkdirSync(join(root, "sessions/pstack/alpha"), { recursive: true });
  writeFileSync(
    join(root, "sessions/pstack/alpha/dossier.json"),
    JSON.stringify({ slug: "alpha", fields: { title: "Alpha" } }),
  );
  let store;
  let server;
  let port;
  const opencode = fakeOpencode();

  before(async () => {
    store = await connectStore({ mongoUri: uri, dbName });
    await store.ensureIndexes();
    server = createApiServer({
      store,
      config: { host: "127.0.0.1", port: 0, ownerLogin: "owner@example.com", projectsRoot: root, deskEventsHeartbeatMs: 100 },
      projects: createProjectSource({ root }),
      verifyWallet: async () => false,
      opencode,
    });
    port = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
  });

  after(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (store) {
      await store.db.dropDatabase().catch(() => {});
      await store.close();
    }
    rmSync(root, { recursive: true, force: true });
  });

  async function token(kind) {
    const { code } = await store.mintPairingCode({ name: kind, kind });
    return (await store.claimPairingCode({ code, kind })).deskToken;
  }

  async function get(path, tok) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { "X-GotchiBot-Desk-Token": tok } });
    return { status: res.status, data: await res.json() };
  }

  it("GET /projects/:slug/desk opens one shared thread; desks get the session, phones don't", async () => {
    const phone = await token("phone");
    const desk = await token("desk");
    const p = await get("/api/gotchibot/projects/alpha/desk", phone);
    assert.equal(p.status, 200);
    assert.equal(p.data.threadId, "desk-alpha");
    assert.equal(p.data.title, "Alpha desk");
    assert.equal(p.data.sessionId, undefined);
    assert.equal(p.data.repoDir, undefined);

    const d = await get("/api/gotchibot/projects/alpha/desk?session=1", desk);
    assert.match(d.data.sessionId, /^ses_/);
    assert.equal(d.data.repoDir, root);
    const again = await get("/api/gotchibot/projects/alpha/desk?session=1", desk);
    assert.equal(again.data.sessionId, d.data.sessionId);

    assert.equal((await get("/api/gotchibot/projects/nope/desk", phone)).status, 404);
  });

  it("every phone sees the desk thread; its turns go to the desk runner, not hub-runner", async () => {
    const { threadId } = await store.ensureDeskThread({ slug: "alpha", title: "Alpha desk" });
    const phoneA = { deskId: "phone-a", kind: "phone" };
    const phoneB = { deskId: "phone-b", kind: "phone" };
    assert.equal(await store.canDeskAccessThread(phoneB, threadId), true);
    const listed = await store.listThreads({ desk: phoneB, project: "alpha" });
    assert.equal(listed.threads.find((t) => t.threadId === threadId)?.kind, "desk");

    await store.sendMessage({ desk: phoneA, threadId, text: "hi desk" });
    await store.sendMessage({ desk: phoneA, text: "general question" });
    const general = await store.claimNextPendingReply({ runnerId: "hub-runner" });
    assert.equal(general.text, "general question");
    assert.equal(await store.claimNextPendingReply({ runnerId: "hub-runner" }), null);
    const deskTurn = await store.claimNextPendingReply({ runnerId: "hub-desk", threadKind: "desk" });
    assert.equal(deskTurn.text, "hi desk");
    assert.equal(deskTurn.threadKind, "desk");
  });

  it("phones cannot mint desk-* threads; session claims are race-safe", async () => {
    await assert.rejects(
      store.sendMessage({ desk: { deskId: "phone-c", kind: "phone" }, threadId: "desk-beta", text: "x" }),
      (err) => err.status === 403,
    );
    const [a, b] = await Promise.all([
      store.claimDeskSession("gamma", "ses_a"),
      store.claimDeskSession("gamma", "ses_b"),
    ]);
    assert.equal(a, b);
    await store.resetDeskSession("gamma", "ses_other");
    assert.equal((await store.getDeskSession("gamma")).sessionId, a);
    await store.resetDeskSession("gamma", a);
    assert.equal((await store.getDeskSession("gamma")).sessionId, null);
  });

  it("a pre-sessions doc migrates lazily; New session keeps the old one and its cursor", async () => {
    const past = new Date(Date.now() - 60_000);
    await store.db.collection("desk_sessions").insertOne({
      _id: "legacy",
      threadId: "desk-legacy",
      sessionId: "ses_old",
      lastMirroredId: "msg_9",
      updatedAt: past,
    });
    const before = await store.getDeskSession("legacy");
    assert.deepEqual(before.sessions.map((s) => [s.sessionId, s.lastMirroredId]), [["ses_old", "msg_9"]]);

    const { startedAt } = await store.startDeskSession("legacy", "ses_new", "iPhone");
    assert.ok(Date.parse(startedAt));
    const after = await store.getDeskSession("legacy");
    assert.equal(after.sessionId, "ses_new");
    assert.equal(after.lastMirroredId, null);
    assert.equal(after.sessionStartedAt, startedAt);
    assert.deepEqual(after.sessions.map((s) => [s.sessionId, s.lastMirroredId, s.startedBy]), [
      ["ses_old", "msg_9", null],
      ["ses_new", null, "iPhone"],
    ]);

    await store.setDeskMirrored("legacy", "ses_old", "msg_10");
    const moved = await store.getDeskSession("legacy");
    assert.equal(moved.sessions[0].lastMirroredId, "msg_10");
    assert.equal(moved.lastMirroredId, null, "the current cursor is untouched");

    const listed = (await store.listDeskSessions()).find((s) => s.slug === "legacy");
    assert.deepEqual(listed.sessions.map((s) => s.sessionId), ["ses_old", "ses_new"]);
    const narrow = (await store.listDeskSessions({ recentMs: 0 })).find((s) => s.slug === "legacy");
    assert.deepEqual(narrow.sessions.map((s) => s.sessionId), ["ses_new"], "idle old sessions drop off");
  });

  it("POST /projects/:slug/desk/session: any device starts a New session, all see the divider", async () => {
    const phone = await token("phone");
    const desk = await token("desk");
    const beforeId = (await get("/api/gotchibot/projects/alpha/desk?session=1", desk)).data.sessionId;

    const post = async (path, tok) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "X-GotchiBot-Desk-Token": tok, "Content-Type": "application/json" },
        body: "{}",
      });
      return { status: res.status, data: await res.json() };
    };
    const r = await post("/api/gotchibot/projects/alpha/desk/session", phone);
    assert.equal(r.status, 200);
    assert.equal(r.data.threadId, "desk-alpha");
    assert.match(r.data.sessionId, /^ses_/);
    assert.notEqual(r.data.sessionId, beforeId);

    const now = await get("/api/gotchibot/projects/alpha/desk?session=1", desk);
    assert.equal(now.data.sessionId, r.data.sessionId);
    assert.equal(now.data.sessionStartedAt, r.data.startedAt);
    const pulled = await get("/api/gotchibot/chats/pull?threadId=desk-alpha&after=0", phone);
    const divider = pulled.data.messages.find((m) => m.messageId === `session-${r.data.sessionId}`);
    assert.equal(divider.role, "system");
    assert.equal(divider.text, sessionDividerText("phone"));

    assert.equal((await post("/api/gotchibot/projects/nope/desk/session", phone)).status, 404);
    const whoami = await get("/api/gotchibot/hub/whoami", phone);
    await store.revokeDesk(whoami.data.deskId);
    assert.equal((await post("/api/gotchibot/projects/alpha/desk/session", phone)).status, 401);
  });

  it("GET /desk/events streams the current session and pushes moves; revoked tokens are dropped", async () => {
    const desk = await token("desk");
    const phone = await token("phone");
    const url = `http://127.0.0.1:${port}/api/gotchibot/projects/alpha/desk/events`;
    const current = (await get("/api/gotchibot/projects/alpha/desk?session=1", desk)).data.sessionId;

    const ac = new AbortController();
    const res = await fetch(url, { headers: { "X-GotchiBot-Desk-Token": desk }, signal: ac.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const nextEvent = async () => {
      for (;;) {
        const frames = buf.split("\n\n");
        while (frames.length > 1) {
          const frame = frames.shift();
          buf = frames.join("\n\n");
          if (frame.includes("event: desk")) return JSON.parse(frame.split("data: ")[1]);
        }
        const { value, done } = await reader.read();
        if (done) return null;
        buf += decoder.decode(value, { stream: true });
      }
    };
    try {
      assert.equal((await nextEvent()).sessionId, current);
      const started = await fetch(`http://127.0.0.1:${port}/api/gotchibot/projects/alpha/desk/session`, {
        method: "POST",
        headers: { "X-GotchiBot-Desk-Token": phone, "Content-Type": "application/json" },
        body: "{}",
      }).then((r) => r.json());
      const pushed = await nextEvent();
      assert.equal(pushed.sessionId, started.sessionId);
      assert.equal(pushed.sessionStartedAt, started.startedAt);

      await store.revokeDesk((await get("/api/gotchibot/hub/whoami", desk)).data.deskId);
      assert.equal(await nextEvent(), null, "the heartbeat ends a revoked desk's stream");
    } finally {
      ac.abort();
    }

    assert.equal((await fetch(url, { headers: { "X-GotchiBot-Desk-Token": phone } })).status, 403);
    const other = await token("desk");
    const missing = await fetch(url.replace("/alpha/", "/nope/"), { headers: { "X-GotchiBot-Desk-Token": other } });
    assert.equal(missing.status, 404);
  });

  it("POST /desk/session { sessionId }: a terminal's own session becomes current for every device", async () => {
    const desk = await token("desk");
    const phone = await token("phone");
    const post = async (body, tok = desk) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/gotchibot/projects/alpha/desk/session`, {
        method: "POST",
        headers: { "X-GotchiBot-Desk-Token": tok, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, data: await res.json() };
    };
    const earlier = (await get("/api/gotchibot/projects/alpha/desk?session=1", desk)).data.sessionId;
    await store.setDeskMirrored("alpha", earlier, "msg_keep");
    const typed = await opencode.createSession();

    const r = await post({ sessionId: typed, device: "Mac desk<script>" });
    assert.equal(r.status, 200);
    assert.equal(r.data.sessionId, typed);
    assert.equal(r.data.resumed, false);
    assert.equal((await get("/api/gotchibot/projects/alpha/desk", phone)).data.sessionStartedAt, r.data.startedAt);
    const pulled = await get("/api/gotchibot/chats/pull?threadId=desk-alpha&after=0", phone);
    assert.equal(pulled.data.messages.find((m) => m.messageId === `session-${typed}`).text, sessionDividerText("Mac deskscript"));

    const back = await post({ sessionId: earlier });
    assert.equal(back.data.resumed, true);
    const state = await store.getDeskSession("alpha");
    assert.equal(state.sessionId, earlier);
    assert.equal(state.lastMirroredId, "msg_keep", "switching back keeps that session's mirror cursor");

    assert.equal((await post({ sessionId: "not-a-session" })).status, 400);
    assert.equal((await post({ sessionId: "ses_missing" })).status, 404);
    const child = await opencode.createSession();
    opencode.parents.set(child, typed);
    assert.equal((await post({ sessionId: child })).status, 400);
    const foreign = await opencode.createSession();
    await store.startDeskSession("elsewhere", foreign);
    assert.equal((await post({ sessionId: foreign })).status, 409);
  });

  it("phones list sessions and commands, and switch sessions with a Switched divider", async () => {
    const phone = await token("phone");
    const listed = await get("/api/gotchibot/projects/alpha/desk/sessions", phone);
    assert.equal(listed.status, 200);
    assert.ok(listed.data.sessions.length >= 2);
    assert.equal(listed.data.sessions.filter((s) => s.current).length, 1);
    const target = listed.data.sessions.find((s) => !s.current);

    const res = await fetch(`http://127.0.0.1:${port}/api/gotchibot/projects/alpha/desk/session`, {
      method: "POST",
      headers: { "X-GotchiBot-Desk-Token": phone, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: target.sessionId }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).resumed, true);
    const after = await get("/api/gotchibot/projects/alpha/desk/sessions", phone);
    assert.equal(after.data.current, target.sessionId);
    const pulled = await get("/api/gotchibot/chats/pull?threadId=desk-alpha&after=0", phone);
    assert.equal(pulled.data.messages.at(-1).text, sessionSwitchText("phone"));

    const cmds = await get("/api/gotchibot/projects/alpha/desk/commands", phone);
    assert.equal(cmds.status, 200);
    assert.deepEqual(cmds.data.commands.map((c) => c.name), ["quiet", "review", "jev"]);
    assert.equal((await get("/api/gotchibot/projects/nope/desk/sessions", phone)).status, 404);
    assert.equal((await get("/api/gotchibot/projects/nope/desk/commands", phone)).status, 404);
  });
});
