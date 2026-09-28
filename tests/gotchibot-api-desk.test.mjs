/**
 * Phone desk app backend: wallet sign-in, project portfolio, project threads.
 * Integration runs only when Mongo is reachable within 1.5s.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoClient } from "mongodb";
import { connectStore } from "../services/gotchibot-api/store.mjs";
import { createApiServer } from "../services/gotchibot-api/server.mjs";
import {
  createProjectSource,
  cssColor,
  normalizeAvatarSvg,
  parseStatusUnits,
  projectSlugOk,
} from "../services/gotchibot-api/projects.mjs";
import {
  createCastVerifier,
  isAddress,
  isSignature,
  resolveOwnerWallet,
  walletLoginMessage,
} from "../services/gotchibot-api/wallet.mjs";
import {
  GENERAL,
  chatHash,
  filterProjects,
  groupThreadsByProject,
  kanbanSegments,
  parseDeskRoute,
  roleLabel,
  shortAddress,
  spiritChar,
  statusTone,
  toHexUtf8,
  walletBrowserLinks,
} from "../services/gotchibot-api/app/js/desk-model.js";

const OWNER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const OWNER_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const STRANGER = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const FAKE_SIG = `0x${"ab".repeat(65)}`;

function writeJson(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

/** Minimal repo tree: two projects, one smoke room, hero caches, one avatar. */
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "gb-desk-"));
  const ps = join(root, "sessions/pstack");
  mkdirSync(join(ps, "alpha"), { recursive: true });
  mkdirSync(join(ps, "beta"), { recursive: true });
  mkdirSync(join(ps, "nest-smoke-test"), { recursive: true });
  mkdirSync(join(root, "sessions/.avatars"), { recursive: true });
  mkdirSync(join(root, "config"), { recursive: true });
  writeJson(join(ps, "alpha/dossier.json"), {
    slug: "alpha",
    status: "ready",
    updatedAt: "2026-09-20T00:00:00.000Z",
    fields: { title: "Alpha Desk", goal: "Ship alpha", playbook: "Orchestrate" },
  });
  writeJson(join(ps, "alpha/roster.json"), { heroes: ["owned-1", "starter-dai-1", "../evil"] });
  writeJson(join(ps, "alpha/kanban.json"), {
    cards: [
      { id: "k1", title: "one", column: "todo", updatedAt: "2026-09-21T00:00:00.000Z" },
      { id: "k2", title: "two", column: "doing", owner: "starter-dai-1", updatedAt: "2026-09-22T00:00:00.000Z" },
    ],
  });
  writeFileSync(join(ps, "alpha/status.md"), "# pstack status — alpha\n\nUnits: 3 (running=1 done=2)\n");
  writeFileSync(join(ps, "beta/overview.md"), "# beta\n\nGoal: Beta things\n");
  writeFileSync(join(ps, "nest-smoke-test/overview.md"), "# smoke\n");
  writeFileSync(join(root, "sessions/.project-current"), "beta\n");
  writeJson(join(root, "sessions/.hero-agent-state.json"), {
    "owned-1": { collateral: "uni", primary: "ff2a7a", status: "idle", host: "local" },
    "starter-dai-1": { collateral: "dai", primary: "ff7d00", status: "working", host: "imac" },
  });
  writeJson(join(root, "config/agent-roles.json"), { "owned-1": "orchestrator" });
  writeFileSync(join(root, "sessions/.avatars/owned-1.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  return root;
}

// ─── pure ────────────────────────────────────────────────────────────────────

describe("wallet helpers", () => {
  it("validates address / signature shapes", () => {
    assert.equal(isAddress(OWNER), true);
    assert.equal(isAddress("0x123"), false);
    assert.equal(isSignature(FAKE_SIG), true);
    assert.equal(isSignature("0xdead"), false);
  });

  it("login message binds host + nonce", () => {
    const m = walletLoginMessage({ nonce: "0x01", host: "hub.example", issuedAt: "t" });
    assert.match(m, /^GotchiBot Hub sign-in\n/);
    assert.match(m, /Host: hub\.example/);
    assert.match(m, /Nonce: 0x01/);
  });

  it("owner wallet: config wins, else sessions/.wallet.json", () => {
    const root = mkdtempSync(join(tmpdir(), "gb-wallet-"));
    try {
      assert.equal(resolveOwnerWallet({}, root), null);
      mkdirSync(join(root, "sessions"));
      writeJson(join(root, "sessions/.wallet.json"), { address: STRANGER.toUpperCase().replace("0X", "0x") });
      assert.equal(resolveOwnerWallet({}, root), STRANGER);
      assert.equal(resolveOwnerWallet({ ownerWallet: OWNER }, root), OWNER);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const hasCast = spawnSync("cast", ["--version"]).status === 0;
  it("cast verifier accepts a real signature, rejects a tampered message", { skip: !hasCast && "cast not installed" }, async () => {
    const msg = walletLoginMessage({ nonce: "0xfeed", host: "h", issuedAt: "t" });
    const sig = execFileSync("cast", ["wallet", "sign", "--private-key", OWNER_PK, msg]).toString().trim();
    const verify = createCastVerifier();
    assert.equal(await verify({ address: OWNER, message: msg, signature: sig }), true);
    assert.equal(await verify({ address: OWNER, message: `${msg}!`, signature: sig }), false);
  });
});

describe("project source", () => {
  it("helpers", () => {
    assert.deepEqual(parseStatusUnits("x\nUnits: 6 (running=2 done=4)\n"), { total: 6, running: 2, done: 4 });
    assert.equal(parseStatusUnits("nothing"), null);
    assert.equal(cssColor("0xFF7D00"), "#ff7d00");
    assert.equal(cssColor("red"), null);
    assert.equal(projectSlugOk("../x"), false);
    assert.equal(normalizeAvatarSvg('<svg xmlns=\\"http://www.w3.org/2000/svg\\"><g/></svg>'), '<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>');
    assert.equal(normalizeAvatarSvg('"<svg viewBox=\\"0 0 1 1\\"/>"'), '<svg viewBox="0 0 1 1"/>');
    assert.equal(normalizeAvatarSvg("<svg><g/></svg>"), "<svg><g/></svg>");
    assert.equal(normalizeAvatarSvg("<html>nope"), null);
  });

  it("lists rooms (current first, smoke hidden) and details roster + kanban", () => {
    const root = makeRoot();
    try {
      const src = createProjectSource({ root, heroName: (id) => (id === "owned-1" ? "UNI" : null) });
      const list = src.listProjects();
      assert.deepEqual(list.map((p) => p.slug), ["beta", "alpha"]);
      assert.equal(list[0].current, true);
      assert.equal(list[0].goal, "Beta things");
      const alpha = list[1];
      assert.equal(alpha.title, "Alpha Desk");
      assert.equal(alpha.heroCount, 2, "path-like hero ids are dropped");
      assert.deepEqual(alpha.units, { total: 3, running: 1, done: 2 });
      assert.equal(alpha.kanban.todo, 1);
      assert.equal(alpha.kanban.doing, 1);

      const detail = src.getProject("alpha");
      assert.equal(detail.roster[0].id, "owned-1", "orchestrator sorts first");
      assert.equal(detail.roster[0].name, "UNI");
      assert.equal(detail.roster[0].orchestrator, true);
      assert.equal(detail.roster[0].color, "#ff2a7a");
      assert.equal(detail.roster[0].hasAvatar, true);
      assert.equal(detail.roster[1].status, "working");
      assert.equal(detail.cards[0].id, "k2", "newest card first");

      assert.equal(src.getProject("nest-smoke-test"), null);
      assert.equal(src.getProject("../sessions"), null);
      assert.equal(src.getProject("missing"), null);
      assert.ok(src.avatarPath("owned-1"));
      assert.equal(src.avatarPath("../owned-1"), null);
      assert.equal(src.avatarPath("starter-dai-1"), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("app desk-model", () => {
  it("routes", () => {
    assert.deepEqual(parseDeskRoute(""), { name: "projects" });
    assert.deepEqual(parseDeskRoute("#/threads"), { name: "projects" });
    assert.deepEqual(parseDeskRoute("#/login"), { name: "login" });
    assert.deepEqual(parseDeskRoute("#/p/alpha"), { name: "chat", project: "alpha", threadId: null });
    assert.deepEqual(parseDeskRoute("#/p/alpha/t/new"), { name: "chat", project: "alpha", threadId: "new" });
    assert.deepEqual(parseDeskRoute("#/thread/01ABC"), { name: "chat", project: GENERAL, threadId: "01ABC" });
    assert.equal(chatHash("alpha", "01X"), "#/p/alpha/t/01X");
    assert.equal(chatHash(null, null), `#/p/${GENERAL}`);
  });

  it("grouping, filtering, bars, labels", () => {
    const g = groupThreadsByProject([
      { threadId: "a", project: "alpha", updatedAt: "2026-01-01" },
      { threadId: "b", project: null, updatedAt: "2026-01-02" },
      { threadId: "c", project: "alpha", lastMessageAt: "2026-01-03" },
    ]);
    assert.deepEqual(g.get("alpha").map((t) => t.threadId), ["c", "a"]);
    assert.deepEqual(g.get(GENERAL).map((t) => t.threadId), ["b"]);
    const ps = [{ slug: "x", title: "Trader", goal: "" }, { slug: "y", title: "Art", goal: "sprites" }];
    assert.deepEqual(filterProjects(ps, "SPRITE").map((p) => p.slug), ["y"]);
    assert.equal(filterProjects(ps, "").length, 2);
    const segs = kanbanSegments({ todo: 1, doing: 1, done: 2 });
    assert.deepEqual(segs.map((s) => [s.column, s.pct]), [["done", 50], ["doing", 25], ["todo", 25]]);
    assert.deepEqual(kanbanSegments({}), []);
    assert.equal(spiritChar("maDAI"), "D");
    assert.equal(spiritChar("wbtc"), "B");
    assert.equal(spiritChar(null, "prof"), "P");
    assert.equal(roleLabel("financial-analyst"), "Financial analyst");
    assert.equal(roleLabel(null), "Crew");
    assert.equal(statusTone("working"), "live");
    assert.equal(statusTone("assigned"), "busy");
    assert.equal(statusTone("whatever"), "idle");
    assert.equal(shortAddress(OWNER), "0x7099…79c8");
    assert.equal(toHexUtf8("Hi\n"), "0x48690a");
    const links = walletBrowserLinks("https://hub.ts.net/app/");
    assert.equal(links[0].href, "https://metamask.app.link/dapp/hub.ts.net/app/");
    assert.match(links[1].href, /cb_url=https%3A%2F%2Fhub\.ts\.net%2Fapp%2F$/);
  });
});

// ─── integration ─────────────────────────────────────────────────────────────

async function mongoReachable(uri, ms = 1500) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: ms, connectTimeoutMS: ms });
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    return true;
  } catch {
    return false;
  } finally {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function call(port, method, path, { token, body } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(body != null ? { "Content-Type": "application/json" } : {}),
      ...(token ? { "X-GotchiBot-Desk-Token": token } : {}),
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json() : await res.text();
  return { status: res.status, data, headers: res.headers };
}

describe("phone desk API", async () => {
  const uri = process.env.GOTCHIBOT_TEST_MONGODB_URI || "mongodb://127.0.0.1:27017";
  if (!(await mongoReachable(uri))) {
    it("skips when Mongo unreachable", { skip: "Mongo not reachable within 1.5s" }, () => {});
    return;
  }

  const dbName = `gotchibot_test_${randomBytes(6).toString("hex")}`;
  const root = makeRoot();
  let store;
  let server;
  let port;
  /** Signatures the fake verifier accepts, keyed by message. */
  const goodSigs = new Map();

  before(async () => {
    store = await connectStore({ mongoUri: uri, dbName });
    await store.ensureIndexes();
    server = createApiServer({
      store,
      config: { host: "127.0.0.1", port: 0, ownerLogin: "owner@example.com", projectsRoot: root, ownerWallet: OWNER },
      projects: createProjectSource({ root }),
      verifyWallet: async ({ message, signature }) => goodSigs.get(message) === signature,
    });
    port = await listen(server);
  });

  after(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (store) {
      try {
        await store.db.dropDatabase();
      } catch {
        /* ignore */
      }
      await store.close();
    }
    rmSync(root, { recursive: true, force: true });
  });

  async function nonce() {
    const r = await call(port, "POST", "/api/gotchibot/hub/wallet/nonce", { body: {} });
    assert.equal(r.status, 200);
    assert.match(r.data.message, /Nonce: 0x[0-9a-f]{32}/);
    return r.data;
  }

  async function walletPhone() {
    const n = await nonce();
    const sig = `0x${randomBytes(65).toString("hex")}`;
    goodSigs.set(n.message, sig);
    const r = await call(port, "POST", "/api/gotchibot/hub/wallet/login", {
      body: { address: OWNER, signature: sig, nonce: n.nonce, name: "Test iPhone" },
    });
    assert.equal(r.status, 200);
    return r.data;
  }

  it("wallet login → phone desk token; whoami shows wallet; nonce is single-use", async () => {
    const n = await nonce();
    const sig = `0x${randomBytes(65).toString("hex")}`;
    goodSigs.set(n.message, sig);
    const login = await call(port, "POST", "/api/gotchibot/hub/wallet/login", {
      body: { address: OWNER.toUpperCase().replace("0X", "0x"), signature: sig, nonce: n.nonce },
    });
    assert.equal(login.status, 200);
    assert.equal(login.data.kind, "phone");
    assert.match(login.data.deskToken, /^gbd_/);
    const who = await call(port, "GET", "/api/gotchibot/hub/whoami", { token: login.data.deskToken });
    assert.equal(who.data.walletAddress, OWNER);
    assert.equal(who.data.kind, "phone");

    const replay = await call(port, "POST", "/api/gotchibot/hub/wallet/login", {
      body: { address: OWNER, signature: sig, nonce: n.nonce },
    });
    assert.equal(replay.status, 401);
  });

  it("wallet login rejects stranger wallet and bad signature", async () => {
    const a = await nonce();
    const stranger = await call(port, "POST", "/api/gotchibot/hub/wallet/login", {
      body: { address: STRANGER, signature: FAKE_SIG, nonce: a.nonce },
    });
    assert.equal(stranger.status, 403);

    const b = await nonce();
    const bad = await call(port, "POST", "/api/gotchibot/hub/wallet/login", {
      body: { address: OWNER, signature: FAKE_SIG, nonce: b.nonce },
    });
    assert.equal(bad.status, 401);

    const malformed = await call(port, "POST", "/api/gotchibot/hub/wallet/login", {
      body: { address: OWNER, signature: "0x12", nonce: "x" },
    });
    assert.equal(malformed.status, 400);
  });

  it("wallet handoff returns a phone pairing code instead of a token", async () => {
    const n = await nonce();
    const sig = `0x${randomBytes(65).toString("hex")}`;
    goodSigs.set(n.message, sig);
    const r = await call(port, "POST", "/api/gotchibot/hub/wallet/login", {
      body: { address: OWNER, signature: sig, nonce: n.nonce, handoff: true },
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.deskToken, undefined);
    assert.match(r.data.handoff.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const claim = await call(port, "POST", "/api/gotchibot/hub/pair/claim", {
      body: { code: r.data.handoff.code, name: "PWA" },
    });
    assert.equal(claim.status, 200);
    assert.equal(claim.data.kind, "phone");
  });

  it("projects list / detail / avatar need a desk token", async () => {
    const phone = await walletPhone();
    assert.equal((await call(port, "GET", "/api/gotchibot/projects")).status, 401);
    const list = await call(port, "GET", "/api/gotchibot/projects", { token: phone.deskToken });
    assert.equal(list.status, 200);
    assert.deepEqual(list.data.projects.map((p) => p.slug), ["beta", "alpha"]);
    const detail = await call(port, "GET", "/api/gotchibot/projects/alpha", { token: phone.deskToken });
    assert.equal(detail.data.project.roster.length, 2);
    assert.equal((await call(port, "GET", "/api/gotchibot/projects/nope", { token: phone.deskToken })).status, 404);
    const svg = await call(port, "GET", "/api/gotchibot/avatars/owned-1.svg", { token: phone.deskToken });
    assert.equal(svg.status, 200);
    assert.equal(svg.headers.get("content-type"), "image/svg+xml");
    assert.match(svg.headers.get("content-security-policy"), /default-src 'none'/);
    assert.equal((await call(port, "GET", "/api/gotchibot/avatars/starter-dai-1.svg", { token: phone.deskToken })).status, 404);
  });

  it("send with project tags a new thread; threads filter by project / none", async () => {
    const phone = await walletPhone();
    const t = phone.deskToken;
    const a = await call(port, "POST", "/api/gotchibot/chats/send", {
      token: t,
      body: { text: "alpha question", project: "alpha" },
    });
    assert.equal(a.status, 200);
    assert.equal(a.data.project, "alpha");
    const g = await call(port, "POST", "/api/gotchibot/chats/send", { token: t, body: { text: "general" } });
    assert.equal(g.status, 200);
    // follow-up in an existing thread never re-tags it
    await call(port, "POST", "/api/gotchibot/chats/send", {
      token: t,
      body: { threadId: g.data.threadId, text: "more", project: "beta" },
    });

    const inAlpha = await call(port, "GET", "/api/gotchibot/chats/threads?project=alpha", { token: t });
    assert.deepEqual(inAlpha.data.threads.map((x) => x.threadId), [a.data.threadId]);
    assert.equal(inAlpha.data.threads[0].project, "alpha");
    const none = await call(port, "GET", "/api/gotchibot/chats/threads?project=none", { token: t });
    assert.deepEqual(none.data.threads.map((x) => x.threadId), [g.data.threadId]);
    const all = await call(port, "GET", "/api/gotchibot/chats/threads", { token: t });
    assert.equal(all.data.threads.length, 2);

    const bad = await call(port, "POST", "/api/gotchibot/chats/send", {
      token: t,
      body: { text: "x", project: "../etc" },
    });
    assert.equal(bad.status, 400);
  });
});
