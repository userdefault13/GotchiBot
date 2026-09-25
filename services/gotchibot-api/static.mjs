/**
 * Pure helpers for serving the Hub phone app under /app/.
 * Unit-testable without Mongo or a listening server.
 */
import { basename, extname, resolve, sep } from "node:path";

const APP_PREFIX = "/app";

/**
 * Map a request pathname (e.g. "/app/", "/app/js/main.js") to an absolute
 * file under appDir, or null if the path is unsafe / blocked / not under app.
 *
 * @param {string} appDir absolute path to services/gotchibot-api/app
 * @param {string} urlPath request pathname (may be percent-encoded)
 * @returns {string|null}
 */
export function resolveStaticPath(appDir, urlPath) {
  if (appDir == null || urlPath == null) return null;
  const root = resolve(String(appDir));
  let decoded;
  try {
    decoded = decodeURIComponent(String(urlPath));
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;

  let rest;
  if (decoded === APP_PREFIX || decoded === `${APP_PREFIX}/`) {
    rest = "index.html";
  } else if (decoded.startsWith(`${APP_PREFIX}/`)) {
    rest = decoded.slice(APP_PREFIX.length + 1);
  } else {
    return null;
  }

  if (!rest || rest.endsWith("/")) {
    rest = rest ? `${rest}index.html` : "index.html";
  }

  const segments = rest.split("/").filter((s) => s.length > 0);
  if (!segments.length) return null;
  for (const seg of segments) {
    if (seg.startsWith(".")) return null;
  }
  // Build helpers must not be served.
  if (segments[0] === "scripts") return null;

  const candidate = resolve(root, ...segments);
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  return candidate;
}

/**
 * @param {string} file absolute or relative file path
 * @returns {string} Content-Type value
 */
export function contentTypeFor(file) {
  const name = basename(String(file || ""));
  const ext = extname(name).toLowerCase();
  const base = name.toLowerCase();

  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js" || ext === ".mjs") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".webmanifest") return "application/manifest+json";
  if (ext === ".json") return "application/json";
  if (ext === ".png") return "image/png";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".ico") return "image/x-icon";
  if (ext === ".txt" || ext === ".md") return "text/plain; charset=utf-8";
  // Extensionless LICENSE / NOTICE
  if (!ext && (base === "license" || base === "notice" || base === "readme")) {
    return "text/plain; charset=utf-8";
  }
  return "application/octet-stream";
}

/**
 * Paths that must not be cached aggressively (shell entrypoints).
 * @param {string} file
 */
export function isNoCacheShellFile(file) {
  const name = basename(String(file || "")).toLowerCase();
  return (
    name === "index.html" ||
    name === "sw.js" ||
    name === "manifest.webmanifest"
  );
}

export const STATIC_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

export const STATIC_PERMISSIONS_POLICY =
  "camera=(self), microphone=(), geolocation=()";
