/**
 * gotchibot-api — self-hosted Hub chat/desk HTTP API (node:http, no express).
 */
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../../scripts/is-main.mjs";
import { isUlid } from "../../scripts/chat-canonical.mjs";
import { resolveApiConfig } from "./config.mjs";
import { checkOrigin, forwardedTailscaleIp, taggedPeerAllowed } from "./auth.mjs";
import { connectStore } from "./store.mjs";
import { createProjectSource, materializeSnapshotFiles, projectSlugOk, projectSyncPathOk, validateProjectSnapshot } from "./projects.mjs";
import { validateCockpitSnapshot } from "./cockpit.mjs";
import { validateTreeSnapshot } from "./tree.mjs";
import {
  adoptDeskSessionFromTerminal,
  createOpencodeClient,
  deskThreadTitle,
  ensureDeskSession,
  listProjectSessions,
  phoneCommands,
  startNewDeskSession,
} from "./desk-runner.mjs";
import {
  createCastVerifier,
  isAddress,
  isSignature,
  resolveOwnerWallet,
  walletLoginMessage,
} from "./wallet.mjs";
import {
  resolveStaticPath,
  contentTypeFor,
  isNoCacheShellFile,
  STATIC_CSP,
  STATIC_PERMISSIONS_POLICY,
} from "./static.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "app");
const BODY_LIMIT = 2 * 1024 * 1024;
const DESK_TOKEN_HEADER = "x-gotchibot-desk-token";
const INSTALL_TOKEN_HEADER = "x-gotchibot-install-token";
/** Routes an unverified phone may still call (to find out it must verify, and to start it). */
const VERIFY_EXEMPT_PATHS = new Set([
  "/api/gotchibot/hub/whoami",
  "/api/gotchibot/hub/wallet/verify-request",
]);

function isPhoneDesk(desk) {
  return desk?.kind != null && String(desk.kind).trim().toLowerCase() === "phone";
}

let pkgVersion = "0.0.0";
try {
  pkgVersion = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")).version || "0.0.0";
} catch {
  /* ignore */
}

const claimFailures = []; // { t: number }

function pruneClaimFailures(now = Date.now()) {
  const cutoff = now - 10 * 60 * 1000;
  while (claimFailures.length && claimFailures[0].t < cutoff) claimFailures.shift();
}

function recordClaimFailure() {
  claimFailures.push({ t: Date.now() });
  pruneClaimFailures();
}

function claimRateLimited() {
  pruneClaimFailures();
  return claimFailures.length > 20;
}

function headerGet(req, name) {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) {
        resolveBody({});
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("invalid JSON body"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function parseUrl(req) {
  try {
    return new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  } catch {
    return new URL("/", "http://127.0.0.1");
  }
}

function isLoopbackHost(host) {
  const h = String(host || "").toLowerCase();
  // 0.0.0.0 binds ALL interfaces — not loopback; must warn about spoofable headers.
  return h === "127.0.0.1" || h === "::1" || h === "localhost";
}

function redactMongoUri(uri) {
  return String(uri || "").replace(/\/\/([^/@]+)@/g, "//***@");
}

/** Hero display names come from the OpenClaw workspaces; loaded lazily, best-effort. */
let heroNameFn;
async function loadHeroName() {
  if (heroNameFn !== undefined) return heroNameFn;
  try {
    const mod = await import("../../scripts/openclaw-fleet.mjs");
    heroNameFn = typeof mod.heroDisplayName === "function" ? mod.heroDisplayName : null;
  } catch {
    heroNameFn = null;
  }
  return heroNameFn;
}

/**
 * @param {{
 *   store: object,
 *   config: object,
 *   projects?: ReturnType<typeof createProjectSource>,
 *   verifyWallet?: (input: { address: string, message: string, signature: string }) => Promise<boolean>,
 *   ownerWallet?: () => string|null,
 *   opencode?: ReturnType<typeof createOpencodeClient>,
 * }} opts
 * @returns {import('node:http').Server}
 */
const whoisCache = new Map();

function nodeTags(ip) {
  const hit = whoisCache.get(ip);
  if (hit && Date.now() - hit.at < 60_000) return hit.tags;
  const r = spawnSync("tailscale", ["whois", "--json", ip], { encoding: "utf8", timeout: 2500 });
  let tags = [];
  if (r.status === 0) {
    try {
      tags = JSON.parse(r.stdout || "{}")?.Node?.Tags || [];
    } catch {
      tags = [];
    }
  }
  whoisCache.set(ip, { at: Date.now(), tags });
  return tags;
}

export function createApiServer({ store, config, projects, verifyWallet, ownerWallet, opencode }) {
  const ownerLogin = config.ownerLogin;
  const peerTags = Array.isArray(config.peerTags) ? config.peerTags : [];
  function originAllowed(req) {
    const origin = checkOrigin(
      { remoteAddress: req.socket?.remoteAddress, headers: req.headers },
      ownerLogin,
    );
    if (origin.ok || !peerTags.length) return origin;
    if (!/Tailscale-User-Login/.test(origin.error || "")) return origin;
    const ip = forwardedTailscaleIp(req.headers);
    if (!ip || !taggedPeerAllowed(nodeTags(ip), peerTags)) return origin;
    return { ok: true };
  }
  /** Desk-pushed portfolio, loaded from Mongo once and replaced on each push. */
  let projectSnapshot = null;
  let projectSnapshotLoaded = false;
  const toSnapshotView = (doc) =>
    doc
      ? {
          files: new Map(doc.files.map((f) => [f.path, { text: f.text, mtime: f.mtime }])),
          heroNames: doc.heroNames || {},
          pushedAt: doc.pushedAt,
        }
      : null;
  async function loadProjectSnapshot() {
    if (projectSnapshotLoaded) return;
    if (typeof store.getProjectSnapshot === "function") {
      projectSnapshot = toSnapshotView(await store.getProjectSnapshot());
    }
    projectSnapshotLoaded = true;
  }
  const projectSource =
    projects ||
    createProjectSource({
      root: config.projectsRoot || ROOT,
      heroName: (id) => (heroNameFn ? heroNameFn(id) : null),
      snapshot: () => projectSnapshot,
    });
  const repoDir = config.projectsRoot || ROOT;
  const opencodeClient =
    opencode ||
    createOpencodeClient({
      baseUrl: config.opencodeUrl,
      directory: repoDir,
      password: process.env.OPENCODE_SERVER_PASSWORD || null,
    });
  /** Terminals following a project desk (`/desk/events`): slug → Set<{ res, last }>. */
  const deskWatchers = new Map();
  const deskEventsBeatMs = config.deskEventsHeartbeatMs || 25_000;
  async function deskEvent(slug) {
    const s = await store.getDeskSession(slug);
    return { sessionId: s?.sessionId || null, sessionStartedAt: s?.sessionStartedAt || null };
  }
  function sendDeskEvent(watcher, ev) {
    if (watcher.last === ev.sessionId) return;
    watcher.last = ev.sessionId;
    watcher.res.write(`event: desk\ndata: ${JSON.stringify(ev)}\n\n`);
  }
  async function notifyDesk(slug) {
    const watchers = deskWatchers.get(slug);
    if (!watchers?.size) return;
    try {
      const ev = await deskEvent(slug);
      for (const w of watchers) sendDeskEvent(w, ev);
    } catch {
      /* the heartbeat re-sends */
    }
  }

  const verifySignature = verifyWallet || createCastVerifier();
  const resolveOwner = ownerWallet || (() => resolveOwnerWallet(config, config.projectsRoot || ROOT));

  /** A phone with no verified owner wallet, on a Hub that has an owner to verify against. */
  function phoneNeedsVerify(desk) {
    return isPhoneDesk(desk) && !desk.walletAddress && Boolean(resolveOwner());
  }

  async function requireDesk(req, res, path) {
    const deskToken = headerGet(req, DESK_TOKEN_HEADER);
    const installToken = headerGet(req, INSTALL_TOKEN_HEADER);
    if (!deskToken && installToken) {
      json(res, 401, {
        ok: false,
        error:
          "install token cannot unlock chat data — pair this desk: gotchibot hub join <host> <code>",
      });
      return null;
    }
    if (!deskToken) {
      json(res, 401, {
        ok: false,
        error: "desk token required — run: gotchibot hub join <host> <code>",
      });
      return null;
    }
    const desk = await store.findDeskByToken(deskToken);
    if (!desk) {
      json(res, 401, {
        ok: false,
        error: "desk token required — run: gotchibot hub join <host> <code>",
      });
      return null;
    }
    if (desk.revoked || desk.revokedAt) {
      json(res, 401, { ok: false, error: "desk token revoked" });
      return null;
    }
    await store.touchLastSeen(desk.deskId);
    if (!VERIFY_EXEMPT_PATHS.has(path) && phoneNeedsVerify(desk)) {
      json(res, 403, {
        ok: false,
        kind: "verify",
        error: "verify the Hub owner wallet on this phone first",
      });
      return null;
    }
    return desk;
  }

  async function handle(req, res) {
    const url = parseUrl(req);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (req.method === "GET" && path === "/health") {
        let db = "ok";
        try {
          await store.db.command({ ping: 1 });
        } catch {
          db = "down";
        }
        return json(res, 200, {
          ok: true,
          service: "gotchibot-api",
          version: pkgVersion,
          db,
        });
      }

      const origin = originAllowed(req);
      if (!origin.ok) {
        return json(res, origin.status, { ok: false, error: origin.error });
      }

      // Exact "/" only (raw pathname — do not use trailing-slash-normalized `path`)
      const rawPath = url.pathname;
      if (
        (req.method === "GET" || req.method === "HEAD") &&
        rawPath === "/"
      ) {
        res.writeHead(302, { Location: "/app/" });
        res.end();
        return;
      }

      // Phone PWA static files under /app/ (owner/tailnet only; after origin check)
      if (
        (req.method === "GET" || req.method === "HEAD") &&
        (rawPath === "/app" || rawPath.startsWith("/app/"))
      ) {
        if (rawPath === "/app") {
          res.writeHead(308, { Location: "/app/" });
          res.end();
          return;
        }
        const filePath = resolveStaticPath(APP_DIR, rawPath);
        if (!filePath) {
          return json(res, 404, { ok: false, error: "not found" });
        }
        let st;
        try {
          st = await stat(filePath);
        } catch {
          return json(res, 404, { ok: false, error: "not found" });
        }
        if (!st.isFile()) {
          return json(res, 404, { ok: false, error: "not found" });
        }
        const body = req.method === "HEAD" ? null : await readFile(filePath);
        const headers = {
          "Content-Type": contentTypeFor(filePath),
          "Content-Length": String(st.size),
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Content-Security-Policy": STATIC_CSP,
          "Permissions-Policy": STATIC_PERMISSIONS_POLICY,
          "Cache-Control": isNoCacheShellFile(filePath)
            ? "no-cache"
            : "public, max-age=300",
        };
        res.writeHead(200, headers);
        if (req.method === "HEAD") {
          res.end();
        } else {
          res.end(body);
        }
        return;
      }

      // POST /api/gotchibot/hub/pair/claim
      if (req.method === "POST" && path === "/api/gotchibot/hub/pair/claim") {
        if (claimRateLimited()) {
          return json(res, 429, { ok: false, error: "too many failed claims" });
        }
        const body = await readBody(req);
        try {
          const result = await store.claimPairingCode({
            code: body.code,
            name: body.name,
            kind: body.kind,
          });
          return json(res, 200, { ok: true, ...result });
        } catch (err) {
          if (err.code === "INVALID_CODE") {
            recordClaimFailure();
            return json(res, 401, { ok: false, error: err.message });
          }
          if (err.status) {
            return json(res, err.status, { ok: false, error: err.message });
          }
          throw err;
        }
      }

      // POST /api/gotchibot/hub/wallet/nonce — message for the owner wallet to sign
      if (req.method === "POST" && path === "/api/gotchibot/hub/wallet/nonce") {
        if (!resolveOwner()) {
          return json(res, 503, {
            ok: false,
            error: "wallet sign-in not set up on this Hub — run gotchibot wallet connect on the Hub (or set ownerWallet)",
          });
        }
        const nonce = `0x${randomBytes(16).toString("hex")}`;
        const issuedAt = new Date().toISOString();
        const host = config.tailscaleHost || headerGet(req, "host") || null;
        const message = walletLoginMessage({ nonce, host, issuedAt });
        const minted = await store.mintWalletNonce({ nonce, message });
        return json(res, 200, {
          ok: true,
          nonce,
          message,
          expiresAt: minted.expiresAt,
        });
      }

      // POST /api/gotchibot/hub/wallet/login — verify signature → phone desk token
      // (or, with handoff:true, a one-time pairing code for the home-screen app).
      if (req.method === "POST" && path === "/api/gotchibot/hub/wallet/login") {
        if (claimRateLimited()) {
          return json(res, 429, { ok: false, error: "too many failed sign-ins" });
        }
        const body = await readBody(req);
        const address = String(body.address || "").trim();
        const signature = String(body.signature || "").trim();
        if (!isAddress(address) || !isSignature(signature)) {
          return json(res, 400, { ok: false, error: "address and signature required" });
        }
        const owner = resolveOwner();
        if (!owner) {
          return json(res, 503, { ok: false, error: "wallet sign-in not set up on this Hub" });
        }
        const issued = await store.consumeWalletNonce(String(body.nonce || ""));
        if (!issued) {
          recordClaimFailure();
          return json(res, 401, { ok: false, error: "sign-in expired — try again" });
        }
        if (address.toLowerCase() !== owner) {
          recordClaimFailure();
          return json(res, 403, { ok: false, error: "this wallet is not the Hub owner" });
        }
        const valid = await verifySignature({ address, message: issued.message, signature });
        if (!valid) {
          recordClaimFailure();
          return json(res, 401, { ok: false, error: "signature did not verify" });
        }
        if (body.handoff === true) {
          const pair = await store.mintPairingCode({
            name: body.name || "iPhone",
            kind: "phone",
            walletAddress: address,
          });
          return json(res, 200, {
            ok: true,
            handoff: { code: pair.code, expiresAt: pair.expiresAt },
          });
        }
        const desk = await store.createWalletDesk({ address, name: body.name });
        return json(res, 200, { ok: true, ...desk });
      }

      // POST /api/gotchibot/hub/wallet/verify — from the wallet's in-app browser:
      // owner signature + a verify-request code binds the wallet to that paired desk.
      if (req.method === "POST" && path === "/api/gotchibot/hub/wallet/verify") {
        if (claimRateLimited()) {
          return json(res, 429, { ok: false, error: "too many failed sign-ins" });
        }
        const body = await readBody(req);
        const address = String(body.address || "").trim();
        const signature = String(body.signature || "").trim();
        const code = String(body.code || "").trim();
        if (!isAddress(address) || !isSignature(signature) || !code) {
          return json(res, 400, { ok: false, error: "code, address and signature required" });
        }
        const owner = resolveOwner();
        if (!owner) {
          return json(res, 503, { ok: false, error: "wallet sign-in not set up on this Hub" });
        }
        const issued = await store.consumeWalletNonce(String(body.nonce || ""));
        if (!issued) {
          recordClaimFailure();
          return json(res, 401, { ok: false, error: "sign-in expired — try again" });
        }
        if (address.toLowerCase() !== owner) {
          recordClaimFailure();
          return json(res, 403, { ok: false, error: "this wallet is not the Hub owner" });
        }
        const valid = await verifySignature({ address, message: issued.message, signature });
        if (!valid) {
          recordClaimFailure();
          return json(res, 401, { ok: false, error: "signature did not verify" });
        }
        const link = await store.consumeVerifyCode(code);
        if (!link) {
          recordClaimFailure();
          return json(res, 401, {
            ok: false,
            error: "verify link expired or already used — tap Verify on the phone again",
          });
        }
        if (!(await store.setDeskWallet(link.deskId, address))) {
          return json(res, 404, { ok: false, error: "that phone was signed out on the Hub" });
        }
        return json(res, 200, { ok: true, verified: true });
      }

      // Desk-token routes
      if (path.startsWith("/api/gotchibot/")) {
        const desk = await requireDesk(req, res, path);
        if (!desk) return;
        const deskKind =
          desk.kind != null && String(desk.kind).trim().toLowerCase() === "phone"
            ? "phone"
            : "desk";

        if (req.method === "GET" && path === "/api/gotchibot/hub/whoami") {
          return json(res, 200, {
            ok: true,
            deskId: desk.deskId,
            name: desk.name,
            kind: deskKind,
            walletAddress: desk.walletAddress || null,
            verifyRequired: phoneNeedsVerify(desk),
          });
        }

        // POST /api/gotchibot/hub/pair/phone — a paired desk mints a one-time
        // phone pairing code (the cockpit "Link a phone" QR). Phones cannot.
        if (req.method === "POST" && path === "/api/gotchibot/hub/pair/phone") {
          if (deskKind !== "desk") {
            return json(res, 403, { ok: false, error: "only a desk can link a phone" });
          }
          const body = await readBody(req);
          const name = String(body.name || "iPhone").trim().slice(0, 60) || "iPhone";
          const pair = await store.mintPairingCode({ name, kind: "phone" });
          return json(res, 200, {
            ok: true,
            code: pair.code,
            expiresAt: pair.expiresAt,
            appUrl: config?.appUrl || null,
          });
        }

        // POST /api/gotchibot/hub/wallet/verify-request — one-time link code the
        // phone opens inside its wallet browser (see wallet/verify).
        if (req.method === "POST" && path === "/api/gotchibot/hub/wallet/verify-request") {
          if (!resolveOwner()) {
            return json(res, 503, {
              ok: false,
              error: "wallet sign-in not set up on this Hub — run gotchibot wallet connect on the Hub (or set ownerWallet)",
            });
          }
          if (desk.walletAddress) {
            return json(res, 200, { ok: true, verified: true, walletAddress: desk.walletAddress });
          }
          const { code, expiresAt } = await store.mintVerifyCode(desk.deskId);
          return json(res, 200, { ok: true, verified: false, code, expiresAt });
        }

        if (req.method === "GET" && path === "/api/gotchibot/hub/desks") {
          if (deskKind === "phone") {
            return json(res, 403, {
              ok: false,
              error: "not allowed for phone desks",
            });
          }
          const desks = await store.listDesks();
          return json(res, 200, { ok: true, desks });
        }

        if (req.method === "POST" && path === "/api/gotchibot/chats/push") {
          const body = await readBody(req);
          const result = await store.pushMessages({
            threadId: body.threadId,
            title: body.title,
            thread: body.thread,
            messages: body.messages,
            deskId: desk.deskId,
            desk,
          });
          return json(res, 200, result);
        }

        if (req.method === "POST" && path === "/api/gotchibot/chats/send") {
          const body = await readBody(req);
          const result = await store.sendMessage({
            desk,
            threadId: body.threadId,
            clientMessageId: body.clientMessageId,
            text: body.text,
            title: body.title,
            project: body.project,
          });
          return json(res, 200, result);
        }

        if (req.method === "POST" && path === "/api/gotchibot/chats/retry") {
          const body = await readBody(req);
          const result = await store.retryReply({
            desk,
            threadId: body.threadId,
            messageId: body.messageId,
          });
          return json(res, 200, result);
        }

        if (req.method === "GET" && path === "/api/gotchibot/hub/runner") {
          const runner = await store.getRunnerStatus();
          return json(res, 200, { ok: true, runner });
        }

        if (req.method === "GET" && path === "/api/gotchibot/chats/pull") {
          const threadId = url.searchParams.get("threadId") || undefined;
          const after = url.searchParams.get("after") || 0;
          const limit = url.searchParams.get("limit") || 100;
          const result = await store.pullMessages({
            threadId,
            after,
            limit,
            desk,
          });
          return json(res, 200, result);
        }

        if (req.method === "GET" && path === "/api/gotchibot/chats/threads") {
          const limit = url.searchParams.get("limit") || 100;
          const project = url.searchParams.get("project") || undefined;
          const paginate = url.searchParams.get("paginate") === "1";
          const after = url.searchParams.get("after") || undefined;
          const result = await store.listThreads({ limit, desk, project, paginate, after });
          return json(res, 200, result);
        }

        if (req.method === "POST" && path === "/api/gotchibot/projects/push") {
          if (deskKind === "phone") {
            return json(res, 403, {
              ok: false,
              error: "not allowed for phone desks",
            });
          }
          const snapshot = validateProjectSnapshot(await readBody(req));
          const { pushedAt } = await store.putProjectSnapshot({
            deskId: desk.deskId,
            ...snapshot,
          });
          projectSnapshot = toSnapshotView(await store.getProjectSnapshot()) || toSnapshotView({ ...snapshot, pushedAt });
          projectSnapshotLoaded = true;
          await loadHeroName();
          return json(res, 200, {
            ok: true,
            pushedAt,
            files: snapshot.files.length,
            projects: projectSource.listSlugs().length,
          });
        }

        // Desk write of dossier / kanban / meet / inbox. Merges into this desk's
        // snapshot (does not drop the rest) and lands on the Hub repo tree.
        if (req.method === "POST" && path === "/api/gotchibot/projects/files") {
          if (deskKind === "phone") {
            return json(res, 403, { ok: false, error: "not allowed for phone desks" });
          }
          const snapshot = validateProjectSnapshot(await readBody(req));
          if (!snapshot.files.length || snapshot.files.some((f) => !projectSyncPathOk(f.path))) {
            return json(res, 400, { ok: false, error: "project file path not allowed" });
          }
          if (typeof store.mergeProjectSnapshot !== "function") {
            return json(res, 501, { ok: false, error: "hub cannot store project files" });
          }
          const { pushedAt } = await store.mergeProjectSnapshot({
            deskId: desk.deskId,
            files: snapshot.files,
            heroNames: snapshot.heroNames,
          });
          materializeSnapshotFiles(config.projectsRoot || ROOT, snapshot.files);
          projectSnapshotLoaded = false;
          await loadProjectSnapshot();
          return json(res, 200, { ok: true, pushedAt, files: snapshot.files.length });
        }

        const projectFilesMatch = path.match(/^\/api\/gotchibot\/projects\/([^/]+)\/files$/);
        if (req.method === "GET" && projectFilesMatch) {
          await loadProjectSnapshot();
          let slug;
          try {
            slug = decodeURIComponent(projectFilesMatch[1]);
          } catch {
            slug = "";
          }
          if (!projectSlugOk(slug)) {
            return json(res, 400, { ok: false, error: "invalid project" });
          }
          return json(res, 200, { ok: true, slug, files: projectSource.listSyncFiles(slug) });
        }

        if (req.method === "POST" && path === "/api/gotchibot/cockpit/push") {
          if (deskKind === "phone") {
            return json(res, 403, {
              ok: false,
              error: "not allowed for phone desks",
            });
          }
          const cockpit = validateCockpitSnapshot(await readBody(req));
          const { pushedAt } = await store.putCockpitSnapshot({ deskId: desk.deskId, cockpit });
          return json(res, 200, { ok: true, pushedAt });
        }

        if (req.method === "GET" && path === "/api/gotchibot/cockpit") {
          const snap = await store.getCockpitSnapshot();
          return json(res, 200, {
            ok: true,
            pushedAt: snap?.pushedAt || null,
            cockpit: snap?.cockpit || null,
          });
        }

        if (req.method === "POST" && path === "/api/gotchibot/tree/push") {
          if (deskKind === "phone") {
            return json(res, 403, {
              ok: false,
              error: "not allowed for phone desks",
            });
          }
          const tree = validateTreeSnapshot(await readBody(req));
          const { pushedAt } = await store.putTreeSnapshot({ deskId: desk.deskId, deskName: desk.name, tree });
          return json(res, 200, { ok: true, pushedAt });
        }

        if (req.method === "GET" && path === "/api/gotchibot/tree") {
          const desks = await store.listTreeSnapshots();
          return json(res, 200, { ok: true, self: desk.deskId, desks });
        }

        if (req.method === "GET" && path === "/api/gotchibot/projects") {
          await loadProjectSnapshot();
          await loadHeroName();
          return json(res, 200, { ok: true, projects: projectSource.listProjects() });
        }

        const deskMatch = path.match(/^\/api\/gotchibot\/projects\/([^/]+)\/desk$/);
        if (req.method === "GET" && deskMatch) {
          await loadProjectSnapshot();
          await loadHeroName();
          let slug;
          try {
            slug = decodeURIComponent(deskMatch[1]);
          } catch {
            slug = "";
          }
          const project = projectSource.getProject(slug);
          if (!project) {
            return json(res, 404, { ok: false, error: "project not found" });
          }
          const title = deskThreadTitle(project, slug);
          const { threadId } = await store.ensureDeskThread({ slug, title });
          const state = await store.getDeskSession(slug);
          const out = { ok: true, project: slug, threadId, title, sessionStartedAt: state?.sessionStartedAt || null };
          if (deskKind === "desk") {
            let sessionId = state?.sessionId || null;
            if (url.searchParams.get("session") === "1") {
              try {
                sessionId = await ensureDeskSession({ store, client: opencodeClient, slug, title });
              } catch {
                out.sessionError = "the Hub's OpenCode server is not reachable — gotchibot hub desk service status";
              }
            }
            if (sessionId !== state?.sessionId) {
              out.sessionStartedAt = (await store.getDeskSession(slug))?.sessionStartedAt || null;
              await notifyDesk(slug);
            }
            Object.assign(out, { sessionId, repoDir, opencodeUrl: opencodeClient.baseUrl });
          }
          return json(res, 200, out);
        }

        // GET /api/gotchibot/projects/:slug/desk/events — SSE: `event: desk` with
        // {sessionId, sessionStartedAt} on connect and whenever the current session moves.
        const eventsMatch = path.match(/^\/api\/gotchibot\/projects\/([^/]+)\/desk\/events$/);
        if (req.method === "GET" && eventsMatch) {
          if (deskKind === "phone") {
            return json(res, 403, { ok: false, error: "not allowed for phone desks" });
          }
          await loadProjectSnapshot();
          let slug;
          try {
            slug = decodeURIComponent(eventsMatch[1]);
          } catch {
            slug = "";
          }
          if (!projectSource.getProject(slug)) {
            return json(res, 404, { ok: false, error: "project not found" });
          }
          const first = await deskEvent(slug);
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });
          const watcher = { res, last: undefined };
          if (!deskWatchers.has(slug)) deskWatchers.set(slug, new Set());
          deskWatchers.get(slug).add(watcher);
          sendDeskEvent(watcher, first);
          // Heartbeat: keeps proxies open, drops revoked tokens, and catches
          // session moves made by other processes (the desk runner).
          const token = headerGet(req, DESK_TOKEN_HEADER);
          const beat = setInterval(async () => {
            try {
              const d = await store.findDeskByToken(token);
              if (!d || d.revoked || d.revokedAt) return res.end();
              res.write(": ping\n\n");
              sendDeskEvent(watcher, await deskEvent(slug));
            } catch {
              /* next beat */
            }
          }, deskEventsBeatMs);
          res.on("close", () => {
            clearInterval(beat);
            const set = deskWatchers.get(slug);
            set?.delete(watcher);
            if (set && !set.size) deskWatchers.delete(slug);
          });
          return;
        }

        // GET /api/gotchibot/projects/:slug/desk/sessions — the chat's sessions to switch between.
        // GET /api/gotchibot/projects/:slug/desk/commands — OpenCode `/` commands the phone may run.
        const deskListMatch = path.match(/^\/api\/gotchibot\/projects\/([^/]+)\/desk\/(sessions|commands)$/);
        if (req.method === "GET" && deskListMatch) {
          await loadProjectSnapshot();
          let slug;
          try {
            slug = decodeURIComponent(deskListMatch[1]);
          } catch {
            slug = "";
          }
          if (!projectSource.getProject(slug)) {
            return json(res, 404, { ok: false, error: "project not found" });
          }
          try {
            if (deskListMatch[2] === "commands") {
              const commands = phoneCommands(await opencodeClient.listCommands());
              return json(res, 200, { ok: true, project: slug, commands });
            }
            const listed = await listProjectSessions({ store, client: opencodeClient, slug });
            return json(res, 200, { ok: true, project: slug, ...listed });
          } catch {
            return json(res, 503, {
              ok: false,
              error: "the Hub's OpenCode server is not reachable — gotchibot hub desk service status",
            });
          }
        }

        // POST /api/gotchibot/projects/:slug/desk/session — New session in the
        // project's one chat (fresh agent context), from any device.
        const newSessionMatch = path.match(/^\/api\/gotchibot\/projects\/([^/]+)\/desk\/session$/);
        if (req.method === "POST" && newSessionMatch) {
          await loadProjectSnapshot();
          await loadHeroName();
          let slug;
          try {
            slug = decodeURIComponent(newSessionMatch[1]);
          } catch {
            slug = "";
          }
          const project = projectSource.getProject(slug);
          if (!project) {
            return json(res, 404, { ok: false, error: "project not found" });
          }
          const body = (await readBody(req)) || {};
          const adoptId = body.sessionId != null ? String(body.sessionId) : null;
          if (adoptId != null && !/^ses_[A-Za-z0-9]{1,120}$/.test(adoptId)) {
            return json(res, 400, { ok: false, error: "sessionId must be an OpenCode session id (ses_…)" });
          }
          // A desk attached over SSH authenticates as the Hub; it names the real device.
          const device =
            deskKind === "desk" && typeof body.device === "string"
              ? body.device.replace(/[^\w .@-]/g, "").trim().slice(0, 40)
              : "";
          const startedBy = device || desk.name || (deskKind === "phone" ? "phone" : "desk");
          const title = deskThreadTitle(project, slug);
          let started;
          try {
            started = adoptId
              ? await adoptDeskSessionFromTerminal({
                  store,
                  client: opencodeClient,
                  slug,
                  title,
                  sessionId: adoptId,
                  startedBy,
                })
              : await startNewDeskSession({ store, client: opencodeClient, slug, title, startedBy });
          } catch (err) {
            if (adoptId && err?.status === 404) {
              return json(res, 404, { ok: false, error: "no such session on the Hub's OpenCode server" });
            }
            if (err?.status && err.status < 500 && err.status !== 404) throw err;
            return json(res, 503, {
              ok: false,
              error: "the Hub's OpenCode server is not reachable — gotchibot hub desk service status",
            });
          }
          await notifyDesk(slug);
          return json(res, 200, { ok: true, project: slug, ...started });
        }

        const projectMatch = path.match(/^\/api\/gotchibot\/projects\/([^/]+)$/);
        if (req.method === "GET" && projectMatch) {
          await loadProjectSnapshot();
          await loadHeroName();
          let slug;
          try {
            slug = decodeURIComponent(projectMatch[1]);
          } catch {
            slug = "";
          }
          const project = projectSource.getProject(slug);
          if (!project) {
            return json(res, 404, { ok: false, error: "project not found" });
          }
          return json(res, 200, { ok: true, project });
        }

        const avatarMatch = path.match(/^\/api\/gotchibot\/avatars\/([^/]+)\.svg$/);
        if (req.method === "GET" && avatarMatch) {
          await loadProjectSnapshot();
          const text = projectSource.readAvatarSvg(avatarMatch[1]);
          if (!text) {
            return json(res, 404, { ok: false, error: "avatar not found" });
          }
          const svg = Buffer.from(text, "utf8");
          res.writeHead(200, {
            "Content-Type": "image/svg+xml",
            "Content-Length": String(svg.length),
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
            "Cache-Control": "private, max-age=600",
          });
          res.end(svg);
          return;
        }

        if (req.method === "POST" && path === "/api/gotchibot/chats/snapshot") {
          if (deskKind === "phone") {
            return json(res, 403, {
              ok: false,
              error: "not allowed for phone desks",
            });
          }
          const body = await readBody(req);
          const result = await store.createSnapshot({
            threadIds: body.threadIds,
            gitCommit: body.gitCommit,
            gitBranch: body.gitBranch,
            deskId: desk.deskId,
          });
          return json(res, 200, result);
        }

        const snapMatch = path.match(/^\/api\/gotchibot\/chats\/snapshot\/([^/]+)$/);
        if (req.method === "GET" && snapMatch) {
          if (deskKind === "phone") {
            return json(res, 403, {
              ok: false,
              error: "not allowed for phone desks",
            });
          }
          const snapshotId = decodeURIComponent(snapMatch[1]);
          if (!isUlid(snapshotId)) {
            return json(res, 404, { ok: false, error: "snapshot not found" });
          }
          const snap = await store.getSnapshot(snapshotId);
          if (!snap) {
            return json(res, 404, { ok: false, error: "snapshot not found" });
          }
          return json(res, 200, snap);
        }
      }

      return json(res, 404, { ok: false, error: "not found" });
    } catch (err) {
      const status = err.status || 500;
      const message =
        status >= 500 ? "internal error" : err.message || "error";
      if (status >= 500) {
        console.error("[gotchibot-api]", err);
      }
      return json(res, status, { ok: false, error: message });
    }
  }

  return createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error("[gotchibot-api] unhandled", err);
      if (!res.headersSent) {
        json(res, 500, { ok: false, error: "internal error" });
      }
    });
  });
}

/**
 * Connect store, ensure indexes, listen. Returns {server, store, close}.
 */
export async function startApiServer(opts = {}) {
  const config = opts.config || resolveApiConfig(opts.env || process.env);
  const store = opts.store || (await connectStore({
    mongoUri: config.mongoUri,
    dbName: config.dbName,
  }));
  await store.ensureIndexes();
  const server = createApiServer({ store, config });

  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.removeListener("error", reject);
      resolveListen();
    });
  });

  if (!isLoopbackHost(config.host)) {
    console.warn(
      "[gotchibot-api] WARNING: bound to non-loopback host — Tailscale identity headers can be spoofed when not behind Tailscale serve on loopback",
    );
  }

  async function close() {
    await new Promise((r) => server.close(r));
    await store.close();
  }

  return { server, store, config, close };
}

async function main() {
  const config = resolveApiConfig();
  const { server, config: cfg, close } = await startApiServer({ config });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : cfg.port;
  console.log(
    `gotchibot-api listening on http://${cfg.host}:${port} (db ${cfg.dbName})`,
  );
  // never log credentials — redact if someone enables debug later
  void redactMongoUri;

  const shutdown = async () => {
    try {
      await close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
