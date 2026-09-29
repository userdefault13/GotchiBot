# GotchiBot phone app (`/app/`)

Home-screen iPhone PWA for the self-hosted GotchiBot Hub. Served by
`gotchibot-api` at `/app/` (same origin). Talks **only** to the Hub API
(`X-GotchiBot-Desk-Token`; wallet nonce/login, pair/claim, whoami, threads,
pull, send, retry, runner, projects, avatars). No React, no Vite build step —
vanilla HTML/CSS/ES modules.

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
| `js/main.js` | Hash router + boot |
| `js/state.js` | Shared app state + navigation (views import this, not `main.js`) |
| `js/ui.js` | Small DOM helpers shared by the views |
| `js/login.js` | Wallet sign-in (primary) + pairing-code view |
| `js/portfolio.js` | Home: project cards, General card, ask bar |
| `js/chat.js` | Project chat: header, history sheet, S2 composer |
| `js/avatar-pane.js` | Crew pane: goal, orchestrators, crew, board |
| `js/settings.js` | Hub status, this device, sign out |
| `js/desk-model.js` | Routes, grouping, kanban bars, labels (pure) |
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
  together (currently `0.4.1`). New JS modules must be listed in the SW
  `SHELL` precache.

## 0.4.1: one chat per project, many sessions

- A project has exactly one chat: its `desk-<slug>` thread. Any `#/p/<slug>/…`
  link resolves there; old per-thread links still open when the Hub has no desk.
- The history sheet and "New chat" are gone from project chats (General keeps
  them). The header's **New session** (+) asks first, then
  `POST /projects/<slug>/desk/session`: fresh agent context, same chat, and
  every device (terminals via `hub desk open --follow`) switches with it.
- `role: "system"` messages render as a centered divider (`.chat-divider`),
  e.g. "New session · started on iPhone".

## 0.4.0: phone desk (verify → cockpit → project → chat)

The terminal desk is the model: sync, verify the owner wallet, land on the
cockpit, pick a project, then enter its chat.

- **Owner-wallet gate** — a phone desk with no verified wallet gets
  `403 { kind: "verify" }` from every desk route except `hub/whoami` and
  `hub/wallet/verify-request` (only while the Hub has an owner wallet). The app
  routes to `#/verify`, which pre-mints a one-time `gbv_…` code
  (`POST /hub/wallet/verify-request`, 15 min) and shows **Verify in MetaMask**
  as a real link (iOS blocks async `window.open`) to
  `metamask.app.link/dapp/<hub>/app/#verify=<code>`. Inside MetaMask the page
  signs the owner nonce and posts `POST /hub/wallet/verify`; the phone polls
  `whoami` (every 2s and on focus) and opens the cockpit when verified. Signing
  in with the wallet directly, or the wallet-browser handoff code, carries the
  wallet, so those phones skip the gate.
- **Cockpit** (`#/` · `#/cockpit`) — root menu in the terminal cockpit's order.
  Header: wallet · cartridge · roster · orchestrator · this phone's project.
  Phone rows: Open desk (current project's chat, or the picker), Switch to
  another project, Hub network, roster, kanban, inbox, Settings. The rest
  (checkpoints, meet, pstack, mint, marketplace, avatar…) are greyed "on desk".
- **Current project** is phone-local (IndexedDB `currentProject`); until you
  pick one it follows the desk's current project.
- **Project picker** (`#/projects`) — the portfolio cards; a tap sets the
  current project and returns to the cockpit. No ask bar / General card.
- **Read-only views** — `#/roster` · `#/kanban` · `#/inbox` · `#/hub` from the
  desk's cockpit snapshot (`GET /api/gotchibot/cockpit`), pushed by
  `gotchibot hub cockpit push` and by the `hub projects watch` service (with
  every project push and every 60s when it changed).
- Chat and Settings back buttons return to the cockpit.

## 0.3.1: shared project desk

- Opening a project (`#/p/<slug>` with no thread) asks `GET /projects/<slug>/desk`
  and lands on the project's `desk-<slug>` thread: one orchestrator conversation
  shared by every paired device and by terminals (`gotchibot hub desk open`).
  Other chats stay in the history sheet, where the desk is pinned first as "Desk".

## 0.3.0: project desk

- **Routes** — `#/login` · `#/pair` (and `#pair=CODE`) · `#/projects` (home until 0.4.0) ·
  `#/p/<slug>[/t/<threadId>]` · `#/settings`. Old `#/threads` and
  `#/thread/<id>` still resolve (General project).
- **Sign-in** — owner wallet via the injected EIP-1193 provider
  (`wallet/nonce` → `personal_sign` → `wallet/login`). Inside a wallet's
  browser, "Sign in the Home Screen app instead" asks for `handoff:true` and shows a
  pairing code to carry over. Pairing code stays as the fallback.
- **Portfolio** — every pstack room from `GET /projects` as a card (heroes,
  kanban progress bar, working count), a General card for untagged chats, and
  an ask bar that starts a General chat.
- **Project chat** — threads filtered by `?project=`; new threads send
  `project` so they land in the right room. History sheet lists that
  project's threads.
- **Crew pane** — `GET /projects/:slug`: goal, orchestrators, crew (gotchi SVG
  from `/avatars/<id>.svg`, else the collateral spirit letter), and the board.

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
