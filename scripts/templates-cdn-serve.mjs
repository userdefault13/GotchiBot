#!/usr/bin/env node
/**
 * Static origin for the bot-template marketplace CDN.
 * Serves templates/marketplace/ on 127.0.0.1:8793 (Cloudflare tunnel → templates.aarcadeghst.com).
 *
 *   node scripts/templates-cdn-serve.mjs [--port 8793] [--root templates/marketplace]
 *
 * No installs. Read-only HTTP GET/HEAD. CORS open for catalog fetch from other origins.
 */
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ROOT = join(ROOT, "templates", "marketplace");
const DEFAULT_PORT = 8793;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".zip": "application/zip",
  ".gz": "application/gzip",
};

function argValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent((urlPath || "/").split("?")[0]);
  const rel = decoded.replace(/^\/+/, "");
  const abs = normalize(join(root, rel));
  const rootNorm = normalize(root + sep);
  if (abs !== root && !abs.startsWith(rootNorm)) return null;
  return abs;
}

function send(res, status, body, headers = {}) {
  const buf = body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, {
    "Content-Length": buf.length,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Cache-Control": status === 200 ? "public, max-age=60" : "no-store",
    ...headers,
  });
  res.end(buf);
}

function main() {
  const args = process.argv.slice(2);
  const port = Number(argValue(args, "--port") || process.env.TEMPLATES_CDN_PORT || DEFAULT_PORT);
  const root = resolve(argValue(args, "--root") || process.env.TEMPLATES_CDN_ROOT || DEFAULT_ROOT);
  if (!existsSync(root)) {
    console.error(`templates-cdn-serve: root missing: ${root}`);
    process.exit(1);
  }

  const server = createServer((req, res) => {
    if (req.method === "OPTIONS") {
      send(res, 204, null);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(res, 405, "method not allowed\n", { "Content-Type": "text/plain; charset=utf-8" });
      return;
    }

    let path = safeJoin(root, req.url || "/");
    if (!path) {
      send(res, 403, "forbidden\n", { "Content-Type": "text/plain; charset=utf-8" });
      return;
    }

    try {
      let st = statSync(path);
      if (st.isDirectory()) {
        const index = join(path, "index.html");
        if (existsSync(index)) {
          path = index;
          st = statSync(path);
        } else {
          send(res, 404, "not found\n", { "Content-Type": "text/plain; charset=utf-8" });
          return;
        }
      }
      const type = TYPES[extname(path).toLowerCase()] || "application/octet-stream";
      if (req.method === "HEAD") {
        res.writeHead(200, {
          "Content-Type": type,
          "Content-Length": st.size,
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=60",
        });
        res.end();
        return;
      }
      send(res, 200, readFileSync(path), { "Content-Type": type });
    } catch {
      send(res, 404, "not found\n", { "Content-Type": "text/plain; charset=utf-8" });
    }
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`templates-cdn-serve listening http://127.0.0.1:${port} root=${root}`);
  });
}

main();
