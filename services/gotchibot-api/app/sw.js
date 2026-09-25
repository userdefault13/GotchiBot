/* GotchiBot phone app — app-shell service worker (v0.2.0).
   Precaches shell assets only. Never intercepts /api/ or other origins. */
const APP_VERSION = "0.2.0";
const CACHE_NAME = `gotchibot-shell-v${APP_VERSION}`;

/** Relative shell paths (resolved against the SW scope /app/). */
const SHELL = [
  "./",
  "index.html",
  "app.css",
  "js/main.js",
  "js/version.js",
  "js/icons.js",
  "js/pair.js",
  "js/markdown.js",
  "js/thread-model.js",
  "js/compose-model.js",
  "js/poller.js",
  "js/storage.js",
  "js/api.js",
  "js/scan.js",
  "manifest.webmanifest",
  "icons/icon-32.png",
  "icons/icon-180.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-512-maskable.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("gotchibot-shell-") && k !== CACHE_NAME)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

function isShellRequest(url) {
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith("/api/")) return false;
  const base = self.registration.scope; // e.g. https://host/app/
  if (!url.href.startsWith(base)) return false;
  let rel = url.pathname.slice(new URL(base).pathname.length);
  if (!rel || rel.endsWith("/")) rel = "index.html";
  const shellSet = new Set(
    SHELL.map((p) => {
      if (p === "./") return "index.html";
      return p.replace(/^\.\//, "");
    }),
  );
  return shellSet.has(rel);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  // Only same-origin shell GETs — everything else (esp. /api/) passes through.
  if (!isShellRequest(url)) return;

  event.respondWith(
    (async () => {
      const cached = await caches.match(req, { ignoreSearch: true });
      if (cached) return cached;
      try {
        const fresh = await fetch(req);
        return fresh;
      } catch (err) {
        const fallback = await caches.match("index.html");
        if (fallback) return fallback;
        throw err;
      }
    })(),
  );
});
