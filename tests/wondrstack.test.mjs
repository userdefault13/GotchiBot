/**
 * GotchiBot ↔ WondrStack, deterministic: OAuth (PKCE) per project, MCP calls,
 * and the launch pipeline, against a fake WondrStack on 127.0.0.1.
 *   node --test tests/wondrstack.test.mjs
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bodyFromVault, callTool, credKey, keyNamespace, launch, login, nextStep, pushKeys, workspaceMismatch, pushSetup } from "../scripts/wondrstack.mjs";

let server;
let base;
const ws = { state: "none", hosting: null, slug: "gotchibot" };
const codes = new Map();
const tokens = new Set();
const calls = [];
const setupCalls = [];
let agentSetup = false;
let forceBadState = false;

function status() {
  if (ws.state === "none") return { workspace: null, next_steps: [] };
  return {
    workspace: {
      business_name: "GotchiBot", slug: ws.slug, template: "blank",
      app_url: ws.hosting === "live" ? "https://gotchibot.vercel.app" : null,
      code_repository: ws.state === "repo" ? "https://github.com/wondrstack-apps/gotchibot" : null,
      provisioning: ws.state === "repo" ? "repo_created" : "running",
      hosting: ws.hosting ? { provider: "vercel", status: ws.hosting, url: null, error: null, domain: null } : null,
    },
    links: { hosting: `${base}/dashboard/hosting` },
    next_steps: [],
  };
}

before(async () => {
  server = createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    let body = "";
    for await (const c of req) body += c;
    const send = (code, obj, headers = {}) => {
      res.writeHead(code, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(obj));
    };
    if (u.pathname === "/.well-known/oauth-protected-resource/mcp") return send(200, { resource: `${base}/mcp`, authorization_servers: [base] });
    if (u.pathname === "/.well-known/oauth-authorization-server")
      return send(200, { issuer: base, authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token`, registration_endpoint: `${base}/oauth/register`, scopes_supported: ["wondrstack"] });
    if (u.pathname === "/oauth/register") return send(201, { client_id: "c1", redirect_uris: JSON.parse(body).redirect_uris });
    if (u.pathname === "/oauth/authorize") {
      // The "browser": approve at once and bounce to the loopback callback.
      const code = `code-${codes.size}`;
      codes.set(code, u.searchParams.get("code_challenge"));
      assert.equal(u.searchParams.get("code_challenge_method"), "S256");
      assert.equal(u.searchParams.get("resource"), `${base}/mcp`);
      const callback = new URL(u.searchParams.get("redirect_uri"));
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", forceBadState ? "mismatched-state" : u.searchParams.get("state"));
      forceBadState = false;
      res.writeHead(302, { location: callback.toString() });
      return res.end();
    }
    if (u.pathname === "/oauth/token") {
      const f = new URLSearchParams(body);
      if (f.get("grant_type") === "authorization_code") {
        const want = codes.get(f.get("code"));
        const got = createHash("sha256").update(f.get("code_verifier")).digest("base64url");
        if (want !== got) return send(400, { error: "invalid_grant" });
      }
      const t = `tok-${tokens.size}`;
      tokens.add(t);
      return send(200, { access_token: t, refresh_token: `r-${t}`, expires_in: 3600 });
    }
    if (u.pathname.startsWith("/api/agent/setup/")) {
      if (!tokens.has(String(req.headers.authorization || "").replace("Bearer ", ""))) return send(401, {});
      if (!agentSetup) return send(404, {});
      const b = JSON.parse(body);
      setupCalls.push({ kind: u.pathname.split("/").pop(), fields: Object.keys(b).sort() });
      return send(200, { ok: true, provider: b.provider, account: "acct_test" });
    }
    if (u.pathname === "/mcp") {
      if (!tokens.has(String(req.headers.authorization || "").replace("Bearer ", ""))) return send(401, {});
      const m = JSON.parse(body);
      if (m.method === "initialize") return send(200, { jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18" } }, { "mcp-session-id": "s1" });
      if (!m.id) { res.writeHead(202); return res.end(); }
      const { name } = m.params;
      calls.push(name);
      if (name === "create_business") ws.state = "running";
      if (name === "start_provisioning") ws.state = "running";
      const result = name === "get_status" ? status() : name === "get_setup_link" ? { url: `${base}/dashboard/hosting` } : { ok: true, workspace: { slug: ws.slug } };
      // Answer as an SSE stream, like a streamable-HTTP server may.
      res.writeHead(200, { "content-type": "text/event-stream" });
      return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } })}\n\n`);
    }
    send(404, {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const mem = new Map();
const store = { get: (k) => mem.get(k) ?? null, set: (k, v) => mem.set(k, v) };

describe("wondrstack", () => {
  it("one abra key per project", () => {
    assert.equal(credKey("gotchibot"), "WONDRSTACK_GOTCHIBOT");
    assert.equal(credKey("aarcadeghst"), "WONDRSTACK_AARCADEGHST");
    assert.throws(() => credKey("../x"));
  });

  it("signs a project in with PKCE and calls tools with its token", async () => {
    let callbackResponse;
    await login("gotchibot", {
      endpoint: `${base}/mcp`, store, log: () => {},
      open: (url) => { callbackResponse = fetch(url, { redirect: "follow" }); },
    });
    const page = await callbackResponse;
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /You're connected\./);
    assert.match(html, /Return to GotchiBot/);
    assert.match(html, /<style>/);
    assert.match(html, /class="brand-mark"[^>]*viewBox="0 0 22 24"/);
    assert.match(html, /fill="#3b81ff"/);
    assert.match(html, /<span>wondrstack<\/span>/);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    const creds = JSON.parse(mem.get("WONDRSTACK_GOTCHIBOT"));
    assert.equal(creds.client_id, "c1");
    assert.ok(creds.access_token && creds.refresh_token);
    const s = await callTool("gotchibot", "get_status", {}, { endpoint: `${base}/mcp`, store });
    assert.equal(s.workspace, null);
  });

  it("shows a styled retry page when the OAuth state does not match", async () => {
    forceBadState = true;
    let callbackResponse;
    await assert.rejects(login("gotchibot", {
      endpoint: `${base}/mcp`, store, log: () => {},
      open: (url) => { callbackResponse = fetch(url, { redirect: "follow" }); },
    }), /sign-in failed/);
    const page = await callbackResponse;
    const html = await page.text();
    assert.equal(page.status, 400);
    assert.match(html, /We couldn't connect\./);
    assert.match(html, /try signing in again/);
    assert.match(html, /<style>/);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  });

  it("knows the next step from get_status alone", () => {
    assert.equal(nextStep({ workspace: null }).step, "create");
    assert.equal(nextStep({ workspace: { provisioning: "failed" } }).step, "provision");
    assert.equal(nextStep({ workspace: { provisioning: "running" } }).step, "wait");
    assert.equal(nextStep({ workspace: { provisioning: "repo_created", hosting: null } }).step, "hosting");
    assert.equal(nextStep({ workspace: { provisioning: "repo_created", hosting: { status: "failed" } } }).step, "redeploy");
    assert.equal(nextStep({ workspace: { provisioning: "repo_created", hosting: { status: "live" } } }).step, "live");
  });

  it("launch: create → repo → hosting link (your step) → live and linked", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wondr-"));
    const opts = { endpoint: `${base}/mcp`, store, log: () => {}, open: () => {}, root, sleep: async () => { ws.state = "repo"; } };
    await assert.rejects(launch("gotchibot", { ...opts }), /--city/, "creating needs a location");
    const geo = { city: "Los Angeles", state: "CA", country: "US" };
    const r1 = await launch("gotchibot", { ...opts, ...geo, wait: true });
    assert.equal(r1.step, "hosting", "stops at the hosting link: the token is yours to paste");
    assert.match(r1.url, /dashboard\/hosting/);
    assert.ok(calls.includes("create_business"));
    ws.hosting = "live";
    const r2 = await launch("gotchibot", opts);
    assert.equal(r2.step, "live");
    const link = JSON.parse(readFileSync(path.join(root, "sessions/pstack/gotchibot/wondrstack.json"), "utf8"));
    assert.equal(link.workspace, "gotchibot");
    assert.equal(link.appUrl, "https://gotchibot.vercel.app");
    assert.equal(link.repoUrl, "https://github.com/wondrstack-apps/gotchibot");
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses another project's account: one WondrStack account per project", async () => {
    const signedInAsGotchibot = { workspace: { slug: "gotchibot", provisioning: "repo_created", hosting: { status: "live" } } };
    await assert.rejects(launch("aarcadeghst", { call: async () => signedInAsGotchibot, log: () => {} }), /workspace "gotchibot", not "aarcadeghst"/);
  });

  it("app keys come from the project's repo-named abra namespace, names only in reports", async () => {
    assert.equal(keyNamespace("gotchibot", { loadRepoFn: () => ({ name: "GotchiBot" }) }), "GotchiBot");
    assert.equal(keyNamespace("x", { loadRepoFn: () => ({ remote: "https://github.com/o/AarcadeGh-t.git" }) }), "AarcadeGh-t");
    assert.throws(() => keyNamespace("x", { loadRepoFn: () => null }), /no linked repo/);
    const vault = { "AarcadeGh-t": { MONGODB_URI: "mongodb+srv://u:p@h/db", MONGO_DB_NAME: "aarcade", STRIPE_SECRET_KEY: "sk_test_1" } };
    const get = (ns, k) => vault[ns]?.[k] || null;
    const db = bodyFromVault("database", "AarcadeGh-t", { get });
    assert.deepEqual(db.found, ["MONGODB_URI", "MONGO_DB_NAME"]);
    assert.deepEqual(db.body, { uri: "mongodb+srv://u:p@h/db", dbName: "aarcade" });
    assert.deepEqual(bodyFromVault("hosting", "AarcadeGh-t", { get }).missing, ["token"]);
    assert.deepEqual(bodyFromVault("payments", "AarcadeGh-t", { get }).found, ["STRIPE_SECRET_KEY"]);
    const lines = [];
    const sent = [];
    await pushKeys("aarcadeghst", ["hosting", "database"], { namespace: "AarcadeGh-t", get, log: (l) => lines.push(l), push: async (p, k, b) => (sent.push({ k, b }), { ok: true }) });
    assert.deepEqual(sent.map((x) => x.k), ["database"]);
    assert.ok(lines.every((l) => !l.includes("mongodb+srv")), "a secret value never reaches a log line");
  });

  it("pushes to WondrStack's agent setup endpoint, and says so plainly while it does not exist yet", async () => {
    const opts = { endpoint: `${base}/mcp`, store };
    const missing = await pushSetup("gotchibot", "hosting", { provider: "vercel", token: "t" }, opts);
    assert.equal(missing.unsupported, true);
    assert.match(missing.error, /no agent setup endpoint yet/);
    agentSetup = true;
    const r = await pushSetup("gotchibot", "hosting", { provider: "vercel", token: "t" }, opts);
    assert.deepEqual(r, { ok: true, provider: "vercel", account: "acct_test" });
    assert.deepEqual(setupCalls.at(-1), { kind: "hosting", fields: ["provider", "token"] });
    assert.equal(JSON.stringify(r).includes('"t"'), false, "the token is not echoed");
    agentSetup = false;
  });

  it("launch sends the Vercel token from abra at the hosting step, else shows the page", async () => {
    const atHosting = { workspace: { slug: "gotchibot", provisioning: "repo_created", hosting: null }, links: { hosting: "https://x/hosting" } };
    const viaVault = await launch("gotchibot", {
      call: async () => atHosting, log: () => {}, namespace: "GotchiBot",
      get: (ns, k) => (k === "VERCEL_TOKEN" ? "tok" : null), push: async () => ({ ok: true }),
    });
    assert.equal(viaVault.step, "wait");
    assert.match(viaVault.why, /sent from abra/);
    const viaPage = await launch("gotchibot", { call: async () => atHosting, log: () => {}, namespace: "GotchiBot", get: () => null, open: () => {} });
    assert.equal(viaPage.step, "hosting");
    assert.equal(viaPage.url, "https://x/hosting");
  });
});

it("workspaceMismatch: a project's sign-in must be its own workspace", () => {
  assert.equal(workspaceMismatch("gotchibot", { workspace: null }), null);
  assert.equal(workspaceMismatch("gotchibot", { workspace: { slug: "gotchibot" } }), null);
  const wrong = workspaceMismatch("gotchibot", { workspace: { slug: "aarcadeghst" } });
  assert.match(wrong, /workspace "aarcadeghst", not "gotchibot"/);
  assert.match(wrong, /wondrstack login gotchibot/);
  assert.equal(workspaceMismatch("gotchibot", { workspace: { slug: "aarcadeghst" } }, "aarcadeghst"), null);
});

describe("wondrstack device link (fake server)", async () => {
  const { deviceLink, deviceConfig, DEVICE_GRANT } = await import("../scripts/wondrstack.mjs");
  const SECRET_AT = "AT-secret-123";
  const SECRET_RT = "RT-secret-456";
  const DEVICE_CODE = "DC-secret-789";

  function fake(script) {
    const polls = [];
    const fetchFn = async (url, init) => {
      const body = Object.fromEntries(new URLSearchParams(init.body));
      const json = (status, o) => ({ status, ok: status < 400, json: async () => o });
      if (String(url).endsWith("/oauth/device_authorization")) {
        assert.equal(body.client_id, "cid");
        assert.match(body.client_name, /GotchiBot/);
        return json(200, { device_code: DEVICE_CODE, user_code: "ABCD-1234", verification_uri: "https://wondrstack.xyz/device", expires_in: 600, interval: 5 });
      }
      assert.equal(body.grant_type, DEVICE_GRANT);
      assert.equal(body.device_code, DEVICE_CODE);
      polls.push(1);
      const step = script[Math.min(polls.length - 1, script.length - 1)];
      return step === "ok" ? json(200, { access_token: SECRET_AT, refresh_token: SECRET_RT, expires_in: 3600 }) : json(400, { error: step });
    };
    return { fetchFn, polls };
  }
  function harness(script, extra = {}) {
    const f = fake(script);
    const out = [];
    const sleeps = [];
    const saved = {};
    let t = 0;
    const opts = {
      config: deviceConfig({ WONDRSTACK_DEVICE_CLIENT_ID: "cid" }, "https://wondrstack.xyz/mcp"),
      store: { get: (k) => saved[k] || null, set: (k, v) => { saved[k] = v; } },
      log: (m) => out.push(String(m)),
      sleep: async (ms) => { sleeps.push(ms); t += ms; },
      now: () => t,
      fetchFn: f.fetchFn,
      ...extra,
    };
    return { opts, out, sleeps, saved, polls: f.polls };
  }
  const noLeak = (out, err) => {
    const all = out.join("\n") + String(err?.message || "");
    for (const s of [SECRET_AT, SECRET_RT, DEVICE_CODE]) assert.ok(!all.includes(s), "token leaked");
  };

  const memCache = (init) => { const m = new Map(init ? [["gotchibot", init]] : []); return { get: (p) => m.get(p) || null, set: (p, id) => m.set(p, id), m }; };
  function regFetch(inner, reg) {
    const calls = [];
    const fetchFn = async (url, init) => {
      if (String(url).endsWith("/oauth/register")) {
        calls.push(JSON.parse(init.body));
        return reg();
      }
      return inner(url, init);
    };
    return { fetchFn, calls };
  }
  const regOk = () => ({ status: 201, ok: true, json: async () => ({ client_id: "cid", client_secret_x: "REG-SECRET" }) });

  it("first run registers a public device_code client, caches it, and does not log the response", async () => {
    const h = harness(["ok"]);
    const cache = memCache();
    const r = regFetch(h.opts.fetchFn, regOk);
    await deviceLink("gotchibot", { ...h.opts, config: deviceConfig({}, "https://wondrstack.xyz/mcp"), cache, fetchFn: r.fetchFn });
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].token_endpoint_auth_method, "none");
    assert.ok(r.calls[0].grant_types.includes(DEVICE_GRANT));
    assert.match(r.calls[0].client_name, /GotchiBot/);
    assert.equal(cache.m.get("gotchibot"), "cid");
    assert.ok(!h.out.join("\n").includes("REG-SECRET"));
    noLeak(h.out);
  });

  it("cached id is reused without registering", async () => {
    const h = harness(["ok"]);
    const r = regFetch(h.opts.fetchFn, () => { throw new Error("must not register"); });
    await deviceLink("gotchibot", { ...h.opts, config: deviceConfig({}, "https://wondrstack.xyz/mcp"), cache: memCache("cid"), fetchFn: r.fetchFn });
    assert.equal(r.calls.length, 0);
  });

  it("env override skips cache and registration", async () => {
    const h = harness(["ok"]);
    const r = regFetch(h.opts.fetchFn, () => { throw new Error("must not register"); });
    const cache = memCache("other");
    await deviceLink("gotchibot", { ...h.opts, config: deviceConfig({ WONDRSTACK_DEVICE_CLIENT_ID: "cid" }, "https://wondrstack.xyz/mcp"), cache, fetchFn: r.fetchFn });
    assert.equal(r.calls.length, 0);
  });

  it("registration failure is a clear error and caches nothing", async () => {
    const h = harness(["ok"]);
    const cache = memCache();
    const r = regFetch(h.opts.fetchFn, () => ({ status: 400, ok: false, json: async () => ({ error: "invalid_client_metadata", detail: "REG-SECRET" }) }));
    await assert.rejects(
      deviceLink("gotchibot", { ...h.opts, config: deviceConfig({}, "https://wondrstack.xyz/mcp"), cache, fetchFn: r.fetchFn }),
      (e) => /client registration failed \(invalid_client_metadata\)/.test(e.message) && !e.message.includes("REG-SECRET"),
    );
    assert.equal(cache.m.size, 0);
    assert.equal(h.polls.length, 0);
  });

  it("pending then success: stores tokens, prints code and link only", async () => {
    const h = harness(["authorization_pending", "authorization_pending", "ok"]);
    await deviceLink("gotchibot", h.opts);
    assert.equal(h.polls.length, 3);
    const joined = h.out.join("\n");
    assert.match(joined, /ABCD-1234/);
    assert.match(joined, /wondrstack\.xyz\/device/);
    assert.match(joined, /matches/);
    const creds = JSON.parse(h.saved[credKey("gotchibot")]);
    assert.equal(creds.access_token, SECRET_AT);
    assert.equal(creds.refresh_token, SECRET_RT);
    noLeak(h.out);
  });

  it("slow_down backs off the interval", async () => {
    const h = harness(["slow_down", "authorization_pending", "ok"]);
    await deviceLink("gotchibot", h.opts);
    assert.deepEqual(h.sleeps, [5000, 10000, 10000]);
    noLeak(h.out);
  });

  it("access_denied stops and stores nothing", async () => {
    const h = harness(["authorization_pending", "access_denied"]);
    await assert.rejects(deviceLink("gotchibot", h.opts), (e) => { noLeak(h.out, e); return /denied/.test(e.message); });
    assert.deepEqual(h.saved, {});
    assert.equal(h.polls.length, 2);
  });

  it("expired_token from the server stops", async () => {
    const h = harness(["expired_token"]);
    await assert.rejects(deviceLink("gotchibot", h.opts), /expired/);
    assert.deepEqual(h.saved, {});
    assert.equal(h.polls.length, 1);
  });

  it("local deadline stops polling without looping on", async () => {
    const h = harness(["authorization_pending"]);
    await assert.rejects(deviceLink("gotchibot", h.opts), /expired/);
    assert.ok(h.polls.length <= 121);
    assert.deepEqual(h.saved, {});
    noLeak(h.out);
  });
});
