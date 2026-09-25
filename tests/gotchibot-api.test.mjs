/**
 * gotchibot-api unit + integration tests.
 * Integration runs only when Mongo is reachable within 1.5s.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  contentHashOf,
  ulid,
  isUlid,
} from "../scripts/chat-canonical.mjs";
import {
  formatStateUri,
  parseStateUri,
  isPublicSafeStateUri,
} from "../scripts/chat-state-uri.mjs";
import {
  classifyRequest,
  checkOrigin,
  normalizePairingCode,
} from "../services/gotchibot-api/auth.mjs";
import { connectStore } from "../services/gotchibot-api/store.mjs";
import { createApiServer } from "../services/gotchibot-api/server.mjs";
import {
  resolveStaticPath,
  contentTypeFor,
} from "../services/gotchibot-api/static.mjs";
import { request as httpRequest } from "node:http";
import { MongoClient } from "mongodb";

// ─── pure: canonical / hash / ulid ───────────────────────────────────────────

describe("canonicalJson + contentHashOf + ulid", () => {
  it("sorts object keys recursively and drops undefined", () => {
    const raw = { z: 1, a: { d: 2, b: undefined, c: 3 }, m: undefined };
    assert.equal(canonicalJson(raw), '{"a":{"c":3,"d":2},"z":1}');
  });

  it("serializes Date to ISO", () => {
    const d = new Date("2026-01-02T03:04:05.000Z");
    assert.equal(canonicalJson({ t: d }), '{"t":"2026-01-02T03:04:05.000Z"}');
  });

  it("rejects non-finite numbers", () => {
    assert.throws(() => canonicalJson({ n: Infinity }), /non-finite/);
    assert.throws(() => canonicalJson({ n: NaN }), /non-finite/);
  });

  it("contentHashOf is stable and 0x + 64 hex", () => {
    const v = { b: 2, a: 1 };
    const h1 = contentHashOf(v);
    const h2 = contentHashOf({ a: 1, b: 2 });
    assert.equal(h1, h2);
    assert.match(h1, /^0x[0-9a-f]{64}$/);
  });

  it("ulid format + monotonic-ish across ms", () => {
    const a = ulid(1_700_000_000_000);
    const b = ulid(1_700_000_000_001);
    assert.equal(a.length, 26);
    assert.ok(isUlid(a));
    assert.ok(isUlid(b));
    assert.ok(a < b, "later ms should sort after earlier");
    assert.equal(isUlid("nope"), false);
  });
});

// ─── pure: stateUri ──────────────────────────────────────────────────────────

describe("stateUri", () => {
  it("format/parse gotchibot-hub", () => {
    const id = ulid();
    const uri = formatStateUri("gotchibot-hub", id);
    assert.equal(uri, `gotchibot-hub://${id}`);
    const p = parseStateUri(uri);
    assert.deepEqual(p, { scheme: "gotchibot-hub", id, supported: true });
    assert.equal(isPublicSafeStateUri(uri), true);
  });

  it("ipfs reserved unsupported", () => {
    const p = parseStateUri("ipfs://bafytestcid");
    assert.ok(p);
    assert.equal(p.scheme, "ipfs");
    assert.equal(p.supported, false);
    assert.equal(isPublicSafeStateUri("ipfs://bafytestcid"), false);
    assert.throws(() => formatStateUri("ipfs", "bafy"), /not implemented/);
  });

  it("rejects http / .ts.net / 100.x", () => {
    assert.equal(isPublicSafeStateUri("https://example.com/x"), false);
    assert.equal(isPublicSafeStateUri("http://hub.ts.net/snap"), false);
    assert.equal(isPublicSafeStateUri("gotchibot-hub://foo.bar.ts.net"), false);
    assert.equal(isPublicSafeStateUri("gotchibot-hub://100.64.0.1/x"), false);
  });
});

// ─── pure: desk pin / desk token helpers ─────────────────────────────────────

describe("hubPinPath / readDeskToken / deskAuthHeaders", () => {
  it("hubPinPath honors GOTCHIBOT_HUB_PIN absolute override", async () => {
    const { hubPinPath, readDeskToken, deskAuthHeaders } = await import(
      "../scripts/infra-client.mjs"
    );
    const override = "/tmp/gotchibot-test-hub-pin.json";
    assert.equal(hubPinPath({ GOTCHIBOT_HUB_PIN: override }), resolve(override));
    assert.equal(readDeskToken({ GOTCHIBOT_DESK_TOKEN: "  gbd_test  " }), "gbd_test");
    const h = deskAuthHeaders({ GOTCHIBOT_DESK_TOKEN: "gbd_abc" });
    assert.equal(h["X-GotchiBot-Desk-Token"], "gbd_abc");
    assert.equal(h["User-Agent"], "GotchiBot/desk");
    assert.equal(h.Accept, "application/json");
    assert.ok(!Object.keys(h).some((k) => /install/i.test(k)));
    assert.throws(
      () => deskAuthHeaders({ GOTCHIBOT_DESK_TOKEN: "", GOTCHIBOT_HUB_PIN: "/no/such/pin.json" }),
      (e) => e.code === "NO_DESK_TOKEN",
    );
  });
});

// ─── pure: auth origin ───────────────────────────────────────────────────────

describe("classifyRequest / checkOrigin / normalizePairingCode", () => {
  it("direct loopback ok without login", () => {
    const c = classifyRequest({
      remoteAddress: "127.0.0.1",
      headers: {},
    });
    assert.equal(c.direct, true);
    assert.deepEqual(checkOrigin({ remoteAddress: "127.0.0.1", headers: {} }, null), {
      ok: true,
    });
  });

  it("loopback + X-Forwarded-For without Tailscale-User-Login -> rejected", () => {
    const req = {
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": "100.64.0.1" },
    };
    assert.equal(classifyRequest(req).direct, false);
    const r = checkOrigin(req, "alice@example.com");
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
  });

  it("X-Forwarded-For + matching login -> ok", () => {
    const r = checkOrigin(
      {
        remoteAddress: "127.0.0.1",
        headers: {
          "x-forwarded-for": "100.64.0.1",
          "tailscale-user-login": "Alice@Example.com",
        },
      },
      "alice@example.com",
    );
    assert.equal(r.ok, true);
  });

  it("wrong login -> rejected", () => {
    const r = checkOrigin(
      {
        remoteAddress: "127.0.0.1",
        headers: {
          "x-forwarded-for": "100.64.0.1",
          "tailscale-user-login": "eve@evil.com",
        },
      },
      "alice@example.com",
    );
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
  });

  it("non-loopback without login -> rejected", () => {
    const r = checkOrigin(
      { remoteAddress: "10.0.0.5", headers: {} },
      "alice@example.com",
    );
    assert.equal(r.ok, false);
  });

  it("funnel header -> 403", () => {
    const r = checkOrigin(
      {
        remoteAddress: "127.0.0.1",
        headers: { "tailscale-funnel-request": "1" },
      },
      "alice@example.com",
    );
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
    assert.match(r.error, /funnel/i);
  });

  it("ownerLogin unset + remote -> rejected", () => {
    const r = checkOrigin(
      {
        remoteAddress: "127.0.0.1",
        headers: { "x-forwarded-for": "1.2.3.4" },
      },
      null,
    );
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
  });

  it("normalizePairingCode uppercases and strips dashes", () => {
    assert.equal(normalizePairingCode("ab12-cd34"), "AB12CD34");
  });
});

// ─── integration (Mongo) ─────────────────────────────────────────────────────

async function mongoReachable(uri, ms = 1500) {
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: ms,
    connectTimeoutMS: ms,
  });
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    await client.close();
    return true;
  } catch {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
    return false;
  }
}

function listen(server, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.removeListener("error", reject);
      const addr = server.address();
      resolve(addr.port);
    });
  });
}

function closeServer(server) {
  return new Promise((r) => server.close(r));
}

async function httpJson(port, method, path, { headers = {}, body } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(body != null ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text };
  }
  return { status: res.status, json };
}

describe("gotchibot-api integration", async () => {
  const uri =
    process.env.GOTCHIBOT_TEST_MONGODB_URI || "mongodb://127.0.0.1:27017";
  const reachable = await mongoReachable(uri);
  if (!reachable) {
    it("skips when Mongo unreachable", { skip: "Mongo not reachable within 1.5s" }, () => {});
    return;
  }

  const dbName = `gotchibot_test_${randomBytes(6).toString("hex")}`;
  const ownerLogin = "testowner@example.com";
  let store;
  let server;
  let port;
  let deskToken;
  let deskId;

  before(async () => {
    store = await connectStore({ mongoUri: uri, dbName });
    await store.ensureIndexes();
    server = createApiServer({
      store,
      config: {
        host: "127.0.0.1",
        port: 0,
        mongoUri: uri,
        dbName,
        ownerLogin,
      },
    });
    port = await listen(server);
  });

  after(async () => {
    if (server) await closeServer(server);
    if (store) {
      try {
        await store.db.dropDatabase();
      } catch {
        /* ignore */
      }
      await store.close();
    }
  });

  it("GET /health", async () => {
    const { status, json } = await httpJson(port, "GET", "/health");
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.service, "gotchibot-api");
    assert.equal(json.db, "ok");
    assert.ok(json.version);
  });

  it("mint+claim pairing code -> desk token; code cannot be reused", async () => {
    const { code } = await store.mintPairingCode({ name: "test-desk" });
    const claim = await httpJson(port, "POST", "/api/gotchibot/hub/pair/claim", {
      body: { code, name: "desk-a" },
    });
    assert.equal(claim.status, 200);
    assert.equal(claim.json.ok, true);
    assert.ok(claim.json.deskToken.startsWith("gbd_"));
    deskToken = claim.json.deskToken;
    deskId = claim.json.deskId;

    const reuse = await httpJson(port, "POST", "/api/gotchibot/hub/pair/claim", {
      body: { code },
    });
    assert.notEqual(reuse.status, 200);
  });

  it("push 2 msgs inserted; re-push duplicate with same seqs", async () => {
    const msgs = [
      { messageId: "m1", role: "user", text: "hello", ts: "2026-01-01T00:00:00.000Z" },
      { messageId: "m2", role: "assistant", text: "hi", ts: "2026-01-01T00:00:01.000Z" },
    ];
    const push1 = await httpJson(port, "POST", "/api/gotchibot/chats/push", {
      headers: { "X-GotchiBot-Desk-Token": deskToken },
      body: { threadId: "t1", title: "Thread One", messages: msgs },
    });
    assert.equal(push1.status, 200);
    assert.equal(push1.json.inserted, 2);
    assert.equal(push1.json.skipped, 0);
    const seqs = push1.json.results.map((r) => r.seq);

    const push2 = await httpJson(port, "POST", "/api/gotchibot/chats/push", {
      headers: { "X-GotchiBot-Desk-Token": deskToken },
      body: { threadId: "t1", messages: msgs },
    });
    assert.equal(push2.status, 200);
    assert.equal(push2.json.inserted, 0);
    assert.equal(push2.json.skipped, 2);
    assert.deepEqual(
      push2.json.results.map((r) => r.seq),
      seqs,
    );
    assert.ok(push2.json.results.every((r) => r.status === "duplicate"));
  });

  it("pull after=0 both; after first seq only second", async () => {
    const all = await httpJson(
      port,
      "GET",
      "/api/gotchibot/chats/pull?threadId=t1&after=0",
      { headers: { "X-GotchiBot-Desk-Token": deskToken } },
    );
    assert.equal(all.status, 200);
    assert.equal(all.json.messages.length, 2);
    const firstSeq = all.json.messages[0].seq;
    const second = await httpJson(
      port,
      "GET",
      `/api/gotchibot/chats/pull?threadId=t1&after=${firstSeq}`,
      { headers: { "X-GotchiBot-Desk-Token": deskToken } },
    );
    assert.equal(second.json.messages.length, 1);
    assert.equal(second.json.messages[0].messageId, "m2");
  });

  it("threads LWW: older title ignored, newer applied", async () => {
    await httpJson(port, "POST", "/api/gotchibot/chats/push", {
      headers: { "X-GotchiBot-Desk-Token": deskToken },
      body: {
        threadId: "t1",
        thread: { title: "Old Title", updatedAt: "2020-01-01T00:00:00.000Z" },
        messages: [
          {
            messageId: "m-old",
            role: "user",
            text: "x",
            ts: "2026-01-01T00:00:02.000Z",
          },
        ],
      },
    });
    let threads = await httpJson(port, "GET", "/api/gotchibot/chats/threads", {
      headers: { "X-GotchiBot-Desk-Token": deskToken },
    });
    const before = threads.json.threads.find((t) => t.threadId === "t1");
    assert.notEqual(before.title, "Old Title");

    await httpJson(port, "POST", "/api/gotchibot/chats/push", {
      headers: { "X-GotchiBot-Desk-Token": deskToken },
      body: {
        threadId: "t1",
        thread: { title: "New Title", updatedAt: "2030-01-01T00:00:00.000Z" },
        messages: [
          {
            messageId: "m-new",
            role: "user",
            text: "y",
            ts: "2026-01-01T00:00:03.000Z",
          },
        ],
      },
    });
    threads = await httpJson(port, "GET", "/api/gotchibot/chats/threads", {
      headers: { "X-GotchiBot-Desk-Token": deskToken },
    });
    const after = threads.json.threads.find((t) => t.threadId === "t1");
    assert.equal(after.title, "New Title");
  });

  it("edit/delete tombstones appended", async () => {
    const push = await httpJson(port, "POST", "/api/gotchibot/chats/push", {
      headers: { "X-GotchiBot-Desk-Token": deskToken },
      body: {
        threadId: "t1",
        messages: [
          {
            messageId: "e1",
            role: "user",
            text: "edited",
            op: "edit",
            targetMessageId: "m1",
            ts: "2026-01-01T00:00:04.000Z",
          },
          {
            messageId: "d1",
            role: "user",
            text: "",
            op: "delete",
            targetMessageId: "m2",
            ts: "2026-01-01T00:00:05.000Z",
          },
        ],
      },
    });
    assert.equal(push.status, 200);
    assert.equal(push.json.inserted, 2);
    const pull = await httpJson(
      port,
      "GET",
      "/api/gotchibot/chats/pull?threadId=t1&after=0&limit=500",
      { headers: { "X-GotchiBot-Desk-Token": deskToken } },
    );
    const ops = pull.json.messages.filter((m) => m.op === "edit" || m.op === "delete");
    assert.ok(ops.some((m) => m.op === "edit" && m.targetMessageId === "m1"));
    assert.ok(ops.some((m) => m.op === "delete" && m.targetMessageId === "m2"));
    // originals still present
    assert.ok(pull.json.messages.some((m) => m.messageId === "m1" && m.op === "message"));
  });

  it("snapshot stateUri + GET content re-hashes", async () => {
    const snap = await httpJson(port, "POST", "/api/gotchibot/chats/snapshot", {
      headers: { "X-GotchiBot-Desk-Token": deskToken },
      body: { threadIds: ["t1"], gitCommit: "abc", gitBranch: "main" },
    });
    assert.equal(snap.status, 200);
    assert.match(snap.json.stateUri, /^gotchibot-hub:\/\/[0-9A-HJKMNP-TV-Z]{26}$/i);
    assert.ok(isUlid(snap.json.snapshotId));

    const get = await httpJson(
      port,
      "GET",
      `/api/gotchibot/chats/snapshot/${snap.json.snapshotId}`,
      { headers: { "X-GotchiBot-Desk-Token": deskToken } },
    );
    assert.equal(get.status, 200);
    assert.equal(contentHashOf(get.json.content), snap.json.contentHash);
  });

  it("no token -> 401", async () => {
    const r = await httpJson(port, "GET", "/api/gotchibot/hub/whoami");
    assert.equal(r.status, 401);
    assert.match(r.json.error, /desk token required/i);
  });

  it("install-token-only -> 401 with install-token message", async () => {
    const r = await httpJson(port, "GET", "/api/gotchibot/hub/whoami", {
      headers: { "X-GotchiBot-Install-Token": "fake-install" },
    });
    assert.equal(r.status, 401);
    assert.match(r.json.error, /install token cannot unlock chat data/i);
  });

  it("revoked token -> 401", async () => {
    assert.ok(await store.revokeDesk(deskId));
    const r = await httpJson(port, "GET", "/api/gotchibot/hub/whoami", {
      headers: { "X-GotchiBot-Desk-Token": deskToken },
    });
    assert.equal(r.status, 401);
    assert.match(r.json.error, /revoked/i);
  });

  it("X-Forwarded-For + no Tailscale-User-Login -> 403", async () => {
    // mint a fresh desk for remaining auth-origin checks
    const { code } = await store.mintPairingCode({ name: "desk2" });
    const claim = await httpJson(port, "POST", "/api/gotchibot/hub/pair/claim", {
      body: { code, name: "desk2" },
    });
    deskToken = claim.json.deskToken;

    const r = await httpJson(port, "GET", "/api/gotchibot/hub/whoami", {
      headers: {
        "X-GotchiBot-Desk-Token": deskToken,
        "X-Forwarded-For": "100.64.0.1",
      },
    });
    assert.equal(r.status, 403);
  });

  it("X-Forwarded-For + matching Tailscale-User-Login -> 200", async () => {
    const r = await httpJson(port, "GET", "/api/gotchibot/hub/whoami", {
      headers: {
        "X-GotchiBot-Desk-Token": deskToken,
        "X-Forwarded-For": "100.64.0.1",
        "Tailscale-User-Login": ownerLogin,
      },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
  });
});

// ─── desk kinds + phone scoping (Mongo) ──────────────────────────────────────

describe("desk kinds + phone scoping", async () => {
  const uri =
    process.env.GOTCHIBOT_TEST_MONGODB_URI || "mongodb://127.0.0.1:27017";
  const reachable = await mongoReachable(uri);
  if (!reachable) {
    it("skips when Mongo unreachable", { skip: "Mongo not reachable within 1.5s" }, () => {});
    return;
  }

  const { hashToken, newDeskToken } = await import(
    "../services/gotchibot-api/auth.mjs"
  );

  const dbName = `gotchibot_test_${randomBytes(6).toString("hex")}`;
  const ownerLogin = "testowner@example.com";
  let store;
  let server;
  let port;

  before(async () => {
    store = await connectStore({ mongoUri: uri, dbName });
    await store.ensureIndexes();
    server = createApiServer({
      store,
      config: {
        host: "127.0.0.1",
        port: 0,
        mongoUri: uri,
        dbName,
        ownerLogin,
      },
    });
    port = await listen(server);
  });

  after(async () => {
    if (server) await closeServer(server);
    if (store) {
      try {
        await store.db.dropDatabase();
      } catch {
        /* ignore */
      }
      await store.close();
    }
  });

  async function claimViaApi(code, extra = {}) {
    return httpJson(port, "POST", "/api/gotchibot/hub/pair/claim", {
      body: { code, ...extra },
    });
  }

  it("mint desk code w/o kind -> claim -> kind desk; whoami + listDesks", async () => {
    const { code, kind } = await store.mintPairingCode({ name: "mbp" });
    assert.equal(kind, "desk");
    const claim = await claimViaApi(code, { name: "desk-a" });
    assert.equal(claim.status, 200);
    assert.equal(claim.json.kind, "desk");
    const who = await httpJson(port, "GET", "/api/gotchibot/hub/whoami", {
      headers: { "X-GotchiBot-Desk-Token": claim.json.deskToken },
    });
    assert.equal(who.status, 200);
    assert.equal(who.json.kind, "desk");
    const desks = await httpJson(port, "GET", "/api/gotchibot/hub/desks", {
      headers: { "X-GotchiBot-Desk-Token": claim.json.deskToken },
    });
    assert.equal(desks.status, 200);
    const row = desks.json.desks.find((d) => d.deskId === claim.json.deskId);
    assert.ok(row);
    assert.equal(row.kind, "desk");
  });

  it("mint phone code -> claim -> kind phone", async () => {
    const { code } = await store.mintPairingCode({ name: "iphone", kind: "phone" });
    const claim = await claimViaApi(code, { name: "phone-p" });
    assert.equal(claim.status, 200);
    assert.equal(claim.json.kind, "phone");
  });

  it("phone code claimed with kind:desk -> 403; code still claimable as phone", async () => {
    const { code } = await store.mintPairingCode({ kind: "phone" });
    const bad = await claimViaApi(code, { name: "nope", kind: "desk" });
    assert.equal(bad.status, 403);
    assert.match(bad.json.error, /kind mismatch/i);
    const ok = await claimViaApi(code, { name: "phone-ok" });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.kind, "phone");
  });

  it("desk code claimed with kind:phone -> phone desk (downgrade)", async () => {
    const { code } = await store.mintPairingCode({ kind: "desk" });
    const claim = await claimViaApi(code, { name: "down", kind: "phone" });
    assert.equal(claim.status, 200);
    assert.equal(claim.json.kind, "phone");
  });

  it("invalid kind at mint throws; at claim -> 400", async () => {
    await assert.rejects(
      () => store.mintPairingCode({ kind: "tablet" }),
      (e) => e.status === 400,
    );
    const { code } = await store.mintPairingCode({ kind: "desk" });
    const bad = await claimViaApi(code, { kind: "tablet" });
    assert.equal(bad.status, 400);
  });

  it("phone scoping: hide unshared, share/unshare, own thread, push deny, routes, revoke, legacy", async () => {
    // Desk A
    const mintA = await store.mintPairingCode({ name: "desk-a", kind: "desk" });
    const claimA = await claimViaApi(mintA.code, { name: "desk-a" });
    assert.equal(claimA.status, 200);
    const tokenA = claimA.json.deskToken;
    const deskAId = claimA.json.deskId;

    // Phone P
    const mintP = await store.mintPairingCode({ name: "phone-p", kind: "phone" });
    const claimP = await claimViaApi(mintP.code, { name: "phone-p" });
    assert.equal(claimP.status, 200);
    const tokenP = claimP.json.deskToken;
    const deskPId = claimP.json.deskId;

    // Desk A pushes T1
    const pushT1 = await httpJson(port, "POST", "/api/gotchibot/chats/push", {
      headers: { "X-GotchiBot-Desk-Token": tokenA },
      body: {
        threadId: "T1",
        title: "Desk thread",
        messages: [
          {
            messageId: "t1m1",
            role: "user",
            text: "secret",
            ts: "2026-06-01T00:00:00.000Z",
          },
        ],
      },
    });
    assert.equal(pushT1.status, 200);

    // Phone P: T1 absent
    let threadsP = await httpJson(port, "GET", "/api/gotchibot/chats/threads", {
      headers: { "X-GotchiBot-Desk-Token": tokenP },
    });
    assert.equal(threadsP.status, 200);
    assert.equal(
      threadsP.json.threads.some((t) => t.threadId === "T1"),
      false,
    );
    const pullT1 = await httpJson(
      port,
      "GET",
      "/api/gotchibot/chats/pull?threadId=T1&after=0",
      { headers: { "X-GotchiBot-Desk-Token": tokenP } },
    );
    assert.equal(pullT1.status, 404);
    const pullAll = await httpJson(
      port,
      "GET",
      "/api/gotchibot/chats/pull?after=0",
      { headers: { "X-GotchiBot-Desk-Token": tokenP } },
    );
    assert.equal(pullAll.status, 200);
    assert.equal(
      pullAll.json.messages.some((m) => m.threadId === "T1"),
      false,
    );

    // share T1 with P
    const shared = await store.shareThread("T1", deskPId);
    assert.equal(shared.ok, true);
    assert.equal(shared.changed, true);
    assert.equal(shared.deskKind, "phone");

    threadsP = await httpJson(port, "GET", "/api/gotchibot/chats/threads", {
      headers: { "X-GotchiBot-Desk-Token": tokenP },
    });
    assert.ok(threadsP.json.threads.some((t) => t.threadId === "T1"));
    const sharedEntry = threadsP.json.threads.find((t) => t.threadId === "T1");
    assert.equal(sharedEntry.shared, true);
    assert.equal(sharedEntry.deskId, undefined);
    assert.equal(sharedEntry.createdByDeskId, undefined);
    assert.equal(sharedEntry.sharedWithDeskIds, undefined);

    const pullShared = await httpJson(
      port,
      "GET",
      "/api/gotchibot/chats/pull?threadId=T1&after=0",
      { headers: { "X-GotchiBot-Desk-Token": tokenP } },
    );
    assert.equal(pullShared.status, 200);
    assert.ok(pullShared.json.messages.length >= 1);
    const firstSeq = pullShared.json.messages[0].seq;
    const pullInc = await httpJson(
      port,
      "GET",
      `/api/gotchibot/chats/pull?threadId=T1&after=${firstSeq}`,
      { headers: { "X-GotchiBot-Desk-Token": tokenP } },
    );
    assert.equal(pullInc.status, 200);

    // unshare -> hidden
    const un = await store.unshareThread("T1", deskPId);
    assert.equal(un.changed, true);
    const pullGone = await httpJson(
      port,
      "GET",
      "/api/gotchibot/chats/pull?threadId=T1&after=0",
      { headers: { "X-GotchiBot-Desk-Token": tokenP } },
    );
    assert.equal(pullGone.status, 404);

    // phone pushes new T2
    const pushT2 = await httpJson(port, "POST", "/api/gotchibot/chats/push", {
      headers: { "X-GotchiBot-Desk-Token": tokenP },
      body: {
        threadId: "T2",
        title: "Phone thread",
        messages: [
          {
            messageId: "t2m1",
            role: "user",
            text: "from phone",
            ts: "2026-06-01T00:01:00.000Z",
          },
        ],
      },
    });
    assert.equal(pushT2.status, 200);
    threadsP = await httpJson(port, "GET", "/api/gotchibot/chats/threads", {
      headers: { "X-GotchiBot-Desk-Token": tokenP },
    });
    assert.ok(threadsP.json.threads.some((t) => t.threadId === "T2"));
    const ownEntry = threadsP.json.threads.find((t) => t.threadId === "T2");
    assert.equal(ownEntry.shared, false);
    assert.equal(ownEntry.deskId, undefined);

    const threadsA = await httpJson(port, "GET", "/api/gotchibot/chats/threads", {
      headers: { "X-GotchiBot-Desk-Token": tokenA },
    });
    assert.ok(threadsA.json.threads.some((t) => t.threadId === "T2"));
    assert.ok(threadsA.json.threads.some((t) => t.threadId === "T1"));
    const t1a = threadsA.json.threads.find((t) => t.threadId === "T1");
    assert.equal(t1a.createdByDeskId, deskAId);
    assert.ok(t1a.deskId);
    assert.ok(Array.isArray(t1a.sharedWithDeskIds));

    // phone push into unshared T1 -> 403, no insert
    const beforeCount = await store.db
      .collection("chat_messages")
      .countDocuments({ threadId: "T1" });
    const deny = await httpJson(port, "POST", "/api/gotchibot/chats/push", {
      headers: { "X-GotchiBot-Desk-Token": tokenP },
      body: {
        threadId: "T1",
        messages: [
          {
            messageId: "t1-deny",
            role: "user",
            text: "nope",
            ts: "2026-06-01T00:02:00.000Z",
          },
        ],
      },
    });
    assert.equal(deny.status, 403);
    assert.match(deny.json.error, /not shared/i);
    const afterCount = await store.db
      .collection("chat_messages")
      .countDocuments({ threadId: "T1" });
    assert.equal(afterCount, beforeCount);

    // phone forbidden routes
    const desks403 = await httpJson(port, "GET", "/api/gotchibot/hub/desks", {
      headers: { "X-GotchiBot-Desk-Token": tokenP },
    });
    assert.equal(desks403.status, 403);
    assert.match(desks403.json.error, /not allowed for phone/i);
    const snap403 = await httpJson(port, "POST", "/api/gotchibot/chats/snapshot", {
      headers: { "X-GotchiBot-Desk-Token": tokenP },
      body: {},
    });
    assert.equal(snap403.status, 403);

    // shareThread errors
    await assert.rejects(
      () => store.shareThread("no-such-thread", deskPId),
      (e) => e.status === 404 && /thread not found/i.test(e.message),
    );
    await assert.rejects(
      () => store.shareThread("T1", "no-such-desk"),
      (e) => e.status === 404 && /desk not found/i.test(e.message),
    );

    // revoke phone -> 401
    assert.ok(await store.revokeDesk(deskPId));
    const rev = await httpJson(port, "GET", "/api/gotchibot/hub/whoami", {
      headers: { "X-GotchiBot-Desk-Token": tokenP },
    });
    assert.equal(rev.status, 401);

    // legacy desk without kind still sees all
    const legacyToken = newDeskToken();
    const legacyId = ulid();
    await store.db.collection("desks").insertOne({
      deskId: legacyId,
      name: "legacy",
      tokenHash: hashToken(legacyToken),
      createdAt: new Date(),
      lastSeen: new Date(),
      revokedAt: null,
      // no kind field
    });
    const legacyThreads = await httpJson(
      port,
      "GET",
      "/api/gotchibot/chats/threads",
      { headers: { "X-GotchiBot-Desk-Token": legacyToken } },
    );
    assert.equal(legacyThreads.status, 200);
    assert.ok(legacyThreads.json.threads.some((t) => t.threadId === "T1"));
    assert.ok(legacyThreads.json.threads.some((t) => t.threadId === "T2"));
    const legacyWho = await httpJson(port, "GET", "/api/gotchibot/hub/whoami", {
      headers: { "X-GotchiBot-Desk-Token": legacyToken },
    });
    assert.equal(legacyWho.status, 200);
    assert.equal(legacyWho.json.kind, "desk");
  });
});

// ─── S2: phone send / reply tracking / hub-runner store (Mongo) ─────────────

describe("S2 phone send + reply tracking", async () => {
  const uri =
    process.env.GOTCHIBOT_TEST_MONGODB_URI || "mongodb://127.0.0.1:27017";
  const reachable = await mongoReachable(uri);
  if (!reachable) {
    it("skips when Mongo unreachable", { skip: "Mongo not reachable within 1.5s" }, () => {});
    return;
  }

  const dbName = `gotchibot_test_${randomBytes(6).toString("hex")}`;
  const ownerLogin = "testowner@example.com";
  let store;
  let server;
  let port;

  before(async () => {
    store = await connectStore({ mongoUri: uri, dbName });
    await store.ensureIndexes();
    server = createApiServer({
      store,
      config: {
        host: "127.0.0.1",
        port: 0,
        mongoUri: uri,
        dbName,
        ownerLogin,
      },
    });
    port = await listen(server);
  });

  after(async () => {
    if (server) await closeServer(server);
    if (store) {
      try {
        await store.db.dropDatabase();
      } catch {
        /* ignore */
      }
      await store.close();
    }
  });

  async function claim(kind, name) {
    const { code } = await store.mintPairingCode({ name, kind });
    const claim = await httpJson(port, "POST", "/api/gotchibot/hub/pair/claim", {
      body: { code, name },
    });
    assert.equal(claim.status, 200);
    return claim.json;
  }

  it("phone send new thread → user + originKind phone + reply pending", async () => {
    const phone = await claim("phone", "s2-phone-a");
    const send = await httpJson(port, "POST", "/api/gotchibot/chats/send", {
      headers: { "X-GotchiBot-Desk-Token": phone.deskToken },
      body: { text: "hello from phone", title: "Phone chat" },
    });
    assert.equal(send.status, 200);
    assert.equal(send.json.ok, true);
    assert.ok(send.json.threadId);
    assert.ok(send.json.messageId);
    assert.equal(send.json.reply.status, "pending");

    const stored = await store.db.collection("chat_messages").findOne({
      threadId: send.json.threadId,
      messageId: send.json.messageId,
    });
    assert.equal(stored.role, "user");
    assert.equal(stored.originKind, "phone");
    assert.equal(stored.reply.status, "pending");
    assert.ok(stored.reply.requestedAt);

    const pull = await httpJson(
      port,
      "GET",
      `/api/gotchibot/chats/pull?threadId=${send.json.threadId}&after=0`,
      { headers: { "X-GotchiBot-Desk-Token": phone.deskToken } },
    );
    assert.equal(pull.status, 200);
    const msg = pull.json.messages.find((m) => m.messageId === send.json.messageId);
    assert.ok(msg);
    assert.equal(msg.originKind, "phone");
    assert.equal(msg.reply.status, "pending");

    const thread = await store.db.collection("chat_threads").findOne({
      threadId: send.json.threadId,
    });
    assert.equal(thread.createdByDeskId, phone.deskId);
  });

  it("phone send into shared thread → 200", async () => {
    const desk = await claim("desk", "s2-desk-share");
    const phone = await claim("phone", "s2-phone-share");
    const push = await httpJson(port, "POST", "/api/gotchibot/chats/push", {
      headers: { "X-GotchiBot-Desk-Token": desk.deskToken },
      body: {
        threadId: "S2-SHARE",
        title: "Shared",
        messages: [
          {
            messageId: "s2-share-m1",
            role: "user",
            text: "desk seed",
            ts: "2026-06-01T00:00:00.000Z",
          },
        ],
      },
    });
    assert.equal(push.status, 200);
    await store.shareThread("S2-SHARE", phone.deskId);

    const send = await httpJson(port, "POST", "/api/gotchibot/chats/send", {
      headers: { "X-GotchiBot-Desk-Token": phone.deskToken },
      body: { threadId: "S2-SHARE", text: "phone on shared" },
    });
    assert.equal(send.status, 200);
    assert.equal(send.json.threadId, "S2-SHARE");
    assert.equal(send.json.reply.status, "pending");
  });

  it("phone send/push into unshared foreign thread → 403, no insert", async () => {
    const desk = await claim("desk", "s2-desk-deny");
    const phone = await claim("phone", "s2-phone-deny");
    await httpJson(port, "POST", "/api/gotchibot/chats/push", {
      headers: { "X-GotchiBot-Desk-Token": desk.deskToken },
      body: {
        threadId: "S2-DENY",
        messages: [
          {
            messageId: "s2-deny-seed",
            role: "user",
            text: "private",
            ts: "2026-06-01T00:00:00.000Z",
          },
        ],
      },
    });
    const before = await store.db
      .collection("chat_messages")
      .countDocuments({ threadId: "S2-DENY" });

    const denySend = await httpJson(port, "POST", "/api/gotchibot/chats/send", {
      headers: { "X-GotchiBot-Desk-Token": phone.deskToken },
      body: { threadId: "S2-DENY", text: "nope" },
    });
    assert.equal(denySend.status, 403);

    const denyPush = await httpJson(port, "POST", "/api/gotchibot/chats/push", {
      headers: { "X-GotchiBot-Desk-Token": phone.deskToken },
      body: {
        threadId: "S2-DENY",
        messages: [
          {
            messageId: "s2-deny-push",
            role: "user",
            text: "nope",
            ts: "2026-06-01T00:01:00.000Z",
          },
        ],
      },
    });
    assert.equal(denyPush.status, 403);

    const after = await store.db
      .collection("chat_messages")
      .countDocuments({ threadId: "S2-DENY" });
    assert.equal(after, before);
  });

  it("phone push role assistant coerced to user; edit/delete 403; empty 400", async () => {
    const phone = await claim("phone", "s2-phone-harden");
    const push = await httpJson(port, "POST", "/api/gotchibot/chats/push", {
      headers: { "X-GotchiBot-Desk-Token": phone.deskToken },
      body: {
        threadId: "S2-HARDEN",
        messages: [
          {
            messageId: "s2-as-asst",
            role: "assistant",
            text: "still user",
            ts: "2026-06-01T00:00:00.000Z",
          },
        ],
      },
    });
    assert.equal(push.status, 200);
    const stored = await store.db.collection("chat_messages").findOne({
      threadId: "S2-HARDEN",
      messageId: "s2-as-asst",
    });
    assert.equal(stored.role, "user");
    assert.equal(stored.originKind, "phone");

    const edit = await httpJson(port, "POST", "/api/gotchibot/chats/push", {
      headers: { "X-GotchiBot-Desk-Token": phone.deskToken },
      body: {
        threadId: "S2-HARDEN",
        messages: [
          {
            messageId: "s2-edit",
            op: "edit",
            targetMessageId: "s2-as-asst",
            text: "hack",
            ts: "2026-06-01T00:01:00.000Z",
          },
        ],
      },
    });
    assert.equal(edit.status, 403);

    const del = await httpJson(port, "POST", "/api/gotchibot/chats/push", {
      headers: { "X-GotchiBot-Desk-Token": phone.deskToken },
      body: {
        threadId: "S2-HARDEN",
        messages: [
          {
            messageId: "s2-del",
            op: "delete",
            targetMessageId: "s2-as-asst",
            ts: "2026-06-01T00:02:00.000Z",
          },
        ],
      },
    });
    assert.equal(del.status, 403);

    const empty = await httpJson(port, "POST", "/api/gotchibot/chats/send", {
      headers: { "X-GotchiBot-Desk-Token": phone.deskToken },
      body: { threadId: "S2-HARDEN", text: "   " },
    });
    assert.equal(empty.status, 400);
  });

  it("desk push unchanged — no reply / originKind", async () => {
    const desk = await claim("desk", "s2-desk-plain");
    const push = await httpJson(port, "POST", "/api/gotchibot/chats/push", {
      headers: { "X-GotchiBot-Desk-Token": desk.deskToken },
      body: {
        threadId: "S2-DESK",
        messages: [
          {
            messageId: "s2-desk-m1",
            role: "assistant",
            text: "from desk",
            ts: "2026-06-01T00:00:00.000Z",
          },
        ],
      },
    });
    assert.equal(push.status, 200);
    const stored = await store.db.collection("chat_messages").findOne({
      threadId: "S2-DESK",
      messageId: "s2-desk-m1",
    });
    assert.equal(stored.role, "assistant");
    assert.equal(stored.originKind, undefined);
    assert.equal(stored.reply, undefined);
    assert.equal(push.json.results[0].reply, undefined);
  });

  it("claim / complete / fail / retry + runner heartbeat", async () => {
    const desk = await claim("desk", "s2-desk-runner");
    const phone = await claim("phone", "s2-phone-runner");

    // Drain pending replies left by earlier tests in this suite DB.
    for (let i = 0; i < 50; i++) {
      const leftover = await store.claimNextPendingReply({ runnerId: "drain" });
      if (!leftover) break;
      await store.completeReply({
        threadId: leftover.threadId,
        messageId: leftover.messageId,
        replyMessageId: "drain",
      });
    }

    const send = await httpJson(port, "POST", "/api/gotchibot/chats/send", {
      headers: { "X-GotchiBot-Desk-Token": phone.deskToken },
      body: { text: "need reply" },
    });
    assert.equal(send.status, 200);
    const { threadId, messageId } = send.json;

    const offline = await httpJson(port, "GET", "/api/gotchibot/hub/runner", {
      headers: { "X-GotchiBot-Desk-Token": phone.deskToken },
    });
    assert.equal(offline.status, 200);
    assert.equal(offline.json.runner.status, "offline");

    await store.writeRunnerHeartbeat({
      runnerId: "hub-runner",
      status: "ok",
      detail: "idle",
      model: "test-model",
    });
    const online = await httpJson(port, "GET", "/api/gotchibot/hub/runner", {
      headers: { "X-GotchiBot-Desk-Token": phone.deskToken },
    });
    assert.equal(online.json.runner.status, "ok");
    assert.equal(online.json.runner.model, "test-model");
    assert.ok(online.json.runner.lastBeatAt);

    const claimed = await store.claimNextPendingReply({ runnerId: "hub-runner" });
    assert.ok(claimed);
    assert.equal(claimed.messageId, messageId);
    assert.equal(claimed.reply.status, "claimed");
    assert.equal(claimed.reply.attempts, 1);

    const ctx = await store.getThreadMessagesForContext(threadId, { limit: 10 });
    assert.ok(ctx.some((m) => m.messageId === messageId));

    const replyId = ulid();
    const asst = await store.pushMessages({
      threadId,
      messages: [
        {
          messageId: replyId,
          role: "assistant",
          text: "gotchi says hi",
          op: "message",
        },
      ],
      deskId: store.HUB_RUNNER_DESK_ID,
    });
    assert.equal(asst.inserted, 1);

    await store.completeReply({
      threadId,
      messageId,
      replyMessageId: replyId,
      model: "test-model",
    });
    const done = await store.db.collection("chat_messages").findOne({
      threadId,
      messageId,
    });
    assert.equal(done.reply.status, "replied");
    assert.equal(done.reply.replyMessageId, replyId);

    // Desk pull sees assistant like any message
    const pullDesk = await httpJson(
      port,
      "GET",
      `/api/gotchibot/chats/pull?threadId=${threadId}&after=0`,
      { headers: { "X-GotchiBot-Desk-Token": desk.deskToken } },
    );
    assert.ok(pullDesk.json.messages.some((m) => m.messageId === replyId && m.role === "assistant"));

    // fail + retry path
    const send2 = await httpJson(port, "POST", "/api/gotchibot/chats/send", {
      headers: { "X-GotchiBot-Desk-Token": phone.deskToken },
      body: { text: "will fail" },
    });
    const mid2 = send2.json.messageId;
    const tid2 = send2.json.threadId;
    await store.claimNextPendingReply({ runnerId: "hub-runner" });
    await store.failReply({
      threadId: tid2,
      messageId: mid2,
      error: "boom gbd_secrettoken123",
    });
    const failed = await store.db.collection("chat_messages").findOne({
      threadId: tid2,
      messageId: mid2,
    });
    assert.equal(failed.reply.status, "error");
    assert.match(failed.reply.error, /gbd_\*\*\*/);
    assert.doesNotMatch(failed.reply.error, /secrettoken/);

    const retry = await httpJson(port, "POST", "/api/gotchibot/chats/retry", {
      headers: { "X-GotchiBot-Desk-Token": phone.deskToken },
      body: { threadId: tid2, messageId: mid2 },
    });
    assert.equal(retry.status, 200);
    assert.equal(retry.json.reply.status, "pending");

    // retry on unshared foreign thread → 404
    await httpJson(port, "POST", "/api/gotchibot/chats/push", {
      headers: { "X-GotchiBot-Desk-Token": desk.deskToken },
      body: {
        threadId: "S2-FOREIGN",
        messages: [
          {
            messageId: "foreign-m1",
            role: "user",
            text: "x",
            ts: "2026-06-01T00:00:00.000Z",
          },
        ],
      },
    });
    // plant a phone-looking message via raw insert (not reachable by phone)
    await store.db.collection("chat_messages").insertOne({
      threadId: "S2-FOREIGN",
      messageId: "foreign-phone-like",
      seq: await store.db.collection("counters").findOneAndUpdate(
        { _id: "chat_seq" },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: "after" },
      ).then((d) => d.seq),
      role: "user",
      text: "hidden",
      ts: new Date(),
      op: "message",
      deskId: phone.deskId,
      originKind: "phone",
      reply: { status: "error", error: "x", failedAt: new Date() },
      createdAt: new Date(),
    });
    const retryForbidden = await httpJson(port, "POST", "/api/gotchibot/chats/retry", {
      headers: { "X-GotchiBot-Desk-Token": phone.deskToken },
      body: { threadId: "S2-FOREIGN", messageId: "foreign-phone-like" },
    });
    assert.equal(retryForbidden.status, 404);
  });

  it("hub-runner tick writes assistant reply + reply.replied", async () => {
    const phone = await claim("phone", "s2-phone-hubrun");
    // Drain leftovers
    for (let i = 0; i < 50; i++) {
      const leftover = await store.claimNextPendingReply({ runnerId: "drain" });
      if (!leftover) break;
      await store.completeReply({
        threadId: leftover.threadId,
        messageId: leftover.messageId,
        replyMessageId: "drain",
      });
    }

    const send = await httpJson(port, "POST", "/api/gotchibot/chats/send", {
      headers: { "X-GotchiBot-Desk-Token": phone.deskToken },
      body: { text: "ping gotchi" },
    });
    assert.equal(send.status, 200);
    const { threadId, messageId } = send.json;

    const { createHubRunner } = await import("../services/gotchibot-api/runner.mjs");
    const runner = createHubRunner({
      store,
      runnerId: "hub-runner-test",
      env: {
        GOTCHIBOT_HUB_RUNNER_ALLOW_NO_KEY: "1",
        PATH: process.env.PATH,
      },
      complete: async () => ({ text: "hello from gotchi", model: "test/mock" }),
      logger: { info() {}, log() {}, error() {} },
    });
    const worked = await runner.tick();
    assert.equal(worked, true);

    const orig = await store.db.collection("chat_messages").findOne({
      threadId,
      messageId,
    });
    assert.equal(orig.reply.status, "replied");
    assert.equal(orig.reply.model, "test/mock");
    assert.ok(orig.reply.replyMessageId);

    const asst = await store.db.collection("chat_messages").findOne({
      threadId,
      messageId: orig.reply.replyMessageId,
    });
    assert.ok(asst);
    assert.equal(asst.role, "assistant");
    assert.equal(asst.text, "hello from gotchi");
    assert.equal(asst.deskId, store.HUB_RUNNER_DESK_ID);

    const pull = await httpJson(
      port,
      "GET",
      `/api/gotchibot/chats/pull?threadId=${threadId}&after=0`,
      { headers: { "X-GotchiBot-Desk-Token": phone.deskToken } },
    );
    assert.ok(
      pull.json.messages.some(
        (m) => m.messageId === orig.reply.replyMessageId && m.role === "assistant",
      ),
    );
  });

  it("hub-runner model failure → error; retry → pending; later tick replies", async () => {
    const phone = await claim("phone", "s2-phone-hubfail");
    for (let i = 0; i < 50; i++) {
      const leftover = await store.claimNextPendingReply({ runnerId: "drain" });
      if (!leftover) break;
      await store.completeReply({
        threadId: leftover.threadId,
        messageId: leftover.messageId,
        replyMessageId: "drain",
      });
    }

    const send = await httpJson(port, "POST", "/api/gotchibot/chats/send", {
      headers: { "X-GotchiBot-Desk-Token": phone.deskToken },
      body: { text: "will explode" },
    });
    const { threadId, messageId } = send.json;

    const { createHubRunner } = await import("../services/gotchibot-api/runner.mjs");
    let calls = 0;
    const runner = createHubRunner({
      store,
      runnerId: "hub-runner-fail",
      env: { GOTCHIBOT_HUB_RUNNER_ALLOW_NO_KEY: "1", PATH: process.env.PATH },
      complete: async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom gbd_secrettoken999");
        return { text: "recovered", model: "test/mock2" };
      },
      logger: { info() {}, log() {}, error() {} },
    });

    await runner.tick();
    const failed = await store.db.collection("chat_messages").findOne({
      threadId,
      messageId,
    });
    assert.equal(failed.reply.status, "error");
    assert.match(failed.reply.error, /gbd_\*\*\*/);
    assert.doesNotMatch(failed.reply.error, /secrettoken/);

    const retry = await httpJson(port, "POST", "/api/gotchibot/chats/retry", {
      headers: { "X-GotchiBot-Desk-Token": phone.deskToken },
      body: { threadId, messageId },
    });
    assert.equal(retry.status, 200);
    assert.equal(retry.json.reply.status, "pending");

    await runner.tick();
    const done = await store.db.collection("chat_messages").findOne({
      threadId,
      messageId,
    });
    assert.equal(done.reply.status, "replied");
    assert.equal(done.reply.model, "test/mock2");
  });

  it("hub-runner missing provider key → heartbeat error, message stays pending", async () => {
    const phone = await claim("phone", "s2-phone-nokey");
    for (let i = 0; i < 50; i++) {
      const leftover = await store.claimNextPendingReply({ runnerId: "drain" });
      if (!leftover) break;
      await store.completeReply({
        threadId: leftover.threadId,
        messageId: leftover.messageId,
        replyMessageId: "drain",
      });
    }

    const send = await httpJson(port, "POST", "/api/gotchibot/chats/send", {
      headers: { "X-GotchiBot-Desk-Token": phone.deskToken },
      body: { text: "waiting for keys" },
    });
    const { threadId, messageId } = send.json;

    const { createHubRunner } = await import("../services/gotchibot-api/runner.mjs");
    const bareEnv = {
      PATH: process.env.PATH,
      // explicitly no provider keys, no escape hatch
    };
    const runner = createHubRunner({
      store,
      runnerId: "hub-runner-nokey",
      env: bareEnv,
      complete: async () => {
        throw new Error("should not be called");
      },
      logger: { info() {}, log() {}, error() {} },
    });
    const worked = await runner.tick();
    assert.equal(worked, false);

    const pending = await store.db.collection("chat_messages").findOne({
      threadId,
      messageId,
    });
    assert.equal(pending.reply.status, "pending");

    const status = await store.getRunnerStatus();
    assert.equal(status.status, "error");
    assert.match(status.detail || "", /no provider key|abra run gotchibot/i);

    const httpStatus = await httpJson(port, "GET", "/api/gotchibot/hub/runner", {
      headers: { "X-GotchiBot-Desk-Token": phone.deskToken },
    });
    assert.equal(httpStatus.status, 200);
    assert.equal(httpStatus.json.runner.status, "error");
    assert.match(httpStatus.json.runner.detail || "", /no provider key|abra run gotchibot/i);
  });
});

// ─── hub-runner parsers (unit, no Mongo / no opencode spawn) ─────────────────

describe("hub-runner parsers", () => {
  it("parseOpencodeOutput prefers --format json text events", async () => {
    const { parseOpencodeOutput } = await import(
      "../services/gotchibot-api/runner.mjs"
    );
    const ndjson = [
      JSON.stringify({ type: "step_start", timestamp: 1, sessionID: "s" }),
      JSON.stringify({
        type: "text",
        timestamp: 2,
        sessionID: "s",
        part: { type: "text", text: "hello from json", time: { end: 3 } },
      }),
      JSON.stringify({ type: "step_finish", timestamp: 3, sessionID: "s" }),
    ].join("\n");
    assert.equal(parseOpencodeOutput(ndjson), "hello from json");
  });

  it("parseOpencodeOutput strips ANSI + default header lines", async () => {
    const { parseOpencodeOutput } = await import(
      "../services/gotchibot-api/runner.mjs"
    );
    const raw = [
      "\x1b[2m> build · glm-5.3-flash\x1b[0m",
      "",
      "PONG",
      "",
    ].join("\n");
    assert.equal(parseOpencodeOutput(raw), "PONG");
  });

  it("parseGotchiModelEnv reads only the export line", async () => {
    const { parseGotchiModelEnv } = await import(
      "../services/gotchibot-api/runner.mjs"
    );
    assert.equal(
      parseGotchiModelEnv(
        "# comment\nexport GOTCHIBOT_OPENCODE_MODEL=opencode-go/glm-5.3-flash\nexport OTHER=nope\n",
      ),
      "opencode-go/glm-5.3-flash",
    );
    assert.equal(
      parseGotchiModelEnv('export GOTCHIBOT_OPENCODE_MODEL="opencode/big-pickle"\n'),
      "opencode/big-pickle",
    );
    assert.equal(parseGotchiModelEnv("GOTCHIBOT_OPENCODE_MODEL=nope\n"), null);
  });
});

// ─── runOpencodeOnce model-limit classification (fake spawn, no real opencode) ─

describe("runOpencodeOnce model-limit heuristics", () => {
  /** Realistic NDJSON whose timestamps/ids embed digit sequences 402 and 429. */
  function successStdoutWith402429Noise() {
    return [
      JSON.stringify({
        type: "step_start",
        timestamp: 1790356546646,
        sessionID: "ses_429deadbeef",
        snapshot: "sha256:a402bfdead429cafe",
      }),
      JSON.stringify({
        type: "text",
        timestamp: 1790429000429,
        sessionID: "ses_429deadbeef",
        part: {
          id: "prt_0d99402abc429",
          type: "text",
          text: "Hi Julius!",
          time: { start: 1790429000402, end: 1790429000429 },
        },
      }),
      JSON.stringify({
        type: "step_finish",
        timestamp: 1790429001429,
        sessionID: "ses_429deadbeef",
      }),
    ].join("\n");
  }

  function fakeSpawn({ stdout = "", stderr = "", status = 0, error = null, signal = null } = {}) {
    return () => ({ status, stdout, stderr, error, signal });
  }

  it("exit 0 + text part is ok even when timestamps/ids contain 402/429", async () => {
    const { runOpencodeOnce } = await import("../services/gotchibot-api/runner.mjs");
    const workDir = mkdtempSync(join(tmpdir(), "hub-runner-once-"));
    try {
      const r = runOpencodeOnce({
        model: "opencode/big-pickle",
        prompt: "hi",
        workDir,
        spawn: fakeSpawn({ stdout: successStdoutWith402429Noise(), status: 0 }),
      });
      assert.equal(r.ok, true);
      assert.equal(r.text, "Hi Julius!");
      assert.equal(r.reason, undefined);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("JSON error event with 429 / rate limit → model-limit", async () => {
    const { runOpencodeOnce } = await import("../services/gotchibot-api/runner.mjs");
    const workDir = mkdtempSync(join(tmpdir(), "hub-runner-once-"));
    try {
      const stdout = [
        JSON.stringify({
          type: "error",
          timestamp: 1790356546646,
          error: {
            name: "APIError",
            data: { message: "429 Too Many Requests — rate limit exceeded" },
          },
        }),
      ].join("\n");
      const r = runOpencodeOnce({
        model: "opencode/big-pickle",
        prompt: "hi",
        workDir,
        spawn: fakeSpawn({ stdout, status: 1 }),
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, "model-limit");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("failed run with stderr HTTP 402 Payment Required → model-limit", async () => {
    const { runOpencodeOnce } = await import("../services/gotchibot-api/runner.mjs");
    const workDir = mkdtempSync(join(tmpdir(), "hub-runner-once-"));
    try {
      const r = runOpencodeOnce({
        model: "opencode/big-pickle",
        prompt: "hi",
        workDir,
        spawn: fakeSpawn({
          stdout: "",
          stderr: "HTTP 402 Payment Required",
          status: 1,
        }),
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, "model-limit");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

// ─── CLI helpers (run 3) ─────────────────────────────────────────────────────

describe("hub-pair + gotchibot-api helpers", () => {
  it("resolveJoinBase picks scheme / port", async () => {
    const { resolveJoinBase } = await import("../scripts/hub-pair.mjs");
    assert.equal(resolveJoinBase("https://hub.example.ts.net"), "https://hub.example.ts.net");
    assert.equal(resolveJoinBase("100.64.1.2:9000"), "http://100.64.1.2:9000");
    assert.equal(resolveJoinBase("hub.tailnet.ts.net"), "http://hub.tailnet.ts.net:8793");
    assert.equal(resolveJoinBase("h.ts.net:8794"), "http://h.ts.net:8794");
    assert.equal(resolveJoinBase("h.ts.net"), "http://h.ts.net:8793");
  });

  it("formatJoinHost omits default 8793 and appends otherwise", async () => {
    const { formatJoinHost } = await import("../scripts/hub-pair.mjs");
    assert.equal(formatJoinHost("h.ts.net", 8793), "h.ts.net");
    assert.equal(formatJoinHost("h.ts.net", 8794), "h.ts.net:8794");
    assert.equal(formatJoinHost("h.ts.net", undefined), "h.ts.net");
    assert.equal(formatJoinHost("<MagicDNS>", 8794), "<MagicDNS>:8794");
  });

  it("hostWithoutSchemePort strips port for bare hostname pin", async () => {
    const { hostWithoutSchemePort } = await import("../scripts/hub-pair.mjs");
    assert.equal(hostWithoutSchemePort("h.ts.net:8794"), "h.ts.net");
    assert.equal(hostWithoutSchemePort("http://h.ts.net:8794"), "h.ts.net");
  });

  it("resolveAppBase: flag > env > config > https://host/app/", async () => {
    const { resolveAppBase } = await import("../scripts/hub-pair.mjs");
    assert.equal(
      resolveAppBase({
        appUrl: "https://flag.example/app/",
        env: { GOTCHIBOT_HUB_APP_URL: "https://env.example/app/" },
        config: { appUrl: "https://cfg.example/app/" },
        host: "host.ts.net",
      }),
      "https://flag.example/app/",
    );
    assert.equal(
      resolveAppBase({
        env: { GOTCHIBOT_HUB_APP_URL: "https://env.example/app/" },
        config: { appUrl: "https://cfg.example/app/" },
        host: "host.ts.net",
      }),
      "https://env.example/app/",
    );
    assert.equal(
      resolveAppBase({
        env: {},
        config: { appUrl: "https://cfg.example/app/" },
        host: "host.ts.net",
      }),
      "https://cfg.example/app/",
    );
    assert.equal(
      resolveAppBase({ env: {}, config: {}, host: "host.ts.net" }),
      "https://host.ts.net/app/",
    );
    assert.equal(
      resolveAppBase({ appUrl: "https://bare.example", env: {}, config: {} }),
      "https://bare.example/app/",
    );
    assert.equal(
      resolveAppBase({ appUrl: "https://bare.example/", env: {}, config: {} }),
      "https://bare.example/app/",
    );
    assert.equal(
      resolveAppBase({ appUrl: "https://x.example/custom", env: {}, config: {} }),
      "https://x.example/custom/",
    );
    assert.equal(
      resolveAppBase({ appUrl: "https://x.example/app", env: {}, config: {} }),
      "https://x.example/app/",
    );
  });

  it("pairDeepLink builds #pair= hash URL", async () => {
    const { pairDeepLink } = await import("../scripts/hub-pair.mjs");
    assert.equal(
      pairDeepLink("https://h.ts.net/app/", "ABCD-EFGH"),
      "https://h.ts.net/app/#pair=ABCD-EFGH",
    );
  });

  it("renderPairQr returns multi-line block QR", async () => {
    const { renderPairQr } = await import("../scripts/hub-pair.mjs");
    const qr = renderPairQr("https://h.ts.net/app/#pair=ABCD-EFGH");
    assert.ok(typeof qr === "string" && qr.length > 0);
    const lines = qr.split("\n").filter((l) => l.length > 0);
    assert.ok(lines.length > 10, `expected >10 lines, got ${lines.length}`);
    assert.match(qr, /[█▀▄]/);
  });

  it("resolvePairKind: qr defaults phone; explicit wins; else desk", async () => {
    const { resolvePairKind } = await import("../scripts/hub-pair.mjs");
    assert.equal(resolvePairKind({ qr: true }), "phone");
    assert.equal(resolvePairKind({ qr: true, kind: "desk" }), "desk");
    assert.equal(resolvePairKind({ kind: "phone" }), "phone");
    assert.equal(resolvePairKind({}), "desk");
  });

  it("buildPairOutput includes pairUrl + joinCommand", async () => {
    const { buildPairOutput } = await import("../scripts/hub-pair.mjs");
    const out = buildPairOutput({
      code: "ABCD-EFGH",
      kind: "phone",
      expiresAt: "2026-06-01T12:00:00.000Z",
      host: "h.ts.net",
      port: 8793,
      appBase: "https://h.ts.net/app/",
    });
    assert.equal(out.ok, true);
    assert.equal(out.code, "ABCD-EFGH");
    assert.equal(out.kind, "phone");
    assert.equal(out.pairUrl, "https://h.ts.net/app/#pair=ABCD-EFGH");
    assert.equal(out.joinCommand, "gotchibot hub join h.ts.net ABCD-EFGH");
    assert.equal(out.joinHost, "h.ts.net");
  });

  it("deskApiBaseFromHubPin prefers pinned deskApiBase over env port", async () => {
    const { deskApiBaseFromHubPin } = await import("../scripts/infra-client.mjs");
    assert.equal(
      deskApiBaseFromHubPin(
        { tailscaleHost: "h.ts.net", deskApiBase: "http://h.ts.net:8794" },
        {},
      ),
      "http://h.ts.net:8794",
    );
  });

  it("service unit paths are stable", async () => {
    const {
      SERVICE_LABEL,
      SYSTEMD_UNIT,
      launchAgentPath,
      systemdUnitPath,
    } = await import("../scripts/gotchibot-api.mjs");
    assert.equal(SERVICE_LABEL, "com.gotchibot.hub-api");
    assert.equal(SYSTEMD_UNIT, "gotchibot-api.service");
    assert.ok(launchAgentPath("/tmp/home").endsWith("Library/LaunchAgents/com.gotchibot.hub-api.plist"));
    assert.ok(systemdUnitPath("/tmp/home").endsWith(".config/systemd/user/gotchibot-api.service"));
  });
});

// ─── Hub install pure helpers (run 4) ────────────────────────────────────────

describe("hub-install render + parse helpers", () => {
  it("renderLaunchAgentPlist escapes XML and embeds paths", async () => {
    const { renderLaunchAgentPlist } = await import("../scripts/hub-install.mjs");
    const xml = renderLaunchAgentPlist({
      nodePath: "/usr/local/bin/node",
      serverPath: "/repo/services/gotchibot-api/server.mjs",
      workingDirectory: "/repo",
      home: "/Users/me",
      configPath: "/repo/sessions/.hub-api.json",
      stdoutPath: "/Users/me/Library/Logs/gotchibot-api.log",
      stderrPath: "/Users/me/Library/Logs/gotchibot-api.log",
    });
    assert.match(xml, /<string>com\.gotchibot\.hub-api<\/string>/);
    assert.match(xml, /<string>\/usr\/local\/bin\/node<\/string>/);
    assert.match(xml, /GOTCHIBOT_HUB_CONFIG/);
    assert.match(xml, /<true\/>/);
    const amp = renderLaunchAgentPlist({
      nodePath: "/a&b/node",
      serverPath: "/s",
      workingDirectory: "/w",
      home: "/h",
      configPath: "/c",
    });
    assert.match(amp, /\/a&amp;b\/node/);
  });

  it("renderSystemdUnit has ExecStart + Restart", async () => {
    const { renderSystemdUnit } = await import("../scripts/hub-install.mjs");
    const unit = renderSystemdUnit({
      nodePath: "/usr/bin/node",
      serverPath: "/repo/services/gotchibot-api/server.mjs",
      workingDirectory: "/repo",
      configPath: "/repo/sessions/.hub-api.json",
    });
    assert.match(unit, /^\[Unit\]/m);
    assert.match(unit, /ExecStart=\/usr\/bin\/node \/repo\/services\/gotchibot-api\/server\.mjs/);
    assert.match(unit, /Environment=GOTCHIBOT_HUB_CONFIG=\/repo\/sessions\/\.hub-api\.json/);
    assert.match(unit, /Restart=on-failure/);
    assert.match(unit, /WantedBy=default\.target/);
  });

  it("parseTailscaleStatus reads Running + DNS + login", async () => {
    const { parseTailscaleStatus } = await import("../scripts/hub-install.mjs");
    const p = parseTailscaleStatus({
      BackendState: "Running",
      Self: { DNSName: "hub.tailnet.ts.net.", UserID: 42 },
      User: { "42": { LoginName: "owner@example.com" } },
    });
    assert.equal(p.running, true);
    assert.equal(p.dnsName, "hub.tailnet.ts.net");
    assert.equal(p.ownerLogin, "owner@example.com");
    assert.equal(parseTailscaleStatus({ BackendState: "Stopped" }).running, false);
    assert.deepEqual(parseTailscaleStatus({}), {
      running: false,
      dnsName: null,
      ownerLogin: null,
    });
  });

  it("findServeHandler handles empty / TCP+Web / AllowFunnel", async () => {
    const { findServeHandler } = await import("../scripts/hub-install.mjs");
    assert.deepEqual(findServeHandler({}, 8793), {
      present: false,
      target: null,
      funnel: false,
    });
    const full = {
      TCP: { "8793": { HTTP: true } },
      Web: {
        "hub.tailnet.ts.net:8793": {
          Handlers: { "/": { Proxy: "http://127.0.0.1:8793" } },
        },
      },
      AllowFunnel: { "hub.tailnet.ts.net:8793": true },
    };
    const h = findServeHandler(full, 8793);
    assert.equal(h.present, true);
    assert.equal(h.target, "http://127.0.0.1:8793");
    assert.equal(h.funnel, true);
    const noFunnel = findServeHandler(
      {
        Web: {
          "x:8793": { Handlers: { "/": { Proxy: "http://127.0.0.1:8793" } } },
        },
      },
      8793,
    );
    assert.equal(noFunnel.funnel, false);
    assert.equal(noFunnel.target, "http://127.0.0.1:8793");
  });
});

// ─── opencode-serve guard + port registry ────────────────────────────────────

describe("opencode-serve guard + port registry", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const serveSh = resolve(root, "scripts/opencode-serve.sh");

  function makeOpencodeStub(dir, marker) {
    const stub = join(dir, "opencode");
    writeFileSync(
      stub,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(marker)}\n`,
      { mode: 0o755 },
    );
    return stub;
  }

  it("opencode-serve.sh refuses when OPENCODE_SERVER_PASSWORD is unset", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-serve-nopw-"));
    const marker = join(dir, "ran.marker");
    try {
      makeOpencodeStub(dir, marker);
      const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
      delete env.OPENCODE_SERVER_PASSWORD;
      delete env.GOTCHIBOT_OPENCODE_IOS;
      const r = spawnSync("bash", [serveSh], { encoding: "utf8", env });
      assert.notEqual(r.status, 0);
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("opencode-serve.sh refuses GOTCHIBOT_OPENCODE_IOS=1 even with a password", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-serve-ios-"));
    const marker = join(dir, "ran.marker");
    try {
      makeOpencodeStub(dir, marker);
      const r = spawnSync("bash", [serveSh], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          OPENCODE_SERVER_PASSWORD: "test-only-pw",
          GOTCHIBOT_OPENCODE_IOS: "1",
        },
      });
      assert.notEqual(r.status, 0);
      assert.equal(existsSync(marker), false);
      assert.match(`${r.stderr}\n${r.stdout}`, /removed/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("opencode-serve.sh execs stub with serve --hostname --port when password set", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-serve-ok-"));
    const marker = join(dir, "ran.marker");
    try {
      makeOpencodeStub(dir, marker);
      const r = spawnSync("bash", [serveSh], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          OPENCODE_SERVER_PASSWORD: "test-only-pw",
          GOTCHIBOT_OPENCODE_MDNS: "0",
        },
      });
      assert.equal(r.status, 0, r.stderr || r.stdout);
      assert.equal(existsSync(marker), true);
      const argv = readFileSync(marker, "utf8");
      assert.match(argv, /\bserve\b/);
      assert.match(argv, /--hostname/);
      assert.match(argv, /--port/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("iphone-qr.mjs source contains no hard-coded 100.68.95.90", () => {
    const src = readFileSync(resolve(root, "scripts/iphone-qr.mjs"), "utf8");
    assert.equal(src.includes("100.68.95.90"), false);
  });

  it("port registry: CHECKPOINT_SIGN/HOST_ARTIFACT outside RESERVED_HUB_PORTS; no stray Hub defaults", async () => {
    const { PORTS, RESERVED_HUB_PORTS } = await import("../scripts/lib/ports.mjs");
    assert.equal(PORTS.CHECKPOINT_SIGN, 8796);
    assert.equal(PORTS.HOST_ARTIFACT, 8797);
    assert.ok(!RESERVED_HUB_PORTS.includes(PORTS.CHECKPOINT_SIGN));
    assert.ok(!RESERVED_HUB_PORTS.includes(PORTS.HOST_ARTIFACT));

    // Hub API / pair clients that may still default to 8793 via ?? / ||.
    // Minimal allowlist from ripgrep of scripts/**/*.mjs for those literals.
    const allowlist = new Set(["scripts/infra-client.mjs"]);
    const re = /(\?\?|\|\|)\s*["']?879[34]["']?/;
    const hits = [];
    for (const name of readdirSync(resolve(root, "scripts"))) {
      if (!name.endsWith(".mjs")) continue;
      const rel = `scripts/${name}`;
      if (allowlist.has(rel)) continue;
      const text = readFileSync(resolve(root, rel), "utf8");
      if (re.test(text)) hits.push(rel);
    }
    for (const name of readdirSync(resolve(root, "scripts/lib"))) {
      if (!name.endsWith(".mjs")) continue;
      const rel = `scripts/lib/${name}`;
      if (allowlist.has(rel)) continue;
      const text = readFileSync(resolve(root, rel), "utf8");
      if (re.test(text)) hits.push(rel);
    }
    assert.deepEqual(hits, [], `unexpected Hub port defaults: ${hits.join(", ")}`);
  });
});

// ─── static /app/ route (no Mongo) ───────────────────────────────────────────


const APP_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../services/gotchibot-api/app",
);

describe("resolveStaticPath / contentTypeFor", () => {
  it("maps /app/ and /app/js/main.js; rejects unsafe segments and scripts/", () => {
    const index = resolveStaticPath(APP_ROOT, "/app/");
    assert.ok(index.endsWith(`${sep}index.html`.replace(/\\/g, sep)) || index.endsWith("/index.html"));
    assert.equal(resolveStaticPath(APP_ROOT, "/app/js/main.js"), resolve(APP_ROOT, "js/main.js"));
    assert.equal(resolveStaticPath(APP_ROOT, "/app/%2e%2e/package.json"), null);
    assert.equal(resolveStaticPath(APP_ROOT, "/app/..%2fpackage.json"), null);
    assert.equal(resolveStaticPath(APP_ROOT, "/app/.hidden"), null);
    assert.equal(resolveStaticPath(APP_ROOT, "/app/scripts/make-icons.mjs"), null);
    assert.equal(resolveStaticPath(APP_ROOT, "/elsewhere"), null);
  });

  it("contentTypeFor covers shell extensions", () => {
    assert.equal(contentTypeFor("index.html"), "text/html; charset=utf-8");
    assert.equal(contentTypeFor("main.js"), "text/javascript; charset=utf-8");
    assert.equal(contentTypeFor("x.mjs"), "text/javascript; charset=utf-8");
    assert.equal(contentTypeFor("app.css"), "text/css; charset=utf-8");
    assert.equal(contentTypeFor("manifest.webmanifest"), "application/manifest+json");
    assert.equal(contentTypeFor("icon.png"), "image/png");
    assert.equal(contentTypeFor("NOTICE"), "text/plain; charset=utf-8");
    assert.equal(contentTypeFor("blob.bin"), "application/octet-stream");
  });
});

describe("static /app/ route", async () => {
  const stubStore = {
    db: { command: async () => ({ ok: 1 }) },
    findDeskByToken: async () => null,
  };
  const ownerLogin = "testowner@example.com";
  let server;
  let port;

  before(async () => {
    server = createApiServer({
      store: stubStore,
      config: { host: "127.0.0.1", port: 0, ownerLogin },
    });
    port = await listen(server);
  });

  after(async () => {
    if (server) await closeServer(server);
  });

  function rawReq(method, path, headers = {}) {
    return new Promise((resolvePromise, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path,
          method,
          headers,
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            resolvePromise({
              status: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks),
            });
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("GET / -> 302 Location /app/", async () => {
    const r = await rawReq("GET", "/");
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, "/app/");
  });

  it("HEAD / -> 302 Location /app/", async () => {
    const r = await rawReq("HEAD", "/");
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, "/app/");
  });

  it("GET /health still 200 (unaffected by root redirect)", async () => {
    const r = await rawReq("GET", "/health");
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body.toString("utf8"));
    assert.equal(body.ok, true);
    assert.equal(body.service, "gotchibot-api");
  });

  it("POST / is not redirected", async () => {
    const r = await rawReq("POST", "/");
    assert.notEqual(r.status, 302);
    assert.equal(r.headers.location, undefined);
  });

  it("GET /app -> 308 Location /app/", async () => {
    const r = await rawReq("GET", "/app");
    assert.equal(r.status, 308);
    assert.equal(r.headers.location, "/app/");
  });

  it("GET /app/ -> 200 html with PWA meta; no inline script without src", async () => {
    const r = await rawReq("GET", "/app/");
    assert.equal(r.status, 200);
    assert.match(r.headers["content-type"], /^text\/html/);
    const html = r.body.toString("utf8");
    assert.match(html, /apple-mobile-web-app-capable/);
    assert.match(html, /apple-touch-icon/);
    assert.match(html, /manifest\.webmanifest/);
    assert.equal(/<script(?![^>]*\bsrc=)/i.test(html), false);
  });

  it("manifest + icons are valid", async () => {
    const r = await rawReq("GET", "/app/manifest.webmanifest");
    assert.equal(r.status, 200);
    assert.ok(r.headers["content-type"].startsWith("application/manifest+json"));
    const man = JSON.parse(r.body.toString("utf8"));
    assert.equal(man.start_url, "/app/");
    assert.equal(man.scope, "/app/");
    assert.equal(man.display, "standalone");
    assert.ok(Array.isArray(man.icons) && man.icons.length >= 2);
    assert.ok(man.icons.some((i) => String(i.purpose || "").includes("maskable")));
    for (const icon of man.icons) {
      const url = new URL(icon.src, "http://127.0.0.1/app/");
      const ir = await rawReq("GET", url.pathname);
      assert.equal(ir.status, 200, icon.src);
      assert.match(ir.headers["content-type"], /^image\/png/);
      assert.equal(ir.body[0], 0x89);
      assert.equal(ir.body[1], 0x50);
      assert.equal(ir.body[2], 0x4e);
      assert.equal(ir.body[3], 0x47);
    }
  });

  it("sw.js is javascript no-cache; precache list has no api", async () => {
    const r = await rawReq("GET", "/app/sw.js");
    assert.equal(r.status, 200);
    assert.match(r.headers["content-type"], /^text\/javascript/);
    assert.equal(r.headers["cache-control"], "no-cache");
    const src = r.body.toString("utf8");
    const m = src.match(/const SHELL\s*=\s*\[([\s\S]*?)\];/);
    assert.ok(m, "SHELL array present");
    const entries = [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
    // Never precache Hub /api/ routes or vendor/ (js/api.js module name is fine)
    for (const e of entries) {
      assert.equal(/(^|\/)api(\/|$)/.test(e), false, e);
      assert.equal(e.includes("vendor"), false, e);
    }
  });

  it("serves app.css and js/main.js", async () => {
    const css = await rawReq("GET", "/app/app.css");
    assert.equal(css.status, 200);
    assert.match(css.headers["content-type"], /^text\/css/);
    const js = await rawReq("GET", "/app/js/main.js");
    assert.equal(js.status, 200);
    assert.match(js.headers["content-type"], /^text\/javascript/);
  });

  it("security headers on static responses", async () => {
    const r = await rawReq("GET", "/app/");
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.match(r.headers["content-security-policy"] || "", /default-src 'self'/);
  });

  it("rejects encoded parent segments and dotfiles with 404", async () => {
    for (const path of [
      "/app/%2e%2e/package.json",
      "/app/..%2fpackage.json",
      "/app/.hidden",
    ]) {
      const r = await rawReq("GET", path);
      assert.equal(r.status, 404, path);
    }
  });

  it("does not serve app/scripts/*", async () => {
    const r = await rawReq("GET", "/app/scripts/make-icons.mjs");
    assert.equal(r.status, 404);
  });

  it("HEAD /app/ -> 200 with empty body", async () => {
    const r = await rawReq("HEAD", "/app/");
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 0);
    assert.ok(Number(r.headers["content-length"]) > 0);
  });

  it("owner check: x-forwarded-for without Tailscale login -> 403; with login -> 200", async () => {
    const denied = await rawReq("GET", "/app/", {
      "x-forwarded-for": "1.2.3.4",
    });
    assert.equal(denied.status, 403);
    const ok = await rawReq("GET", "/app/", {
      "x-forwarded-for": "1.2.3.4",
      "tailscale-user-login": ownerLogin,
    });
    assert.equal(ok.status, 200);
  });

  it("THIRD_PARTY license + NOTICE attribution present", () => {
    const lic = readFileSync(
      resolve(APP_ROOT, "THIRD_PARTY/Mobilecode-open-LICENSE.txt"),
      "utf8",
    );
    assert.match(lic, /Apache License/);
    const notice = readFileSync(resolve(APP_ROOT, "NOTICE"), "utf8");
    assert.match(notice, /Mobilecode-open/);
  });
});

// ─── phone app pure modules (S1 part B) ──────────────────────────────────────

describe("phone app modules", () => {
  const APP_DIR = resolve(
    fileURLToPath(new URL(".", import.meta.url)),
    "../services/gotchibot-api/app",
  );
  it("pair: normalize/format/isValid + parsePairHash + extractCodeFromScan", async () => {
    const {
      normalizeCode,
      formatCode,
      isValidCode,
      parsePairHash,
      extractCodeFromScan,
    } = await import("../services/gotchibot-api/app/js/pair.js");

    assert.equal(normalizeCode("ab cd-efgh"), "ABCDEFGH");
    assert.equal(normalizeCode("OILO"), "0110");
    assert.equal(formatCode("abcdefgh"), "ABCD-EFGH");
    assert.equal(isValidCode("ABCD-EFGH"), true);
    assert.equal(isValidCode("ABCDIOUU"), false); // I O U invalid alphabet after normalize → 1,0 stay but U invalid
    assert.equal(isValidCode("ABCD-EFG"), false);

    assert.equal(parsePairHash("#pair=abcd-efgh"), "ABCD-EFGH");
    assert.equal(parsePairHash("#/threads"), null);

    assert.equal(
      extractCodeFromScan("https://h.ts.net/app/#pair=ABCD-EFGH"),
      "ABCD-EFGH",
    );
    assert.equal(extractCodeFromScan("abcdefgh"), "ABCD-EFGH");
    assert.equal(extractCodeFromScan("not a code!!!"), null);
  });

  it("pair deep link end-to-end with hub-pair.mjs", async () => {
    const { extractCodeFromScan } = await import(
      "../services/gotchibot-api/app/js/pair.js"
    );
    const { pairDeepLink, resolveAppBase } = await import("../scripts/hub-pair.mjs");
    const base = resolveAppBase({ host: "h.ts.net", env: {}, config: {} });
    const url = pairDeepLink(base, "ABCD-EFGH");
    assert.equal(extractCodeFromScan(url), "ABCD-EFGH");
  });

  it("markdown: escapes XSS, fences, links, headings, lists", async () => {
    const { renderMarkdown } = await import(
      "../services/gotchibot-api/app/js/markdown.js"
    );

    const xss = renderMarkdown('<script>alert(1)</script><img onerror="x">');
    assert.equal(xss.includes("<script>"), false);
    assert.equal(xss.includes("<img"), false);
    assert.match(xss, /&lt;script&gt;/);

    const badLink = renderMarkdown("[x](javascript:alert(1))");
    assert.equal(badLink.includes("javascript:"), false);
    assert.match(badLink, /x/);

    const fence = renderMarkdown("```html\n<script>\n```");
    assert.match(fence, /<pre><code/);
    assert.match(fence, /&lt;script&gt;/);
    assert.equal(fence.includes("<script>"), false);

    const link = renderMarkdown("[hi](https://example.com)");
    assert.match(link, /rel="noopener noreferrer"/);
    assert.match(link, /target="_blank"/);
    assert.match(link, /href="https:\/\/example.com"/);

    const blocks = renderMarkdown("# Title\n\n- a\n- b\n\n1. one\n2. two");
    assert.match(blocks, /<h1>/);
    assert.match(blocks, /<ul>/);
    assert.match(blocks, /<ol>/);
  });

  it("thread-model: dedupe, edit, delete, ordering, lastSeq", async () => {
    const { createThreadModel, roleClass, relativeTime } = await import(
      "../services/gotchibot-api/app/js/thread-model.js"
    );
    const m = createThreadModel();
    m.applyMessages([
      { messageId: "a", seq: 2, role: "assistant", text: "two", op: "message" },
      { messageId: "b", seq: 1, role: "user", text: "one", op: "message" },
      { messageId: "a", seq: 2, role: "assistant", text: "dup", op: "message" },
    ]);
    assert.equal(m.list().length, 2);
    assert.equal(m.list()[0].text, "one");
    assert.equal(m.lastSeq, 2);

    m.applyMessages([
      { op: "edit", targetMessageId: "b", text: "one!", seq: 3 },
    ]);
    assert.equal(m.list()[0].text, "one!");
    assert.equal(m.list()[0].edited, true);
    assert.equal(m.lastSeq, 3);

    m.applyMessages([{ op: "delete", targetMessageId: "a", seq: 4 }]);
    assert.equal(m.list().length, 1);
    assert.equal(m.list()[0].messageId, "b");
    assert.equal(m.lastSeq, 4);

    assert.equal(roleClass("user"), "user");
    assert.equal(roleClass("assistant"), "assistant");
    assert.equal(roleClass("tool"), "tool");
    assert.equal(roleClass("system"), "system");
    assert.equal(relativeTime(new Date(Date.now() - 1000).toISOString(), Date.now()), "just now");
  });

  it("poller: ticks while visible, pauses, no overlap, stop cancels", async () => {
    const { createPoller } = await import(
      "../services/gotchibot-api/app/js/poller.js"
    );

    /** @type {Map<number, Function>} */
    const timers = new Map();
    let nextId = 1;
    let visible = true;
    let ticks = 0;
    let inTick = false;
    let maxOverlap = 0;
    let tickRelease = null;

    const setTimeoutFn = (fn) => {
      const id = nextId++;
      timers.set(id, fn);
      return id;
    };
    const clearTimeoutFn = (id) => {
      timers.delete(id);
    };
    const flushOne = () => {
      const [id, fn] = timers.entries().next().value || [];
      if (id == null) return false;
      timers.delete(id);
      fn();
      return true;
    };

    const poller = createPoller({
      intervalMs: 10,
      isVisible: () => visible,
      setTimeoutFn,
      clearTimeoutFn,
      tick: async () => {
        if (inTick) maxOverlap += 1;
        inTick = true;
        ticks += 1;
        await new Promise((r) => {
          tickRelease = r;
        });
        inTick = false;
      },
    });

    poller.start();
    assert.equal(poller.running, true);
    // First tick started immediately (async); release it
    await Promise.resolve();
    assert.equal(ticks, 1);
    tickRelease();
    await Promise.resolve();
    await Promise.resolve();

    // Next tick scheduled
    assert.equal(timers.size, 1);
    flushOne();
    await Promise.resolve();
    assert.equal(ticks, 2);

    // Overlap: start second tick while first still in flight — shouldn't happen via schedule
    // Hold tick 2, try to flush another timer (none until release)
    assert.equal(timers.size, 0);
    tickRelease();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(timers.size, 1);

    visible = false;
    flushOne();
    await Promise.resolve();
    // Should not tick while invisible
    assert.equal(ticks, 2);

    visible = true;
    poller.stop();
    assert.equal(poller.running, false);
    assert.equal(timers.size, 0);
    // Flush any stray
    while (flushOne()) {
      /* drain */
    }
    assert.equal(ticks, 2);
    assert.equal(maxOverlap, 0);
  });

  it("poller: setIntervalMs reschedules while running", async () => {
    const { createPoller } = await import(
      "../services/gotchibot-api/app/js/poller.js"
    );
    /** @type {Map<number, { fn: Function, ms: number }>} */
    const timers = new Map();
    let nextId = 1;
    const setTimeoutFn = (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id;
    };
    const clearTimeoutFn = (id) => {
      timers.delete(id);
    };
    let ticks = 0;
    const poller = createPoller({
      intervalMs: 4000,
      isVisible: () => true,
      setTimeoutFn,
      clearTimeoutFn,
      tick: async () => {
        ticks += 1;
      },
    });
    poller.start();
    await Promise.resolve();
    assert.equal(ticks, 1);
    assert.equal([...timers.values()][0]?.ms, 4000);
    poller.setIntervalMs(1750);
    assert.equal(poller.intervalMs, 1750);
    assert.equal([...timers.values()][0]?.ms, 1750);
    poller.stop();
  });

  it("compose-model: ids, runner lines, pullAfter, deriveComposeUi", async () => {
    const {
      newClientMessageId,
      isValidClientMessageId,
      CLIENT_MESSAGE_ID_RE,
      formatRunnerStatusLine,
      formatRunnerNotice,
      latestPhoneUserMessage,
      pullAfterForReplyWatch,
      deriveComposeUi,
      POLL_INTERVAL_FAST_MS,
      POLL_INTERVAL_NORMAL_MS,
    } = await import("../services/gotchibot-api/app/js/compose-model.js");

    const id = newClientMessageId();
    assert.equal(isValidClientMessageId(id), true);
    assert.match(id, CLIENT_MESSAGE_ID_RE);
    assert.equal(isValidClientMessageId("bad id!"), false);
    assert.equal(isValidClientMessageId("x".repeat(129)), false);

    assert.equal(
      formatRunnerStatusLine({ status: "ok", model: "gpt" }),
      "ok · gpt",
    );
    assert.equal(
      formatRunnerStatusLine({ status: "offline", detail: "no beat" }),
      "offline · no beat",
    );
    assert.equal(
      formatRunnerNotice({ status: "offline" }),
      "Hub runner offline — reply will arrive when it's back",
    );
    assert.equal(
      formatRunnerNotice({ status: "error", detail: "missing key" }),
      "missing key",
    );
    assert.equal(formatRunnerNotice({ status: "ok" }), null);

    const msgs = [
      { messageId: "a", seq: 1, role: "user", originKind: "desk", text: "x" },
      {
        messageId: "b",
        seq: 2,
        role: "user",
        originKind: "phone",
        text: "hi",
        reply: { status: "pending" },
      },
      {
        messageId: "c",
        seq: 3,
        role: "assistant",
        text: "yo",
        deskId: "hub-runner",
      },
    ];
    assert.equal(latestPhoneUserMessage(msgs)?.messageId, "b");
    assert.equal(pullAfterForReplyWatch(msgs, 3), 1);
    assert.equal(pullAfterForReplyWatch([{ seq: 5 }], 5), 5);

    const pending = deriveComposeUi({
      messages: [
        {
          messageId: "m1",
          seq: 1,
          role: "user",
          originKind: "phone",
          reply: { status: "pending" },
        },
      ],
      pendingSends: [
        { clientMessageId: "opt1", text: "hi", status: "sending" },
        { clientMessageId: "m1", text: "dup", status: "sending" },
      ],
      runner: { status: "offline" },
    });
    assert.equal(pending.optimistic.length, 1);
    assert.equal(pending.optimistic[0].clientMessageId, "opt1");
    assert.equal(pending.waitingForReply, true);
    assert.equal(pending.pollIntervalMs, POLL_INTERVAL_FAST_MS);
    assert.ok(pending.runnerNotice);
    assert.equal(pending.shouldCheckRunner, true);
    assert.equal(pending.replyError, null);

    const erred = deriveComposeUi({
      messages: [
        {
          messageId: "m2",
          seq: 2,
          role: "user",
          originKind: "phone",
          reply: { status: "error", error: "boom" },
        },
      ],
    });
    assert.equal(erred.waitingForReply, false);
    assert.deepEqual(erred.replyError, { messageId: "m2", error: "boom" });
    assert.equal(erred.pollIntervalMs, POLL_INTERVAL_NORMAL_MS);

    const replied = deriveComposeUi({
      messages: [
        {
          messageId: "m3",
          seq: 3,
          role: "user",
          originKind: "phone",
          reply: {
            status: "replied",
            model: "claude",
            replyMessageId: "a1",
          },
        },
        { messageId: "a1", seq: 4, role: "assistant", text: "ok" },
      ],
    });
    assert.equal(replied.viaModelByMessageId.get("a1"), "claude");
    assert.equal(replied.viaModelByMessageId.get("m3"), "claude");
    assert.equal(replied.waitingForReply, false);
  });

  it("thread-model: merges originKind/reply on re-apply + patchMessage", async () => {
    const { createThreadModel } = await import(
      "../services/gotchibot-api/app/js/thread-model.js"
    );
    const m = createThreadModel();
    m.applyMessages([
      {
        messageId: "p1",
        seq: 1,
        role: "user",
        text: "hi",
        originKind: "phone",
        reply: { status: "pending" },
      },
    ]);
    m.applyMessages([
      {
        messageId: "p1",
        seq: 1,
        role: "user",
        text: "hi",
        originKind: "phone",
        reply: { status: "claimed" },
      },
    ]);
    assert.equal(m.list()[0].reply.status, "claimed");
    assert.equal(m.patchMessage("p1", { reply: { status: "pending" } }), true);
    assert.equal(m.list()[0].reply.status, "pending");
    assert.equal(m.patchMessage("missing", { reply: { status: "error" } }), false);
  });

  it("APP_VERSION matches between sw.js and js/version.js", async () => {
    const sw = readFileSync(resolve(APP_DIR, "sw.js"), "utf8");
    const verMod = await import("../services/gotchibot-api/app/js/version.js");
    const swMatch = sw.match(/const APP_VERSION = ["']([^"']+)["']/);
    assert.ok(swMatch, "sw.js APP_VERSION");
    assert.equal(swMatch[1], verMod.APP_VERSION);
    assert.equal(verMod.APP_VERSION, "0.2.0");
  });

  it("sw.js SHELL lists every app/js/*.js and has no api/vendor entries", () => {
    const sw = readFileSync(resolve(APP_DIR, "sw.js"), "utf8");
    const shellMatch = sw.match(/const SHELL = \[([\s\S]*?)\];/);
    assert.ok(shellMatch, "SHELL array present");
    const shellBody = shellMatch[1];
    const entries = [...shellBody.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
    const jsFiles = readdirSync(resolve(APP_DIR, "js")).filter((f) =>
      f.endsWith(".js"),
    );
    for (const f of jsFiles) {
      assert.ok(
        entries.includes(`js/${f}`),
        `SHELL missing js/${f}`,
      );
    }
    // Never precache Hub API routes or vendor/ (jsQR is on-demand)
    for (const e of entries) {
      assert.equal(e.includes("vendor"), false, e);
      assert.equal(/(^|\/)api(\/|$)/.test(e), false, e);
    }
  });

  it("index.html has no inline style= attributes", () => {
    const html = readFileSync(resolve(APP_DIR, "index.html"), "utf8");
    assert.equal(/\sstyle\s*=/.test(html), false);
  });
});
