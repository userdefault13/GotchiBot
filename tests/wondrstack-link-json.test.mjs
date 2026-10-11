/**
 * Non-interactive WondrStack link (start / wait) for agents: fake server only, no TTY, no abra.
 *   node --test tests/wondrstack-link-json.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { accessSession, credKey, defaultLinkProject, deviceConfig, deviceStart, deviceWait, DEVICE_GRANT } from "../scripts/wondrstack.mjs";
import { wondrstackLink } from "../mcp-servers/hub-status/link-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL = "http://127.0.0.1:3000";
const AT = "AT-secret-123";
const RT = "RT-secret-456";
const DC = "DC-secret-789";

function setup(script, { authError, netFail } = {}) {
  const calls = { register: [], auth: [], token: [] };
  let polls = 0;
  const json = (status, o) => ({ status, ok: status < 400, json: async () => o });
  const fetchFn = async (url, init) => {
    const u = String(url);
    if (u.endsWith("/oauth/register")) {
      calls.register.push({ url: u, body: JSON.parse(init.body) });
      return json(201, { client_id: "wsc_abc" });
    }
    const form = Object.fromEntries(new URLSearchParams(init.body));
    if (u.endsWith("/oauth/device_authorization")) {
      calls.auth.push({ url: u, form });
      if (authError) return json(401, { error: authError });
      return json(200, { device_code: DC, user_code: "BCDF-GHJK", verification_uri: `${LOCAL}/device`, verification_uri_complete: `${LOCAL}/device?user_code=BCDF-GHJK`, expires_in: 600, interval: 5 });
    }
    if (netFail) throw Object.assign(new Error("boom"), { cause: { code: "ECONNREFUSED" } });
    calls.token.push({ url: u, form });
    assert.equal(form.grant_type, DEVICE_GRANT);
    const step = script[Math.min(polls++, script.length - 1)];
    return step === "ok" ? json(200, { access_token: AT, refresh_token: RT, expires_in: 3600 }) : json(400, { error: step });
  };
  let t = 5_000_000;
  const saved = new Map();
  return {
    calls,
    saved,
    stateDir: mkdtempSync(path.join(tmpdir(), "wsl-")),
    opts: {
      fetchFn,
      config: deviceConfig({ WONDRSTACK_DEVICE_BASE_URL: LOCAL }),
      cache: { get: () => null, set: () => {} },
      now: () => t,
      sleep: async (ms) => { t += ms; },
      store: { get: (k) => saved.get(k) || null, set: (k, v) => saved.set(k, v), remove: (k) => saved.delete(k) },
    },
  };
}
const START = { confirmFullScope: true };
const PEND = "pending-gotchibot-local.json";
const leak = (o) => {
  const s = JSON.stringify(o);
  for (const x of [AT, RT, DC]) assert.ok(!s.includes(x), `leaked ${x}`);
};

describe("start", () => {
  it("refuses without the explicit full-scope confirm, and does nothing", async () => {
    const h = setup(["ok"]);
    const r = await deviceStart("gotchibot-local", { ...h.opts, stateDir: h.stateDir });
    assert.equal(r.kind, "confirm_required");
    assert.match(r.warning, /FULL `wondrstack` scope/);
    assert.equal(h.calls.register.length + h.calls.auth.length, 0);
    assert.equal(existsSync(path.join(h.stateDir, PEND)), false);
    leak(r);
  });

  it("returns link, complete link, user code, expiry and the warning; saves a 0600 pending file; prints no device code", async () => {
    const h = setup(["ok"]);
    const r = await deviceStart("gotchibot-local", { ...START, ...h.opts, stateDir: h.stateDir });
    assert.deepEqual(
      { ok: r.ok, status: r.status, uri: r.verification_uri, complete: r.verification_uri_complete, code: r.user_code, exp: r.expires_in, interval: r.interval, base: r.base },
      { ok: true, status: "pending", uri: `${LOCAL}/device`, complete: `${LOCAL}/device?user_code=BCDF-GHJK`, code: "BCDF-GHJK", exp: 600, interval: 5, base: LOCAL },
    );
    assert.match(r.warning, /deploy, delete, spend/);
    assert.match(r.next, /matches/);
    leak(r);
    const f = path.join(h.stateDir, PEND);
    assert.equal(statSync(f).mode & 0o777, 0o600);
    assert.ok(readFileSync(f, "utf8").includes(DC));
  });

  it("sends the right data to the local server: redirect_uris, device_code grant, scope, client name, local URLs", async () => {
    const h = setup(["ok"]);
    await deviceStart("gotchibot-local", { ...START, ...h.opts, stateDir: h.stateDir });
    const reg = h.calls.register[0];
    assert.equal(reg.url, `${LOCAL}/oauth/register`);
    assert.deepEqual(reg.body.redirect_uris, ["http://127.0.0.1/callback"]);
    assert.ok(reg.body.grant_types.includes(DEVICE_GRANT));
    assert.equal(reg.body.token_endpoint_auth_method, "none");
    assert.match(reg.body.client_name, /GotchiBot/);
    const auth = h.calls.auth[0];
    assert.equal(auth.url, `${LOCAL}/oauth/device_authorization`);
    assert.equal(auth.form.client_id, "wsc_abc");
    assert.equal(auth.form.scope, "wondrstack");
  });

  it("server refusal is a structured failure", async () => {
    const h = setup(["ok"], { authError: "invalid_client" });
    const r = await deviceStart("gotchibot-local", { ...START, ...h.opts, stateDir: h.stateDir });
    assert.equal(r.status, "failed");
    assert.match(r.message, /invalid_client/);
    leak(r);
  });
});

describe("wait", () => {
  it("no pending request", async () => {
    const h = setup(["ok"]);
    const r = await deviceWait("gotchibot-local", { ...h.opts, stateDir: h.stateDir });
    assert.equal(r.kind, "no_pending");
  });

  it("pending, then linked across separate calls; tokens only to the store, with the local resource", async () => {
    const h = setup(["authorization_pending", "authorization_pending", "ok"]);
    await deviceStart("gotchibot-local", { ...START, ...h.opts, stateDir: h.stateDir });
    const a = await deviceWait("gotchibot-local", { ...h.opts, timeoutMs: 6000, stateDir: h.stateDir });
    assert.equal(a.status, "pending");
    assert.ok(a.expires_in > 0);
    const b = await deviceWait("gotchibot-local", { ...h.opts, timeoutMs: 30000, stateDir: h.stateDir });
    assert.equal(b.status, "linked");
    leak(a);
    leak(b);
    const creds = JSON.parse(h.saved.get(credKey("gotchibot-local")));
    assert.equal(creds.access_token, AT);
    assert.equal(creds.resource, `${LOCAL}/mcp`);
    assert.equal(creds.token_endpoint, `${LOCAL}/oauth/token`);
    assert.equal(existsSync(path.join(h.stateDir, PEND)), false);
    assert.equal(h.saved.has(credKey("gotchibot")), false, "must not touch the prod key");
    const s = await accessSession("gotchibot-local", { store: h.opts.store });
    assert.equal(s.resource, `${LOCAL}/mcp`);
  });

  for (const [step, kind] of [["access_denied", "denied"], ["expired_token", "expired"], ["invalid_grant", "error"]]) {
    it(`${step} -> failed ${kind}, pending cleared, nothing stored`, async () => {
      const h = setup([step]);
      await deviceStart("gotchibot-local", { ...START, ...h.opts, stateDir: h.stateDir });
      const r = await deviceWait("gotchibot-local", { ...h.opts, timeoutMs: 30000, stateDir: h.stateDir });
      assert.equal(r.status, "failed");
      assert.equal(r.kind, kind);
      assert.equal(h.saved.size, 0);
      assert.equal(existsSync(path.join(h.stateDir, PEND)), false);
      leak(r);
    });
  }

  it("local expiry", async () => {
    const h = setup(["authorization_pending"]);
    await deviceStart("gotchibot-local", { ...START, ...h.opts, stateDir: h.stateDir });
    await h.opts.sleep(700_000);
    const r = await deviceWait("gotchibot-local", { ...h.opts, stateDir: h.stateDir });
    assert.equal(r.kind, "expired");
  });

  it("slow_down persists the larger interval for the next call", async () => {
    const h = setup(["slow_down", "authorization_pending"]);
    await deviceStart("gotchibot-local", { ...START, ...h.opts, stateDir: h.stateDir });
    await deviceWait("gotchibot-local", { ...h.opts, timeoutMs: 6000, stateDir: h.stateDir });
    const st = JSON.parse(readFileSync(path.join(h.stateDir, PEND), "utf8"));
    assert.equal(st.interval_ms, 10000);
  });

  it("a network error is retryable and keeps the pending request", async () => {
    const h = setup(["ok"]);
    await deviceStart("gotchibot-local", { ...START, ...h.opts, stateDir: h.stateDir });
    const h2 = setup(["ok"], { netFail: true });
    const r = await deviceWait("gotchibot-local", { ...h.opts, fetchFn: h2.opts.fetchFn, timeoutMs: 30000, stateDir: h.stateDir });
    assert.equal(r.kind, "error");
    assert.equal(r.retryable, true);
    assert.equal(existsSync(path.join(h.stateDir, PEND)), true);
    leak(r);
  });
});

describe("agent surfaces", () => {
  it("defaults the project to gotchibot-local for a loopback base", () => {
    assert.equal(defaultLinkProject({ WONDRSTACK_DEVICE_BASE_URL: "http://localhost:3000" }), "gotchibot-local");
    assert.equal(defaultLinkProject({ WONDRSTACK_DEVICE_BASE_URL: "http://127.0.0.1:3001" }), "gotchibot-local");
    assert.equal(defaultLinkProject({}), "gotchibot");
    assert.equal(defaultLinkProject({ WONDRSTACK_DEVICE_BASE_URL: "https://wondrstack.xyz" }), "gotchibot");
  });

  it("MCP tool: start needs confirm_full_scope true, a bad project is refused", async () => {
    const seen = [];
    const lib = {
      defaultLinkProject: () => "gotchibot-local",
      deviceStart: async (p, o) => { seen.push(["start", p, o.confirmFullScope]); return { ok: true }; },
      deviceWait: async (p, o) => { seen.push(["wait", p, o.timeoutMs]); return { ok: true, status: "pending" }; },
    };
    await wondrstackLink("wondrstack_link_start", {}, lib);
    await wondrstackLink("wondrstack_link_start", { confirm_full_scope: "yes" }, lib);
    await wondrstackLink("wondrstack_link_start", { confirm_full_scope: true, project: "x" }, lib);
    await wondrstackLink("wondrstack_link_wait", { timeout_seconds: 999 }, lib);
    const bad = await wondrstackLink("wondrstack_link_start", { confirm_full_scope: true, project: "../etc" }, lib);
    assert.deepEqual(seen, [["start", "gotchibot-local", false], ["start", "gotchibot-local", false], ["start", "x", true], ["wait", "gotchibot-local", 55000]]);
    assert.equal(bad.status, "failed");
  });

  it("CLI --json without the confirm flag prints confirm_required and exits 2 (no TTY, no network)", () => {
    const r = spawnSync(process.execPath, ["scripts/wondrstack.mjs", "link", "--json", "--project", "gotchibot-local"], { cwd: root, encoding: "utf8", env: { ...process.env, WONDRSTACK_DEVICE_BASE_URL: LOCAL } });
    assert.equal(r.status, 2);
    const out = JSON.parse(r.stdout);
    assert.equal(out.kind, "confirm_required");
    assert.match(out.warning, /FULL/);
  });

  it("CLI --wait with nothing pending says no_pending", () => {
    const r = spawnSync(process.execPath, ["scripts/wondrstack.mjs", "link", "--wait", "--project", "nopending-test-x"], { cwd: root, encoding: "utf8", env: { ...process.env, WONDRSTACK_DEVICE_BASE_URL: LOCAL } });
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stdout).kind, "no_pending");
  });
});
