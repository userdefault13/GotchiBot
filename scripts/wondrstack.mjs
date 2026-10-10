#!/usr/bin/env node
/**
 * WondrStack from GotchiBot, deterministically: no model in the loop.
 *
 * One WondrStack account (one workspace) per GotchiBot project — the aarcadeghst
 * project signs in as the aarcadeghst account, gotchibot as the gotchibot one.
 * Each project has its own OAuth sign-in, kept in abra as WONDRSTACK_<PROJECT>
 * (client id + tokens, never printed).
 *
 *   gotchibot wondrstack login  <project>              browser sign-in for that project's account
 *   gotchibot wondrstack status <project>              get_status
 *   gotchibot wondrstack call   <project> <tool> [json]  any WondrStack MCP tool
 *   gotchibot wondrstack launch <project> [--name N] [--type T] [--template blank] [--hosting vercel]
 *                                          [--city C --state S --country X] [--workspace slug] [--wait]
 *   gotchibot wondrstack logout <project> [--hub]
 *
 * launch walks get_status's state machine and only ever does the next step:
 *   no workspace → create_business · repo failed/missing → start_provisioning ·
 *   repo building → wait · no hosting → the secure hosting link (you paste the
 *   Vercel token there; GotchiBot never sees it) · deploy failed → deploy_app ·
 *   deploying → wait · live → linked. Re-run it any time; it picks up where it is.
 * The project link (sessions/pstack/<project>/wondrstack.json) is written only
 * when get_status shows the expected workspace (default: the project's slug).
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { isMainModule } from "./is-main.mjs";
import { connectWondrStack } from "./pstack-wondrstack.mjs";
import { benchHeroes, loadRepo } from "./project-context.mjs";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const ENDPOINT = process.env.WONDRSTACK_MCP_URL || "https://wondrstack.xyz/mcp";
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const PROTOCOL = "2025-06-18";

// ---------- credentials (abra, one key per project) ----------

/** abra gets this long to answer before we call the vault locked. */
const ABRA_TIMEOUT_MS = Number(process.env.GOTCHIBOT_ABRA_TIMEOUT_MS) || 20_000;

export function credKey(project) {
  if (!SLUG.test(String(project || ""))) throw new Error(`invalid project slug: ${project}`);
  return `WONDRSTACK_${String(project).toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/** abra-backed store; tests pass an in-memory one. */
export const abraStore = {
  get(key) {
    // At a terminal abra may ask to approve the reveal: hand it the terminal and
    // wait. Unattended, a time limit: nobody will answer the prompt.
    const tty = Boolean(process.stdin.isTTY);
    const r = spawnSync("abra", ["get", "gotchibot", key], {
      encoding: "utf8",
      stdio: [tty ? "inherit" : "ignore", "pipe", tty ? "inherit" : "pipe"],
      timeout: tty ? 0 : ABRA_TIMEOUT_MS,
    });
    if (r.error?.code === "ETIMEDOUT" || r.signal) throw new Error("abra did not answer: the vault is locked (abra unlock) or the reveal is waiting for approval (abra grant)");
    if (r.status !== 0) {
      const err = String(r.stderr || "");
      if (/locked/i.test(err)) throw new Error("abra vault is locked — run: abra unlock");
      if (/approv|passphrase|denied/i.test(err)) throw new Error(`abra did not approve reading ${key}: run this from a terminal and answer its prompt, or abra grant`);
      if (tty) {
        // stderr went to the terminal: a missing key and a refused prompt look alike, so check the list.
        const ls = spawnSync("abra", ["ls", "gotchibot"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: ABRA_TIMEOUT_MS });
        if (new RegExp(`(^|\\s)${key}(\\s|$)`, "m").test(String(ls.stdout || "").replace(/\x1b\[[0-9;]*m/g, ""))) throw new Error(`abra did not approve reading ${key}`);
      }
      return null;
    }
    const v = String(r.stdout || "").trim();
    return v || null;
  },
  set(key, value) {
    const r = spawnSync("abra", ["set", "gotchibot", key, "--stdin"], {
      input: value,
      encoding: "utf8",
      stdio: ["pipe", "ignore", "pipe"],
      timeout: ABRA_TIMEOUT_MS,
    });
    if (r.error?.code === "ETIMEDOUT" || r.signal) throw new Error("abra did not answer: the vault is locked (abra unlock) or the reveal is waiting for approval (abra grant)");
    if (r.status !== 0) throw new Error(/locked/i.test(String(r.stderr)) ? "abra vault is locked — run: abra unlock" : "abra set failed");
  },
  /** Delete the key (abra refuses an empty value). false = it was not there. */
  remove(key) {
    const r = spawnSync("abra", ["rm", "gotchibot", key], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: ABRA_TIMEOUT_MS });
    if (r.error?.code === "ETIMEDOUT" || r.signal) throw new Error("abra did not answer: the vault is locked (abra unlock)");
    if (r.status === 0) return true;
    const err = String(r.stderr || "") + String(r.stdout || "");
    if (/locked/i.test(err)) throw new Error("abra vault is locked — run: abra unlock");
    if (/not found|no such|unknown|does not exist/i.test(err)) return false;
    throw new Error(`abra rm failed: ${err.replace(/\x1b\[[0-9;]*m/g, "").trim() || `exit ${r.status}`}`);
  },
};

function loadCreds(project, store) {
  const raw = store.get(credKey(project));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveCreds(project, creds, store) {
  store.set(credKey(project), JSON.stringify(creds));
}

// ---------- OAuth (RFC 9728 / 8414 / 7591, PKCE S256, public client) ----------

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

/** Authorization server metadata for an MCP endpoint. */
export async function discover(endpoint = ENDPOINT) {
  const u = new URL(endpoint);
  let issuer = u.origin;
  for (const path of [`/.well-known/oauth-protected-resource${u.pathname}`, "/.well-known/oauth-protected-resource"]) {
    try {
      const pr = await getJson(`${u.origin}${path}`);
      if (pr?.authorization_servers?.[0]) {
        issuer = pr.authorization_servers[0];
        break;
      }
    } catch {
      /* try the next */
    }
  }
  const as = await getJson(`${issuer.replace(/\/$/, "")}/.well-known/oauth-authorization-server`);
  return { ...as, resource: endpoint.replace(/\/$/, "") };
}

async function postForm(url, fields) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(20000),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`token: ${body.error_description || body.error || `HTTP ${r.status}`}`);
  return body;
}

function tokenSet(t, prev = {}) {
  return {
    ...prev,
    access_token: t.access_token,
    refresh_token: t.refresh_token || prev.refresh_token,
    expires_at: Date.now() + Math.max(60, Number(t.expires_in) || 3600) * 1000,
  };
}

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawnSync(cmd, args, { stdio: "ignore" });
}

function oauthCallbackPage(success) {
  const title = success ? "You're connected." : "We couldn't connect.";
  const summary = success
    ? "GotchiBot is signed in to WondrStack."
    : "The WondrStack sign-in wasn't completed.";
  const instruction = success
    ? "Return to GotchiBot to continue setting up this project. You can close this tab."
    : "Return to GotchiBot and try signing in again.";
  const status = success ? "Connection complete" : "Sign-in needs another try";
  const mark = success ? "✓" : "!";
  const brandMark = `<svg class="brand-mark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 24" shape-rendering="crispEdges" aria-hidden="true"><g fill="#7aa9ff"><path d="M2 9h2v1H2zM18 9h2v1h-2zM4 10h2v1H4zM16 10h2v1h-2zM6 11h2v1H6zM14 11h2v1h-2zM8 12h2v1H8zM12 12h2v1h-2zM10 13h2v1h-2z"/></g><g fill="#3b81ff"><path d="M2 12h2v1H2zM18 12h2v1h-2zM4 13h2v1H4zM16 13h2v1h-2zM6 14h2v1H6zM14 14h2v1h-2zM8 15h2v1H8zM12 15h2v1h-2zM10 16h2v1h-2z"/></g><g fill="#5283db"><path d="M2 15h2v1H2zM18 15h2v1h-2zM4 16h2v1H4zM16 16h2v1h-2zM6 17h2v1H6zM14 17h2v1h-2zM8 18h2v1H8zM12 18h2v1h-2zM10 19h2v1h-2z"/></g><g fill="#fff"><path d="M8 7h1v2H8zM12 7h1v2h-1zM10 8h1v1h-1zM9 9h1v1H9zM11 9h1v1h-1z"/></g><g fill="#9dc0ff"><path d="M9 4h4v1H9zM7 5h2v1H7zM13 5h2v1h-2zM5 6h2v1H5zM15 6h2v1h-2zM3 7h2v1H3zM17 7h2v1h-2zM2 8h1v1H2zM19 8h1v1h-1z"/></g></svg>`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <title>${title} · WondrStack</title>
    <style>
      :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #292a36; background: #f7f8fc; }
      * { box-sizing: border-box; }
      body { min-height: 100vh; min-height: 100svh; margin: 0; padding: 28px; display: grid; place-items: center; background: radial-gradient(ellipse at 50% 0%, #e8edff 0, #f7f8fc 58%); }
      main { width: min(100%, 560px); padding: clamp(28px, 7vw, 48px); border: 1px solid #e5e8f1; border-radius: 28px; background: rgba(255,255,255,.94); box-shadow: 0 28px 80px -48px rgba(39,54,105,.38); }
      .brand { display: flex; align-items: center; gap: 13px; color: #234e9b; font-family: "Bitcount Single", ui-monospace, monospace; font-size: 17px; font-weight: 600; letter-spacing: .02em; }
      .brand-mark { display: block; width: 38px; height: 42px; flex: none; }
      .status { display: grid; width: 54px; height: 54px; margin-top: 42px; place-items: center; border-radius: 18px; background: ${success ? "#eaf1ff" : "#fff2e9"}; color: ${success ? "#356ee0" : "#b45332"}; font-size: 29px; font-weight: 600; }
      .eyebrow { margin: 23px 0 0; color: ${success ? "#356ee0" : "#a54b32"}; font-size: 11px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; }
      h1 { margin: 8px 0 0; font-family: Georgia, "Times New Roman", serif; font-size: clamp(34px, 8vw, 46px); font-weight: 500; letter-spacing: -.045em; line-height: 1.12; }
      .summary { margin: 18px 0 0; color: #46495a; font-size: 17px; line-height: 1.6; }
      .instruction { margin: 11px 0 0; color: #737789; font-size: 14px; line-height: 1.7; }
      .rule { height: 1px; margin: 30px 0 17px; background: #eceef4; }
      .foot { margin: 0; color: #9296a5; font-size: 12px; letter-spacing: .03em; }
      @media (max-width: 480px) { body { padding: 16px; } main { border-radius: 23px; } .status { margin-top: 34px; } }
    </style>
  </head>
  <body>
    <main>
      <div class="brand">${brandMark}<span>wondrstack</span></div>
      <div class="status" aria-hidden="true">${mark}</div>
      <p class="eyebrow">${status}</p>
      <h1>${title}</h1>
      <p class="summary">${summary}</p>
      <p class="instruction">${instruction}</p>
      <div class="rule" aria-hidden="true"></div>
      <p class="foot">GotchiBot · WondrStack sign-in</p>
    </main>
  </body>
</html>`;
}

/**
 * Browser sign-in for one project's WondrStack account. A loopback callback on
 * 127.0.0.1 (any port) receives the code; tokens go to the store.
 */
export async function login(project, { endpoint = ENDPOINT, store = abraStore, open = openBrowser, log = console.log, timeoutMs = 300_000, port = 0 } = {}) {
  credKey(project);
  const meta = await discover(endpoint);
  const reg = await fetch(meta.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: `GotchiBot (${project})`,
      redirect_uris: ["http://127.0.0.1/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    }),
    signal: AbortSignal.timeout(15000),
  }).then(async (r) => {
    const b = await r.json().catch(() => ({}));
    if (!r.ok || !b.client_id) throw new Error(`register: ${b.error_description || b.error || `HTTP ${r.status}`}`);
    return b;
  });
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");

  const { code, redirectUri } = await new Promise((resolveCode, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const ok = u.searchParams.get("state") === state && u.searchParams.get("code");
      res.writeHead(ok ? 200 : 400, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
      });
      res.end(oauthCallbackPage(Boolean(ok)));
      // The port before close(): address() is null once the server is closed.
      const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
      clearTimeout(timer);
      server.close();
      if (ok) resolveCode({ code: u.searchParams.get("code"), redirectUri });
      else reject(new Error(u.searchParams.get("error_description") || u.searchParams.get("error") || "sign-in failed"));
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("sign-in timed out"));
    }, timeoutMs);
    server.listen(Number(port) || 0, "127.0.0.1", () => {
      const redirect = `http://127.0.0.1:${server.address().port}/callback`;
      const url = new URL(meta.authorization_endpoint);
      for (const [k, v] of Object.entries({
        response_type: "code",
        client_id: reg.client_id,
        redirect_uri: redirect,
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: (meta.scopes_supported || ["wondrstack"]).join(" "),
        state,
        resource: meta.resource,
      })) url.searchParams.set(k, v);
      log(`Sign in to the WondrStack account for project ${project} in your browser:\n  ${url}`);
      if (open) open(url.toString());
    });
  });

  const t = await postForm(meta.token_endpoint, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: reg.client_id,
    code_verifier: verifier,
    resource: meta.resource,
  });
  saveCreds(project, tokenSet(t, { client_id: reg.client_id, token_endpoint: meta.token_endpoint, resource: meta.resource }), store);
  return { ok: true };
}

/** A live access token for the project, refreshing (and storing the rotated token) when due. */
export async function accessToken(project, { store = abraStore } = {}) {
  const creds = loadCreds(project, store);
  if (!creds?.access_token) throw new Error(`no WondrStack sign-in for ${project} — run: gotchibot wondrstack login ${project}`);
  if (creds.expires_at && creds.expires_at > Date.now() + 60_000) return creds.access_token;
  if (!creds.refresh_token) throw new Error(`WondrStack sign-in for ${project} expired — run: gotchibot wondrstack login ${project}`);
  const t = await postForm(creds.token_endpoint, {
    grant_type: "refresh_token",
    refresh_token: creds.refresh_token,
    client_id: creds.client_id,
    resource: creds.resource,
  });
  saveCreds(project, tokenSet(t, creds), store);
  return t.access_token;
}

// ---------- MCP over streamable HTTP ----------

function parseRpc(text, id) {
  const t = String(text || "").trim();
  if (!t) return null;
  if (t.startsWith("{") || t.startsWith("[")) {
    const j = JSON.parse(t);
    return Array.isArray(j) ? j.find((m) => m.id === id) : j;
  }
  // text/event-stream: the response is a data: line carrying our id.
  for (const line of t.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const m = JSON.parse(line.slice(5).trim());
      if (m.id === id) return m;
    } catch {
      /* not JSON */
    }
  }
  return null;
}

async function rpc(endpoint, token, session, method, params, id) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL,
    authorization: `Bearer ${token}`,
  };
  if (session.id) headers["mcp-session-id"] = session.id;
  const body = id == null ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params };
  const r = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const sid = r.headers.get("mcp-session-id");
  if (sid) session.id = sid;
  if (r.status === 401) throw new Error("WondrStack rejected the sign-in (401) — run: gotchibot wondrstack login <project>");
  if (id == null) return null;
  const msg = parseRpc(await r.text(), id);
  if (!r.ok && !msg) throw new Error(`WondrStack MCP: HTTP ${r.status}`);
  if (msg?.error) throw new Error(`WondrStack MCP: ${msg.error.message || JSON.stringify(msg.error)}`);
  return msg?.result;
}

/** Call one WondrStack tool for a project; returns its parsed JSON result. */
export async function callTool(project, tool, args = {}, { endpoint = ENDPOINT, store = abraStore } = {}) {
  const token = await accessToken(project, { store });
  const session = {};
  await rpc(endpoint, token, session, "initialize", {
    protocolVersion: PROTOCOL,
    capabilities: {},
    clientInfo: { name: "gotchibot", version: "1" },
  }, 1);
  await rpc(endpoint, token, session, "notifications/initialized", {}, null);
  const result = await rpc(endpoint, token, session, "tools/call", { name: tool, arguments: args }, 2);
  const text = (result?.content || []).find((c) => c?.type === "text")?.text;
  let data = text;
  try {
    data = text != null ? JSON.parse(text) : result;
  } catch {
    /* plain text result */
  }
  if (result?.isError) {
    const why = typeof data === "string" ? data : data?.error || data?.message || JSON.stringify(data);
    throw new Error(`${tool}: ${why}`);
  }
  return data;
}

// ---------- setup keys from the vault (abra) ----------
//
// A project's app keys live in its repo-named abra namespace (AarcadeGh-t,
// GotchiBot, WondrStack), separate from the desk's own `gotchibot` secrets.
// They are read inside this script and sent straight to WondrStack over TLS
// with the project's sign-in: never printed, logged, or shown to a model.

/** Setup kinds → WondrStack's body fields ← abra key names (first that exists wins). */
export const KEY_MAP = {
  hosting: { provider: "vercel", fields: { token: ["VERCEL_TOKEN"], accountId: ["VERCEL_TEAM_ID", "VERCEL_ORG_ID"] }, required: ["token"] },
  database: { fields: { uri: ["MONGODB_URI"], dbName: ["MONGODB_DB_NAME", "MONGO_DB_NAME", "MONGODB_DATABASE"] }, required: ["uri"] },
  payments: { fields: { secretKey: ["STRIPE_SECRET_KEY"], publishableKey: ["STRIPE_PUBLISHABLE_KEY", "NUXT_PUBLIC_STRIPE_PUBLISHABLE_KEY"] }, required: ["secretKey"] },
  google_signin: { fields: { clientId: ["GOOGLE_CLIENT_ID"], clientSecret: ["GOOGLE_CLIENT_SECRET"] }, required: ["clientId", "clientSecret"] },
};

/** The abra namespace for a project: its linked repo's name (gotchibot → GotchiBot). */
export function keyNamespace(project, { loadRepoFn = loadRepo } = {}) {
  const repo = loadRepoFn(project);
  const name = repo?.name || String(repo?.remote || "").split("/").pop()?.replace(/\.git$/, "");
  if (!name) throw new Error(`${project} has no linked repo, so no abra namespace — link one, or pass --namespace`);
  return name;
}

/** abra get <namespace> <key>, or null when it is not there. Value stays in memory only. */
export function abraValue(namespace, key) {
  const r = spawnSync("abra", ["get", namespace, key], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: ABRA_TIMEOUT_MS });
  if (r.error?.code === "ETIMEDOUT" || r.signal) throw new Error("abra did not answer: the vault is locked (abra unlock) or the reveal is waiting for approval (abra grant)");
  if (r.status !== 0) {
    if (/locked/i.test(String(r.stderr || ""))) throw new Error("abra vault is locked — run: abra unlock");
    return null;
  }
  return String(r.stdout || "").trim() || null;
}

/**
 * The body for one setup kind from the vault: { body, found: [key names], missing: [field names] }.
 * Only key names leave this function's report — values go into `body`, which is sent, never shown.
 */
export function bodyFromVault(kind, namespace, { get = abraValue } = {}) {
  const spec = KEY_MAP[kind];
  if (!spec) throw new Error(`unknown setup kind: ${kind}`);
  const body = spec.provider ? { provider: spec.provider } : {};
  const found = [];
  for (const [field, names] of Object.entries(spec.fields)) {
    for (const name of names) {
      const v = get(namespace, name);
      if (v) {
        body[field] = v;
        found.push(name);
        break;
      }
    }
  }
  const missing = spec.required.filter((f) => !body[f]);
  return { body, found, missing };
}

/** POST the body to WondrStack's agent setup endpoint with the project's sign-in. Never echoes secrets. */
export async function pushSetup(project, kind, body, { endpoint = ENDPOINT, store = abraStore } = {}) {
  const token = await accessToken(project, { store });
  const url = `${new URL(endpoint).origin}/api/agent/setup/${kind}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const res = await r.json().catch(() => ({}));
  if (r.status === 404) return { ok: false, unsupported: true, error: "WondrStack has no agent setup endpoint yet (plan gap #7)" };
  if (!r.ok) return { ok: false, error: res.statusMessage || res.message || res.error || `HTTP ${r.status}` };
  return { ok: true, ...(res.provider ? { provider: res.provider } : {}), ...(res.account ? { account: res.account } : {}) };
}

/** Push every requested kind whose keys are in the vault. Reports key names only. */
export async function pushKeys(project, kinds, opts = {}) {
  const log = opts.log || console.log;
  const namespace = opts.namespace || keyNamespace(project, opts);
  const out = [];
  for (const kind of kinds) {
    const { body, found, missing } = bodyFromVault(kind, namespace, opts);
    if (missing.length) {
      log(`· ${kind}: not in abra ${namespace} (needs ${missing.map((f) => KEY_MAP[kind].fields[f][0]).join(", ")}) — skipped`);
      out.push({ kind, skipped: true, missing });
      continue;
    }
    if (opts.dryRun) {
      log(`· ${kind}: would send ${found.join(", ")} from abra ${namespace}`);
      out.push({ kind, dryRun: true, found });
      continue;
    }
    const r = await (opts.push || pushSetup)(project, kind, body, opts);
    log(r.ok ? `✓ ${kind}: sent ${found.join(", ")} from abra ${namespace}${r.account ? ` · ${r.account}` : ""}` : `✗ ${kind}: ${r.error}`);
    out.push({ kind, ...r, found });
  }
  return out;
}

// ---------- Site Ops: watch, schedule, Hub sign-in ----------

/** GET the app URL (follows redirects): { url, ok, status, ms } or { url, ok: false, error }. */
export async function siteCheck(url, { fetchFn = fetch, timeoutMs = 10_000 } = {}) {
  if (!/^https?:\/\//i.test(String(url || ""))) return null;
  const t0 = Date.now();
  try {
    const r = await fetchFn(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "gotchibot-site-ops" } });
    return { url, ok: r.status < 400, status: r.status, ms: Date.now() - t0 };
  } catch (e) {
    return { url, ok: false, error: String(e?.cause?.code || e?.name || e?.message || e) };
  }
}

/** The conditions Site Ops alerts on, from get_status + the site check (pure). */
export function siteConditions(status, site) {
  const ws = status?.workspace;
  const out = {};
  if (!ws) return out;
  if (ws.provisioning === "failed") out.repo_failed = "creating the code repository failed";
  if (ws.hosting?.status === "failed") out.deploy_failed = `the deploy failed: ${ws.hosting.error || "see the build log"}`;
  if (!ws.hosting && ws.provisioning === "repo_created") out.no_hosting = "no host is connected yet";
  if (site && !site.ok) out.site_down = `${site.url} is not answering (${site.status || site.error})`;
  return out;
}

const DAY = 24 * 3600_000;

function watchStatePath(root, project) {
  return join(root, "sessions", "pstack", project, "site-ops.json");
}

/**
 * One Site Ops pass for a project: status + site check, alerts the project's PM
 * on new problems (and once when they clear), and, when the Site Ops worker is
 * trusted, redeploys a failed deploy once per failure. Returns a summary.
 */
export async function watchProject(project, opts = {}) {
  const root = opts.root || ROOT;
  const now = opts.now || Date.now();
  const call = opts.call || ((tool, args) => callTool(project, tool, args, opts));
  const send = opts.send || sendAlert;
  const statePath = watchStatePath(root, project);
  let state = {};
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    state = {};
  }
  state.conditions ||= {};
  const status = await call("get_status", {});
  const site = await (opts.siteCheck || siteCheck)(status?.workspace?.app_url);
  const found = siteConditions(status, site);
  const notes = [];

  // One automatic redeploy per failure, only for a trusted Site Ops worker.
  if (found.deploy_failed && opts.trusted) {
    const failure = `${status.workspace.hosting?.error || ""}`;
    if (state.autoRedeploy?.failure !== failure) {
      await call("deploy_app", {});
      state.autoRedeploy = { failure, at: new Date(now).toISOString() };
      notes.push("redeployed once automatically");
    }
  }

  const alerts = [];
  for (const [key, why] of Object.entries(found)) {
    const c = (state.conditions[key] ||= { since: new Date(now).toISOString() });
    // No hosting is only a problem once it has lasted a day.
    if (key === "no_hosting" && now - Date.parse(c.since) < DAY) continue;
    if (!c.alertedAt) {
      c.alertedAt = new Date(now).toISOString();
      alerts.push(why);
    }
  }
  const cleared = [];
  for (const key of Object.keys(state.conditions)) {
    if (found[key]) continue;
    if (state.conditions[key].alertedAt) cleared.push(key.replace(/_/g, " "));
    delete state.conditions[key];
  }

  const ws = status?.workspace;
  const where = ws?.app_url || ws?.slug || project;
  if (alerts.length) {
    await send({
      project,
      from: opts.from,
      subject: `Site Ops · ${project}: ${alerts[0]}`,
      body: [
        `WondrStack app for ${project} (${where}) needs attention:`,
        ...alerts.map((a) => `- ${a}`),
        ...notes.map((n) => `- ${n}`),
        `Next step: ./scripts/gotchibot wondrstack status ${project}, then launch, keys or a redeploy as it says.`,
      ].join("\n"),
    });
  }
  if (cleared.length) {
    await send({ project, from: opts.from, subject: `Site Ops · ${project}: back to normal`, body: `Cleared: ${cleared.join(", ")} (${where}).` });
  }
  mkdirSync(dirname(statePath), { recursive: true });
  state.lastCheck = { at: new Date(now).toISOString(), site, provisioning: ws?.provisioning || null, hosting: ws?.hosting?.status || null };
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return { project, problems: Object.keys(found), alerted: alerts, cleared, notes, site };
}

/** Alert the project's PM in its bot inbox; no PM seated → the orchestrator. */
async function sendAlert({ project, from, subject, body }) {
  const { sendMessage } = await import("./bot-inbox.mjs");
  for (const to of ["project-manager", "orch"]) {
    try {
      sendMessage({ to, from: from || "orch", kind: "alert", subject, body, project });
      return to;
    } catch {
      /* no PM here → orchestrator */
    }
  }
  return null;
}

/** Projects with a Site Ops hero worked by a gotchi: [{ project, worker }]. */
export function siteOpsSeats({ root = ROOT } = {}) {
  const dir = join(root, "sessions", "pstack");
  let slugs = [];
  try {
    slugs = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const out = [];
  for (const slug of slugs) {
    try {
      const seat = benchHeroes(slug).find((h) => h.hero === "site-ops" && h.worker);
      if (seat) out.push({ project: slug, worker: seat.worker });
    } catch {
      /* not a workbench */
    }
  }
  return out;
}

async function watchAll(opts = {}) {
  const { heroTrust } = await import("./hire-sheet.mjs");
  const seats = siteOpsSeats(opts);
  if (!seats.length) return console.log("no Site Ops seated in any project");
  for (const { project, worker } of seats) {
    try {
      const r = await watchProject(project, { ...opts, from: worker, trusted: heroTrust(worker) === "trusted" });
      console.log(`${project}: ${r.problems.length ? r.problems.join(", ") : "ok"}${r.alerted.length ? " · PM alerted" : ""}${r.cleared.length ? ` · cleared ${r.cleared.join(", ")}` : ""}${r.notes.length ? ` · ${r.notes.join(", ")}` : ""}`);
    } catch (e) {
      console.log(`${project}: check failed: ${e.message || e}`);
    }
  }
}

const UNIT = "gotchibot-site-ops";

/** Hourly `wondrstack watch --all`: a systemd user timer on Linux (the Hub). */
export function scheduleSiteOps(action, { intervalSec = 3600 } = {}) {
  const node = process.execPath;
  const script = join(ROOT, "scripts", "wondrstack.mjs");
  if (process.platform === "linux") {
    const dir = join(homedir(), ".config", "systemd", "user");
    const svc = join(dir, `${UNIT}.service`);
    const tmr = join(dir, `${UNIT}.timer`);
    const sys = (...a) => spawnSync("systemctl", ["--user", ...a], { encoding: "utf8" });
    if (action === "install") {
      mkdirSync(dir, { recursive: true });
      writeFileSync(svc, `[Unit]\nDescription=GotchiBot Site Ops (WondrStack watch)\n\n[Service]\nType=oneshot\nWorkingDirectory=${ROOT}\nEnvironment=PATH=${process.env.PATH}\nExecStart=${node} ${script} watch --all\n`);
      writeFileSync(tmr, `[Unit]\nDescription=GotchiBot Site Ops every ${intervalSec}s\n\n[Timer]\nOnBootSec=300\nOnUnitActiveSec=${intervalSec}\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`);
      sys("daemon-reload");
      const r = sys("enable", "--now", `${UNIT}.timer`);
      return { ok: r.status === 0, how: "systemd", message: r.status === 0 ? `installed ${UNIT}.timer (every ${intervalSec}s)` : r.stderr };
    }
    if (action === "uninstall") {
      sys("disable", "--now", `${UNIT}.timer`);
      return { ok: true, how: "systemd", message: `stopped ${UNIT}.timer` };
    }
    const r = sys("list-timers", `${UNIT}.timer`, "--no-pager");
    return { ok: true, how: "systemd", message: existsSync(tmr) ? String(r.stdout || "").trim() || "installed" : "not installed" };
  }
  return { ok: false, how: process.platform, message: "Site Ops runs on the Hub: run this there (systemd). On a Mac desk use: gotchibot wondrstack watch --all" };
}

/** This desk's ssh target for the Hub (sessions/.hub-desk.json or GOTCHIBOT_HUB_SSH). */
function hubSshTarget() {
  const env = String(process.env.GOTCHIBOT_HUB_SSH || "").trim();
  if (env) return env;
  try {
    return String(JSON.parse(readFileSync(join(ROOT, "sessions", ".hub-desk.json"), "utf8"))?.ssh || "").trim();
  } catch {
    return "";
  }
}

/**
 * Sign a project in on the Hub from this desk: the Hub runs the sign-in on a
 * fixed loopback port, ssh forwards that port here, and the browser opens here.
 * The tokens are stored in the Hub's abra.
 */
/** Run one `gotchibot …` command on the Hub over ssh, output here. */
export function onHub(args, { target = hubSshTarget() } = {}) {
  if (!target) throw new Error("no Hub ssh target: pair this desk with the Hub first (gotchibot hub setup)");
  const remote = `cd ~/dev/GotchiBot 2>/dev/null || cd ~/Dev/GotchiBot; export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"; ./scripts/gotchibot ${args}`;
  const r = spawnSync("ssh", ["-t", target, remote], { stdio: "inherit" });
  if (r.status !== 0) process.exitCode = r.status || 1;
}

export async function loginOnHub(project, { target = hubSshTarget(), log = console.log } = {}) {
  if (!target) throw new Error("no Hub ssh target: pair this desk with the Hub first (gotchibot hub setup)");
  credKey(project);
  const port = 49152 + Math.floor(Math.random() * 10000);
  const remote = `cd ~/dev/GotchiBot 2>/dev/null || cd ~/Dev/GotchiBot; export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"; ./scripts/gotchibot wondrstack login ${project} --port ${port} --no-open`;
  const child = spawn("ssh", ["-tt", "-o", "ExitOnForwardFailure=yes", "-L", `${port}:127.0.0.1:${port}`, target, remote], { stdio: ["inherit", "pipe", "inherit"] });
  let opened = false;
  child.stdout.on("data", (buf) => {
    const text = String(buf);
    process.stdout.write(text);
    const m = text.match(/https:\/\/\S+\/oauth\/authorize\S+/);
    if (m && !opened) {
      opened = true;
      openBrowser(m[0]);
    }
  });
  const code = await new Promise((r) => child.on("close", r));
  if (code !== 0) throw new Error(`sign-in on the Hub failed (exit ${code}): abra on the Hub must be unlocked, and the token read approved (run this from your own terminal to answer the prompt)`);
  log(`signed ${project} in on the Hub`);
}

// ---------- launch: the deterministic pipeline ----------

/**
 * One account per project: the sign-in's workspace must be the project's own.
 * Returns the problem sentence, or null (no workspace yet counts as fine).
 */
export function workspaceMismatch(project, status, expected = project) {
  const slug = status?.workspace?.slug;
  if (!slug || slug === expected) return null;
  return (
    `this ${project} sign-in is WondrStack workspace "${slug}", not "${expected}" — one account per project: ` +
    `sign out of wondrstack.xyz in the browser (or use a private window), ` +
    `then gotchibot wondrstack login ${project} with the ${expected} account (or pass --workspace ${slug})`
  );
}

/**
 * The one next step for a get_status result (pure):
 * { step: create|provision|wait|hosting|redeploy|live, why }.
 */
export function nextStep(status) {
  const ws = status?.workspace;
  if (!ws) return { step: "create", why: "no WondrStack workspace on this account yet" };
  const p = ws.provisioning;
  if (p === "adopted_existing_app") return { step: "live", why: "existing app adopted; it stays on its own host" };
  if (!p || p === "failed" || p === "not_configured") return { step: "provision", why: `code repository ${p || "not started"}` };
  if (p === "queued" || p === "running") return { step: "wait", why: "the code repository is being created" };
  const h = ws.hosting;
  if (!h) return { step: "hosting", why: "no host connected — paste the Vercel token on WondrStack's secure page" };
  if (h.status === "failed") return { step: "redeploy", why: `deploy failed: ${h.error || "see the build log"}` };
  if (["connected", "queued", "deploying"].includes(h.status)) return { step: "wait", why: `deploy ${h.status}` };
  if (h.status === "live" || h.status === "bundle_ready") return { step: "live", why: ws.app_url ? `live at ${ws.app_url}` : `hosting ${h.status}` };
  return { step: "wait", why: `hosting ${h.status}` };
}

/**
 * Walk the pipeline for one project. Returns { step, why, status, link? }:
 * step "live" = done and linked; "hosting" = waiting on you (opened link);
 * "wait" = WondrStack is working (re-run, or pass wait: true).
 */
export async function launch(project, opts = {}) {
  const call = opts.call || ((tool, args) => callTool(project, tool, args, opts));
  const log = opts.log || console.log;
  const expected = opts.workspace || project;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (opts.waitMs ?? 600_000);
  let redeployed = false;
  let createdOnce = false;
  for (;;) {
    const status = await call("get_status", {});
    const wrong = workspaceMismatch(project, status, expected);
    if (wrong) throw new Error(wrong);
    const next = nextStep(status);
    log(`· ${next.step}: ${next.why}`);
    if (next.step === "create") {
      if (createdOnce) throw new Error("create_business did not produce a workspace");
      for (const k of ["city", "state", "country"]) {
        if (!opts[k]) throw new Error(`creating the workspace needs --city, --state and --country (missing --${k})`);
      }
      const r = await call("create_business", {
        business_name: opts.name || project,
        business_type: opts.type || "Other",
        template: opts.template || "blank",
        preferred_hosting: opts.hosting || "vercel",
        city: opts.city,
        state: opts.state,
        country: opts.country,
        ...(opts.timezone ? { timezone: opts.timezone } : {}),
      });
      createdOnce = true;
      log(`  created ${r?.workspace?.slug || expected} (template ${r?.template || opts.template || "blank"})`);
      continue;
    }
    if (next.step === "provision") {
      await call("start_provisioning", {});
      log("  started the code repository");
      if (!opts.wait) return { step: "wait", why: "code repository started", status };
      await sleep(10_000);
      continue;
    }
    if (next.step === "redeploy") {
      if (redeployed) return { ...next, status };
      await call("deploy_app", {});
      redeployed = true;
      log("  redeploying");
      if (!opts.wait) return { step: "wait", why: "redeploy started", status };
      await sleep(15_000);
      continue;
    }
    if (next.step === "hosting") {
      // The Vercel token from the project's abra namespace, when it is there and
      // WondrStack takes it; else the secure page as before.
      if (!opts.noVault && !opts.vaultTried) {
        opts.vaultTried = true;
        try {
          const [r] = await pushKeys(project, ["hosting"], { ...opts, log });
          if (r?.ok) {
            if (!opts.wait) return { step: "wait", why: "Vercel token sent from abra; deploying", status };
            await sleep(15_000);
            continue;
          }
        } catch (e) {
          log(`  vault: ${e.message || e}`);
        }
      }
      const url = status?.links?.hosting || (await call("get_setup_link", { step: "hosting" }))?.url;
      log(`  connect hosting here (you paste the Vercel token; GotchiBot never sees it):\n  ${url}`);
      if (opts.openLink !== false && url) (opts.open || openBrowser)(url);
      return { ...next, status, url };
    }
    if (next.step === "live") {
      const link = connectWondrStack({ project, status, expectedWorkspace: expected, ...(opts.root ? { root: opts.root } : {}) });
      log(`  linked ${project} → WondrStack ${link.workspace}${link.appUrl ? ` · app ${link.appUrl}` : ""}${link.repoUrl ? ` · repo ${link.repoUrl}` : ""}`);
      return { ...next, status, link };
    }
    // wait
    if (!opts.wait || Date.now() > deadline) return { ...next, status };
    await sleep(10_000);
  }
}

// ---------- CLI ----------

function flag(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function usage() {
  console.log(`gotchibot wondrstack login  <project>
gotchibot wondrstack status <project>
gotchibot wondrstack call   <project> <tool> [json-args]
gotchibot wondrstack launch <project> [--name N] [--type T] [--template blank] [--hosting vercel]
                                     [--city C --state S --country X] [--workspace slug] [--wait]
gotchibot wondrstack keys   <project> [--hosting] [--database] [--payments] [--google] [--all] [--namespace N] [--dry-run]
gotchibot wondrstack logout <project> [--hub]
gotchibot wondrstack login  <project> --hub          sign a project in on the Hub (browser here, tokens in the Hub's abra)
gotchibot wondrstack watch  <project>|--all           Site Ops pass: status + site check, PM alerts, one auto-redeploy when trusted
gotchibot wondrstack schedule install|uninstall|status [--interval 3600]   hourly watch on the Hub (systemd timer)

One WondrStack account per project; each project signs in on its own (abra key WONDRSTACK_<PROJECT>).
App keys come from the project's repo-named abra namespace (gotchibot → GotchiBot, aarcadeghst → AarcadeGh-t):
VERCEL_TOKEN, MONGODB_URI, STRIPE_SECRET_KEY + STRIPE_PUBLISHABLE_KEY, GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET.`);
}

async function main() {
  const [cmd, project, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help") return usage();
  if (!project) throw new Error(cmd === "schedule" ? "say install, uninstall or status" : "project slug required");
  if (cmd === "watch") {
    if (project === "--all") return watchAll();
    const r = await watchProject(project);
    console.log(`${project}: ${r.problems.length ? r.problems.join(", ") : "ok"}${r.alerted.length ? " · PM alerted" : ""}`);
    return;
  }
  if (cmd === "schedule") {
    const r = scheduleSiteOps(project, { intervalSec: Number(flag(rest, "interval")) || 3600 });
    console.log(r.message);
    if (!r.ok) process.exitCode = 1;
    return;
  }
  if (cmd === "login") {
    if (rest.includes("--hub")) return loginOnHub(project);
    await login(project, { port: Number(flag(rest, "port")) || 0, open: rest.includes("--no-open") ? null : openBrowser });
    const s = await callTool(project, "get_status", {});
    console.log(`signed in · workspace ${s?.workspace?.slug || "(none yet — run launch)"}`);
    const wrong = workspaceMismatch(project, s);
    if (wrong) {
      console.log(`WARNING: ${wrong}`);
      process.exitCode = 2;
    }
    return;
  }
  if (cmd === "status") {
    const s = await callTool(project, "get_status", {});
    console.log(JSON.stringify(s, null, 2));
    console.log(`next: ${nextStep(s).step} — ${nextStep(s).why}`);
    const wrong = workspaceMismatch(project, s, flag(rest, "workspace") || project);
    if (wrong) {
      console.log(`WARNING: ${wrong}`);
      process.exitCode = 2;
    }
    const site = await siteCheck(s?.workspace?.app_url);
    if (site) console.log(`site: ${site.url} ${site.ok ? `up (${site.status}, ${site.ms} ms)` : `DOWN (${site.status || site.error})`}`);
    return;
  }
  if (cmd === "call") {
    const [tool, json] = rest;
    if (!tool) throw new Error("tool name required");
    console.log(JSON.stringify(await callTool(project, tool, json ? JSON.parse(json) : {}), null, 2));
    return;
  }
  if (cmd === "launch") {
    const r = await launch(project, {
      name: flag(rest, "name"),
      type: flag(rest, "type"),
      template: flag(rest, "template"),
      hosting: flag(rest, "hosting"),
      city: flag(rest, "city"),
      state: flag(rest, "state"),
      country: flag(rest, "country"),
      timezone: flag(rest, "timezone"),
      workspace: flag(rest, "workspace"),
      wait: rest.includes("--wait"),
    });
    console.log(`launch: ${r.step} — ${r.why}`);
    if (r.step !== "live") process.exitCode = r.step === "hosting" ? 3 : 4;
    return;
  }
  if (cmd === "keys") {
    const all = rest.includes("--all");
    const kinds = all
      ? Object.keys(KEY_MAP)
      : Object.keys(KEY_MAP).filter((k) => rest.includes(`--${k}`) || (k === "google_signin" && rest.includes("--google")));
    if (!kinds.length) throw new Error("say what to send: --hosting --database --payments --google, or --all");
    const dryRun = rest.includes("--dry-run");
    if (!dryRun) {
      // Never send this project's keys into another project's workspace.
      const wrong = workspaceMismatch(project, await callTool(project, "get_status", {}), flag(rest, "workspace") || project);
      if (wrong) throw new Error(wrong);
    }
    const r = await pushKeys(project, kinds, { namespace: flag(rest, "namespace"), dryRun });
    if (r.some((x) => x.ok === false)) process.exitCode = 1;
    return;
  }
  if (cmd === "logout") {
    if (rest.includes("--hub")) return onHub(`wondrstack logout ${project}`);
    const had = abraStore.remove(credKey(project));
    console.log(had ? `signed out of WondrStack for ${project}` : `no WondrStack sign-in for ${project} here (on the Hub? add --hub)`);
    return;
  }
  throw new Error(`unknown command: ${cmd}`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`wondrstack: ${e.message || e}`);
    process.exitCode = 1;
  });
}
