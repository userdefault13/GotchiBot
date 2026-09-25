# GotchiBot phone app (`/app/`)

Home-screen iPhone PWA for the self-hosted GotchiBot Hub. Served by
`gotchibot-api` at `/app/` (same origin). Talks **only** to the Hub API
(`X-GotchiBot-Desk-Token`; pair/claim, whoami, threads, pull, send, retry,
runner). No React, no Vite build step — vanilla HTML/CSS/ES modules.

Design tokens / session cards / message bubbles / drawer / buttons / composer
chrome are adapted from [Mobilecode-open](https://github.com/elkir0/Mobilecode-open)
(Apache-2.0). See [`NOTICE`](./NOTICE) and [`THIRD_PARTY/`](./THIRD_PARTY/).

## File map

| Path | Role |
|---|---|
| `index.html` | Shell + iOS PWA meta (relative URLs) |
| `manifest.webmanifest` | Standalone install under `/app/` |
| `app.css` | Viewer + composer design system (adapted) |
| `sw.js` | App-shell service worker (never caches `/api/` or `vendor/`) |
| `js/main.js` | Hash router + Pair / Threads / Thread / Settings views |
| `js/version.js` | `APP_VERSION` (must match `sw.js`) |
| `js/icons.js` | SVG icon strings (adapted) |
| `js/pair.js` | Pairing-code normalize / format / deep-link parse (pure) |
| `js/markdown.js` | Safe markdown → HTML for `.message-content` (pure) |
| `js/thread-model.js` | In-memory message apply/edit/delete + reply merge (pure) |
| `js/compose-model.js` | Composer / reply UI state helpers (pure) |
| `js/poller.js` | Visibility-aware poll loop + `setIntervalMs` (pure) |
| `js/storage.js` | IndexedDB desk credentials only |
| `js/api.js` | Same-origin Hub fetch + typed errors |
| `js/scan.js` | In-app QR scanner (lazy-loads `vendor/jsQR.min.js`) |
| `icons/` | Generated PNGs |
| `vendor/jsQR.min.js` | On-demand QR decoder (not precached) |
| `scripts/make-icons.mjs` | PNG generator (not served) |
| `scripts/vendor-jsqr.sh` | Reproduce vendored decoder |

## S2: reply from phone

- **Composer** — bottom-docked, safe-area + `visualViewport` aware; auto-grow
  textarea (≤ ~6 lines); Enter = newline; Cmd/Ctrl+Enter = send.
- **New thread** — `+` in the threads header → `#/thread/new`; first
  `POST /chats/send` omits `threadId`, then `history.replaceState` to the
  returned id (phone-owned).
- **Optimistic send** — `clientMessageId` (UUID hex) for idempotent retry;
  failed network/5xx → Retry + Discard; **403** → no retry, shared-thread copy.
- **Waiting** — `reply.status` `pending`/`claimed` → “gotchi is thinking…” +
  faster poll (~1.75s); `error` → sanitized text + `/chats/retry`.
- **Runner** — while waiting, `GET /hub/runner` at most every ~10s; settings
  shows status · model. Non-blocking notice when offline/error.
- **Version** — bump `APP_VERSION` in **both** `sw.js` and `js/version.js`
  together (currently `0.2.0`). New JS modules must be listed in the SW
  `SHELL` precache.

## Regenerate icons

```bash
node services/gotchibot-api/app/scripts/make-icons.mjs
```

## Regenerate jsQR vendor

```bash
./services/gotchibot-api/app/scripts/vendor-jsqr.sh
```

## CSP

The Hub sets a strict CSP on static responses (`default-src 'self'`, no inline
scripts/styles). Keep all assets as separate files with relative URLs. No
`style=""` attributes in HTML strings — use classes or `element.style` via JS.
