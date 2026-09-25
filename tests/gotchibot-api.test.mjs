/**
 * gotchibot-api unit + integration tests.
 * Integration runs only when Mongo is reachable within 1.5s.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
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
import { resolve } from "node:path";
import {
  classifyRequest,
  checkOrigin,
  normalizePairingCode,
} from "../services/gotchibot-api/auth.mjs";
import { connectStore } from "../services/gotchibot-api/store.mjs";
import { createApiServer } from "../services/gotchibot-api/server.mjs";
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

// ─── CLI helpers (run 3) ─────────────────────────────────────────────────────

describe("hub-pair + gotchibot-api helpers", () => {
  it("resolveJoinBase picks scheme / port", async () => {
    const { resolveJoinBase } = await import("../scripts/hub-pair.mjs");
    assert.equal(resolveJoinBase("https://hub.example.ts.net"), "https://hub.example.ts.net");
    assert.equal(resolveJoinBase("100.64.1.2:9000"), "http://100.64.1.2:9000");
    assert.equal(resolveJoinBase("hub.tailnet.ts.net"), "http://hub.tailnet.ts.net:8793");
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
