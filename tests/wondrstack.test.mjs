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
import { callTool, credKey, launch, login, nextStep } from "../scripts/wondrstack.mjs";

let server;
let base;
const ws = { state: "none", hosting: null, slug: "gotchibot" };
const codes = new Map();
const tokens = new Set();
const calls = [];

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
      res.writeHead(302, { location: `${u.searchParams.get("redirect_uri")}?code=${code}&state=${u.searchParams.get("state")}` });
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
    await login("gotchibot", {
      endpoint: `${base}/mcp`, store, log: () => {},
      open: (url) => fetch(url, { redirect: "follow" }).catch(() => {}),
    });
    const creds = JSON.parse(mem.get("WONDRSTACK_GOTCHIBOT"));
    assert.equal(creds.client_id, "c1");
    assert.ok(creds.access_token && creds.refresh_token);
    const s = await callTool("gotchibot", "get_status", {}, { endpoint: `${base}/mcp`, store });
    assert.equal(s.workspace, null);
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
});
