/**
 * gotchibot-api — self-hosted Hub chat/desk HTTP API (node:http, no express).
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../../scripts/is-main.mjs";
import { isUlid } from "../../scripts/chat-canonical.mjs";
import { resolveApiConfig } from "./config.mjs";
import { checkOrigin } from "./auth.mjs";
import { connectStore } from "./store.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BODY_LIMIT = 2 * 1024 * 1024;
const DESK_TOKEN_HEADER = "x-gotchibot-desk-token";
const INSTALL_TOKEN_HEADER = "x-gotchibot-install-token";

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

/**
 * @param {{ store: object, config: object }} opts
 * @returns {import('node:http').Server}
 */
export function createApiServer({ store, config }) {
  const ownerLogin = config.ownerLogin;

  async function requireDesk(req, res) {
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

      const origin = checkOrigin(
        { remoteAddress: req.socket?.remoteAddress, headers: req.headers },
        ownerLogin,
      );
      if (!origin.ok) {
        return json(res, origin.status, { ok: false, error: origin.error });
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

      // Desk-token routes
      if (path.startsWith("/api/gotchibot/")) {
        const desk = await requireDesk(req, res);
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
          });
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
          const result = await store.listThreads({ limit, desk });
          return json(res, 200, result);
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
