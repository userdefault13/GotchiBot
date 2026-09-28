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
  createDeskRunner,
  ensureDeskSession,
  messageText,
  mirrorDeskSession,
} from "../services/gotchibot-api/desk-runner.mjs";
import { connectStore, deskThreadId } from "../services/gotchibot-api/store.mjs";
import { createApiServer } from "../services/gotchibot-api/server.mjs";
import { createProjectSource } from "../services/gotchibot-api/projects.mjs";
import { remoteAttachCommand, renderDeskUnit } from "../scripts/hub-desk.mjs";

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
    async getSession(id) {
      if (!sessions.has(id)) throw notFound();
      return { id };
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
      return d ? { slug, ...d } : null;
    },
    async listDeskSessions() {
      return [...desk.entries()].filter(([, d]) => d.sessionId).map(([slug, d]) => ({ slug, ...d }));
    },
    async linkDeskThread(slug, threadId) {
      desk.set(slug, { sessionId: null, lastMirroredId: null, ...desk.get(slug), threadId });
    },
    async claimDeskSession(slug, sessionId) {
      const d = desk.get(slug) || { threadId: deskThreadId(slug) };
      if (d.sessionId) return d.sessionId;
      desk.set(slug, { ...d, sessionId, lastMirroredId: null });
      return sessionId;
    },
    async resetDeskSession(slug, sessionId) {
      const d = desk.get(slug);
      if (d?.sessionId === sessionId) desk.set(slug, { ...d, sessionId: null, lastMirroredId: null });
    },
    async setDeskMirrored(slug, sessionId, lastMirroredId) {
      const d = desk.get(slug);
      if (d?.sessionId === sessionId) desk.set(slug, { ...d, lastMirroredId });
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

  it("terminal attach command and unit rendering", () => {
    const cmd = remoteAttachCommand({ repoDir: "/home/u/dev/GotchiBot", opencodeUrl: "http://127.0.0.1:4096", sessionId: "ses_1" });
    assert.match(cmd, /^cd '\/home\/u\/dev\/GotchiBot' && exec .* attach 'http:\/\/127\.0\.0\.1:4096' --session 'ses_1' --dir '\/home\/u\/dev\/GotchiBot'$/);
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
      config: { host: "127.0.0.1", port: 0, ownerLogin: "owner@example.com", projectsRoot: root },
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
});
