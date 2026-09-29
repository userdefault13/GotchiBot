# GotchiBot Hub API (self-hosted)

## What it is

`gotchibot-api` runs on **your** Hub next to **your** Mongo. Chat bodies never leave that machine’s database.

Arcade (`www`) knows nothing about your Hub. Desk ↔ Hub is Tailscale only.

The Arcade install token (`GOTCHIBOT_INFRA_TOKEN` / `X-GotchiBot-Install-Token`) **never** unlocks chat data. Desks pair with a one-time code and use a desk token (`X-GotchiBot-Desk-Token`).

## Quick start

**Guided (setup wizard, or `gotchibot hub setup` on each computer)**

- **One computer** — Hub API on loopback, this desk auto-paired to `127.0.0.1`. No Tailscale.
- **Two computers** — both sign into the **same** Tailscale account (free; the first sign-in link creates it). The wizard walks install → sign-in on each. The Hub runs `hub install` and shows a code; the Desk finds the Hub by probing each online tailnet device's MagicDNS name on `:8793–8799/health`, then runs `hub join`. MagicDNS must be on (default) — `tailscale serve` routes by hostname, bare IPs 404.
- `gotchibot hub setup --status [--json]` — Tailscale state, Hub/desk role, reachability.

`hub install` takes `:8793`, or the next free port up to `:8799` when something else holds it (env / saved config win).

**By hand — on the Hub**

```bash
gotchibot hub install
# → local Mongo (if needed), LaunchAgent/systemd, tailscale serve (tailnet only), first pairing code
```

**By hand — on each desk**

```bash
gotchibot hub join <MagicDNS> <code>
# → sessions/.hub.json with deskToken + deskApiBase (mode 0600)
```

**Chat sync** (desk token — no `abra run`, no install token)

```bash
gotchibot chats push --text "hello"
gotchibot chats pull
gotchibot chats threads
gotchibot chats snapshot
gotchibot chats verify <snapshotId|gotchibot-hub://id>
```

Mint more codes on the Hub: `gotchibot hub pair` (optional `--kind phone`, or `--qr` for a phone PWA deep-link QR). List / revoke: `gotchibot hub desks`, `gotchibot hub revoke <deskId>`. Share a thread with a phone desk: `gotchibot hub share <threadId> <deskId>` / `unshare` / `shares`.

## Desk kinds and thread scoping

Two desk kinds:

| Kind | Meaning |
|---|---|
| `desk` (default) | Full Hub access — sees every thread, can list desks and take snapshots |
| `phone` | Scoped — only threads it created or that were shared with it |

Existing desk records with no `kind` field are treated as `desk` everywhere (no migration).

**Pairing.** `hub pair --kind phone` mints a phone code. Claim uses the code’s kind. The claimer may pass `kind:"phone"` to **downgrade** a desk code to a phone desk; upgrading a phone code with `kind:"desk"` fails with `403` *kind mismatch* and **does not** consume the code. Invalid kind → `400`.

**Phone PWA QR.** `gotchibot hub pair --qr` (optional `--app-url URL`) mints a phone code by default (explicit `--kind` still wins) and prints a terminal QR of the deep link `https://<host>/app/#pair=CODE`. Scan it inside the GotchiBot app (Pair → Scan QR), not with the iOS Camera app — or type the code. App base precedence: `--app-url`, then `GOTCHIBOT_HUB_APP_URL`, then `appUrl` in `sessions/.hub-api.json`, else `https://<MagicDNS>/app/` (HTTPS via `tailscale serve --https` once enabled). `--json` includes `pairUrl` (not the QR art).

**Phone visibility.** A phone desk can list/pull only threads where `createdByDeskId` is itself or `sharedWithDeskIds` contains it. Thread list entries for phone callers omit `deskId` (another desk’s id) but include `shared`. Pulling an inaccessible `threadId` returns `404` *thread not found* (no existence leak). Pushing into an existing unshared thread → `403` *thread not shared with this desk*. Creating a new `threadId` owns that thread (race-safe: the phone inserts the thread row before messages).

**Phone write hardening** (server-side in `pushMessages`, not just UI):

- Role forced to `user` (a phone cannot write assistant/system).
- Only `op: "message"` — edit/delete → `403` *phone desks may only push op message*.
- Empty / whitespace-only text → `400` *text required* (32k char cap unchanged).
- Phone-originated user messages are stamped for `hub-runner`:
  - `originKind: "phone"`
  - `reply: { status: "pending"|"claimed"|"replied"|"error", requestedAt, … }`
- Desk (non-phone) pushes are unchanged — no `originKind` / `reply` fields.

**Phone reply UX routes:** `POST /chats/send`, `POST /chats/retry`, `GET /hub/runner` (any paired desk). Pull includes `originKind` + `reply` when present so the PWA can show thinking / error+retry.

### hub-runner

Always-on Hub process (`services/gotchibot-api/runner.mjs`, CLI `scripts/hub-runner.mjs`) that:

1. Preflights `opencode` on `PATH` + at least one provider key in env (same list as desk `colabo`: `NVIDIA_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `OPENCODE_API_KEY`, `OPENCODE_ZEN_API_KEY`) — presence only, never logged.
2. Claims one pending phone user message (`claimNextPendingReply`, stale reclaim ~5 min).
3. Builds short context (`getThreadMessagesForContext`), calls OpenCode the **same way the desk does** (`opencode run -m … --agent hub-reply --dir <scratch> --format json --pure`), with tools denied via an isolated `opencode.json` (not the repo root).
4. Inserts the assistant row with `deskId: "hub-runner"`, then `completeReply` / `failReply`.

**Run (secrets via abracadabra only):**

```bash
abra run gotchibot -- node scripts/hub-runner.mjs
abra run gotchibot -- node scripts/hub-runner.mjs --check
./scripts/gotchibot hub runner [--once|--check]
```

Without abra, `--check` fails with *no provider key in env* (expected). Escape hatch for tests/free models: `GOTCHIBOT_HUB_RUNNER_ALLOW_NO_KEY=1`.

**Model order:** `GOTCHIBOT_HUB_RUNNER_MODEL` → `GOTCHIBOT_OPENCODE_MODEL` / `sessions/.gotchi-model.env` → `completeWithPolicy("chat")`. Limit/402/429 → next candidate.

**Status:** heartbeats into `hub_runner`; `GET /api/gotchibot/hub/runner` returns `ok` / `error` / `offline` (~90s). Preflight errors do **not** claim work.

**systemd (Linux Hub):** template `services/gotchibot-api/systemd/gotchibot-hub-runner.service` — `ExecStart=@ABRA@ run -p gotchibot -- @NODE@ @REPO@/scripts/hub-runner.mjs`.

**Phone-forbidden routes** (`403` *not allowed for phone desks*): `GET /hub/desks`, `POST /chats/snapshot`, `GET /chats/snapshot/:id`.

**Hub CLI (Mongo-local, like revoke):**

```bash
gotchibot hub pair [--name NAME] [--kind desk|phone] [--qr] [--app-url URL] [--json]
gotchibot hub share <threadId> <deskId>
gotchibot hub unshare <threadId> <deskId>
gotchibot hub shares <threadId>
```

## Run by hand

```bash
gotchibot api start          # foreground
gotchibot api start --bg     # background + pidfile
gotchibot api stop           # only stops a pidfile we started
gotchibot api status [--json]

node services/gotchibot-api/server.mjs
# logs: gotchibot-api listening on http://HOST:PORT (db NAME)
```

Prefer the install wizard’s service unit for always-on. Manual start is for debug.

## Env vars

| Var | Default | Side | Meaning |
|---|---|---|---|
| `GOTCHIBOT_API_HOST` | `127.0.0.1` | Hub | Bind address |
| `GOTCHIBOT_API_PORT` | `8793` | Hub | Bind port |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017` | Hub | Mongo connection |
| `MONGO_DB_NAME` | `GotchiBot` | Hub | Database name |
| `GOTCHIBOT_HUB_OWNER_LOGIN` | (from config file) | Hub | Tailscale login required for non-loopback / proxied requests |
| `GOTCHIBOT_HUB_CONFIG` | `sessions/.hub-api.json` | Hub | Install-wizard JSON path |
| `GOTCHIBOT_HUB_APP_URL` | (from config `appUrl`) | Hub | PWA base for `hub pair --qr` deep links (else `https://<MagicDNS>/app/`) |
| `GOTCHIBOT_HUB_OWNER_WALLET` | (from config `ownerWallet`, else `sessions/.wallet.json`) | Hub | Only address allowed to use phone wallet sign-in |
| `CAST_BIN` | `~/.foundry/bin/cast`, then `cast` on PATH | Hub | Foundry binary for wallet signature checks |
| `GOTCHIBOT_HUB_RUNNER_MODEL` | (unset) | Hub | Prefer this model in hub-runner before the desk pin |
| `GOTCHIBOT_OPENCODE_MODEL` | (from `sessions/.gotchi-model.env`) | Hub | Desk chat pin reused by hub-runner |
| `GOTCHIBOT_HUB_RUNNER_TIMEOUT_MS` | `120000` | Hub | Per opencode call timeout |
| `GOTCHIBOT_HUB_RUNNER_ALLOW_NO_KEY` | (unset) | Hub | `1` skips provider-key preflight (tests / free models only) |
| `GOTCHIBOT_OPENCODE_URL` | `http://127.0.0.1:4096` (config `opencodeUrl`) | Hub | OpenCode server holding the project desk sessions |
| `GOTCHIBOT_OPENCODE_PORT` | `4096` | Hub | Port `hub desk service install` puts in the units |
| `GOTCHIBOT_DESK_AGENT` | `gotchi` | Hub | OpenCode agent that answers desk turns |
| `GOTCHIBOT_HUB_SSH` | (from `sessions/.hub-desk.json`) | Desk | `user@host` for `hub desk open` over Tailscale SSH |
| `GOTCHIBOT_DESK_API_BASE` | (from pin) | Desk | Hub API base, e.g. `http://<MagicDNS>:8793` |
| `GOTCHIBOT_DESK_TOKEN` | (from pin) | Desk | Desk token override |
| `GOTCHIBOT_HUB_PIN` | `sessions/.hub.json` | Desk | Absolute path override for the pin file |

Env wins over the Hub config file. Prefer bind `127.0.0.1` and expose with `tailscale serve`.

## Ports

Hub API default bind is **8793**. The live Hub host often runs the API on **8794**. Other features must not default to either port — see the frozen registry in `scripts/lib/ports.mjs` (`RESERVED_HUB_PORTS`, checkpoint sign on 8796, etc.).

## Files

| Path | Where | Notes |
|---|---|---|
| `sessions/.hub-api.json` | Hub | `{ownerLogin, host, port, dbName, mongoUri, tailscaleHost, appUrl?, ownerWallet?, installedAt}` — mode `0600`, under `sessions/` (gitignored) |
| `sessions/.hub.json` | Desk | Pin: MagicDNS / `deskApiBase` / `deskToken` / pairing fields — mode `0600`, gitignored |

## Routes

JSON in/out. Body limit 2 MB. Unknown route → `404` `{ok:false,error}`. Errors `{ok:false,error}`.

| Method | Path | Auth | Response sketch |
|---|---|---|---|
| `GET`/`HEAD` | `/` | origin (same as `/app/`) | `302` `Location: /app/` — exact pathname `/` only |
| `GET` | `/health` | none | `{ok, service:"gotchibot-api", version, db:"ok"\|"down"}` — never reveals owner, tokens, or URIs |
| `POST` | `/api/gotchibot/hub/pair/claim` | pairing code in body (`kind` optional) | `{ok, deskId, deskToken, name, kind}` |
| `POST` | `/api/gotchibot/hub/wallet/nonce` | origin only | `{ok, nonce, message, expiresAt}` — one-time message for the owner wallet to `personal_sign` (5 min); no owner wallet → `503` |
| `POST` | `/api/gotchibot/hub/wallet/login` | signed nonce in body | body `{address, signature, nonce, name?, handoff?}` → `{ok, deskId, deskToken, name, kind:"phone", walletAddress}`; with `handoff:true` → `{ok, handoff:{code, expiresAt}}` (phone pairing code instead of a token). Expired nonce `401`, wrong wallet `403`, bad signature `401` |
| `GET` | `/api/gotchibot/hub/whoami` | desk token | `{ok, deskId, name, kind, walletAddress, verifyRequired}` (`walletAddress` null until the phone signs in with or verifies the owner wallet; `verifyRequired` true for such a phone while the Hub has an owner wallet) |
| `POST` | `/api/gotchibot/hub/wallet/verify-request` | desk token (unverified phones allowed) | `{ok, verified:false, code:"gbv_…", expiresAt}` — one-time verify link code (15 min, stored hashed); already verified → `{ok, verified:true, walletAddress}`; no owner wallet → `503` |
| `POST` | `/api/gotchibot/hub/wallet/verify` | verify code + signed nonce in body | body `{code, address, signature, nonce}` → `{ok, verified:true}`; binds the owner wallet to the phone that minted `code`. Expired nonce / bad signature / used or expired code `401`, wrong wallet `403`, desk revoked `404`, no owner `503`; shares the `429` limit |
| `POST` | `/api/gotchibot/cockpit/push` | desk token (desk kind only) | body = cockpit snapshot (see *Cockpit snapshot*) → `{ok, pushedAt}`; unknown fields dropped, > 256 KB → `400`; phone → `403` |
| `GET` | `/api/gotchibot/cockpit` | desk token | `{ok, pushedAt, cockpit}` (`null`s before the first push) |
| `GET` | `/api/gotchibot/hub/desks` | desk token (desk kind only) | `{ok, desks:[{deskId,name,kind,createdAt,lastSeen,revokedAt}]}` — never hashes; phone → `403` |
| `GET` | `/api/gotchibot/hub/runner` | desk token | `{ok, runner:{status:"ok"\|"error"\|"offline", detail, model?, lastBeatAt}}` — offline if no beat or `lastBeatAt` older than ~90s; `detail` never holds secrets |
| `POST` | `/api/gotchibot/chats/push` | desk token | `{ok, threadId, inserted, skipped, lastSeq, results:[…]}` — phone hardening above |
| `POST` | `/api/gotchibot/chats/send` | desk token | body `{threadId?, clientMessageId?, text, title?, project?}` → `{ok, threadId, project?, messageId, seq, reply:{status}}` — creates thread (ULID) when `threadId` omitted; `project` (pstack slug) tags only a new thread, invalid slug → `400`; uses `pushMessages` |
| `POST` | `/api/gotchibot/chats/retry` | desk token | body `{threadId, messageId}` — resets phone `reply.status` to `pending` when `error` or stale `claimed` (>~5m); inaccessible → `404` |
| `GET` | `/api/gotchibot/chats/pull?threadId=&after=&limit=` | desk token | `{ok, threadId\|null, messages:[…], nextAfter, hasMore}` — messages may include `originKind` + `reply`; limit default 100, max 500 |
| `GET` | `/api/gotchibot/chats/threads?limit=&project=` | desk token | `{ok, threads:[…]}` sorted `updatedAt` desc; each thread has `project` (slug or null). `project=<slug>` filters to that project, `project=none` to untagged threads |
| `POST` | `/api/gotchibot/projects/push` | desk token (desk kind only) | body `{files:[{path, text, mtime?}], heroNames?}` → `{ok, pushedAt, files, projects}` — replaces the stored portfolio snapshot; paths are whitelisted (see *Project snapshots*), bad path / oversize → `400`; phone → `403` |
| `GET` | `/api/gotchibot/projects` | desk token | `{ok, projects:[{slug, title, goal, playbook, status, current, heroCount, kanban, units, updatedAt, accent, working, heroes:[…≤5]}]}` — read-only view of `sessions/pstack/<slug>/` (pushed snapshot first, then the Hub's disk); current project first, then newest; `*smoke*` rooms hidden |
| `GET` | `/api/gotchibot/projects/:slug/desk` | desk token | `{ok, project, threadId:"desk-<slug>", title, sessionStartedAt}`; desk kind also gets `{sessionId, repoDir, opencodeUrl}`, and `?session=1` creates the OpenCode session if missing (`sessionError` when the server is down). Unknown slug → `404` |
| `GET` | `/api/gotchibot/projects/:slug/desk/events` | desk token (not phones) | Server-sent events: `event: desk` with `{sessionId, sessionStartedAt}` on connect and whenever the project's current session moves. `: ping` heartbeat every 25s, which also ends the stream for a revoked token and picks up moves made by the desk runner. Phone → `403`; unknown slug → `404` |
| `POST` | `/api/gotchibot/projects/:slug/desk/session` | desk token (phones too) | New session in the project's chat → `{ok, project, threadId, sessionId, startedAt}` plus a `session-<id>` divider message. Body `{sessionId}` adopts an existing top-level OpenCode session instead (adds `resumed`); desk tokens may name the device with `{device}`. Unknown slug → `404`; bad id → `400`; sub-agent session → `400`; another project's session → `409`; OpenCode down → `503` |
| `GET` | `/api/gotchibot/projects/:slug` | desk token | `{ok, project:{…summary, scope, roster:[…], cards:[…≤60]}}`; unknown slug → `404` |
| `GET` | `/api/gotchibot/avatars/:heroId.svg` | desk token | `image/svg+xml` from `sessions/.avatars/<heroId>.svg` (JSON-escaped caches are unescaped); missing or not an SVG → `404` |
| `POST` | `/api/gotchibot/chats/snapshot` | desk token (desk kind only) | `{ok, snapshotId, contentHash, stateUri, messageCount, threadIds, upToSeq, createdAt}` — phone → `403` |
| `GET` | `/api/gotchibot/chats/snapshot/:snapshotId` | desk token (desk kind only) | `{ok, snapshotId, contentHash, stateUri, content, createdAt}` — phone → `403` |

Install token alone on a chat/hub route → `401` *install token cannot unlock chat data — pair this desk: gotchibot hub join \<host\> \<code\>*.

## Auth

**Desk tokens.** `gbd_` + base64url(32 random bytes). Hub stores only `sha256` hex as `tokenHash` in `desks` (`deskId` ULID, `name`, `kind` (`desk`\|`phone`, default `desk`), `createdAt`, `lastSeen`, `revokedAt`). Header: `X-GotchiBot-Desk-Token`. Missing/unknown → `401` *desk token required — run: gotchibot hub join \<host\> \<code\>*. Revoked → `401` *desk token revoked*. `lastSeen` updates at most once per minute.

**Pairing codes.** One-time, 8 Crockford base32 chars shown as `XXXX-XXXX`, 15 minutes. Stored as sha256 of normalized code (uppercase, no dash) in `pairing_codes` with optional `kind`. Claim is atomic (`usedAt` null + not expired); kind-mismatch checks run before consume. More than 20 failed claims in 10 minutes → `429`.

**Wallet sign-in** (phone app). EIP-191 `personal_sign` over the message from `wallet/nonce` (`GotchiBot Hub sign-in` / `Host` / `Nonce` / `Issued`), verified with Foundry `cast wallet verify` — no npm crypto deps. Nonces live in `wallet_nonces` (TTL 5 min) and are consumed atomically, so each signature works once. Only the owner wallet may sign in: `ownerWallet` in config (or `GOTCHIBOT_HUB_OWNER_WALLET`), else the Hub's `sessions/.wallet.json`; neither → `503`. Success mints a `phone` desk with `walletAddress`, or a pairing code when `handoff:true` (sign in inside the wallet's browser, finish pairing in the home-screen app); the handoff code carries the wallet to the desk it creates. Failed sign-ins share the pair/claim `429` limit.

**Owner-wallet gate** (phones). While the Hub has an owner wallet, a `phone` desk without `walletAddress` (paired by code, or paired before the gate) gets `403 {ok:false, kind:"verify"}` on every desk route except `hub/whoami` and `hub/wallet/verify-request`. The app shows *Verify in MetaMask*: it mints a `gbv_` code, opens `https://metamask.app.link/dapp/<hub>/app/#verify=<code>`, the owner signs a fresh nonce inside MetaMask, and `hub/wallet/verify` binds the wallet to the phone that minted the code (`walletVerifiedAt`). Codes live hashed in `wallet_verify_codes` (TTL 15 min) and are consumed atomically. Terminal desks (`kind: "desk"`) are never gated.

**Hub CLI** (talks to Mongo directly when there is no token yet): `hub pair [--kind] [--qr] [--app-url]`, `hub desks`, `hub revoke`, `hub share` / `unshare` / `shares`. Desk: `hub join <host> <code>`.

**Origin.** Direct loopback = socket is `127.0.0.1` / `::1` / `::ffff:127.0.0.1` **and** none of `x-forwarded-for`, `forwarded`, `x-forwarded-host`, `tailscale-user-login`, `tailscale-headers-info`, `tailscale-funnel-request`. Everything else is remote.

- Any `tailscale-funnel-request` → `403` *funnel not allowed*.
- Remote requests must carry `Tailscale-User-Login` equal (case-insensitive, trimmed) to `ownerLogin`. No owner configured → remote rejected `403` (fail closed). Applies to all routes except `/health`, including pair/claim.
- Direct loopback skips the login check but still needs a desk token (or a pairing code for claim).

**Why bind `127.0.0.1`.** Tailscale serve sets `X-Forwarded-For` and strips client-supplied `Tailscale-User-*`. Binding loopback means identity headers only come from the serve proxy. Non-loopback bind logs a loud warning (headers can be spoofed).

## Sync model

- **Append-only** `chat_messages`. Unique `{threadId, messageId}`. Indexes on `{seq}`, `{threadId, seq}`, and claim index `{originKind, reply.status, reply.requestedAt, seq}`.
- Push is **idempotent**: existing `(threadId, messageId)` → `duplicate` with existing `seq`; else allocate `seq` via `counters` (`_id: "chat_seq"`) and insert. `E11000` race → duplicate (seq gaps are fine).
- `messageId` / ULID-friendly ids: 1–128 of `[A-Za-z0-9_-]`. Max 200 messages per push; text max 32000 chars.
- **Edit / delete** are new tombstone rows (`op: "edit"` with new text / `op: "delete"` with empty text) referencing `targetMessageId` — never mutate or remove old docs. Phones cannot push edit/delete.
- **Phone reply tracking** (phone user messages only): `originKind:"phone"`, `reply.status` lifecycle `pending` → `claimed` → `replied` | `error`. Store helpers used by hub-runner: `claimNextPendingReply`, `getThreadMessagesForContext`, `completeReply`, `failReply`, `writeRunnerHeartbeat` / `getRunnerStatus` (`hub_runner` collection). Assistant replies are inserted via `pushMessages` with deskId `hub-runner` (trusted non-phone writer).
- **Pull** with `after=<seq>` (cursor). Messages sorted by `seq` ascending.
- **Threads** last-writer-wins on `(updatedAt, deskId)`: apply incoming title only when incoming `updatedAt` is greater, or equal and incoming `deskId` is greater (string compare). Always `$max` `lastSeq` / `lastMessageAt`.

## Project snapshots

pstack rooms, hero caches and avatars live on the **desk**, so the phone portfolio would be empty on a Hub that doesn't run pstack itself. The desk pushes the exact files the project view reads and the Hub renders them with the same code (`services/gotchibot-api/projects.mjs`).

- **Desk:** `gotchibot hub projects push [--force] [--dry-run] [--json]` — skips when the content hash matches the last push (`sessions/.hub-projects-push.json`).
- **Event-driven:** `gotchibot hub projects watch` watches `sessions/pstack/` (recursive), `sessions/.avatars/`, the top-level `sessions/` state files and `config/agent-roles.json` — FSEvents on macOS, inotify on Linux (Node ≥ 20). Only whitelisted files count (ledgers, inboxes, notes don't); a burst of edits becomes one push ~2s later; a failed push retries with backoff (30s → 5 min). Pushes once (forced) on start.
- **Keep it running:** `gotchibot hub projects service install | uninstall | status` — macOS LaunchAgent `com.gotchibot.hub-projects-watch` (`KeepAlive`, logs in `sessions/hub-projects-push-logs/`), or Linux systemd user unit `gotchibot-hub-projects-watch.service` (`Restart=always`, logs in `journalctl --user`).
- **Whitelist:** `sessions/pstack/<slug>/{dossier.json,overview.md,status.md,roster.json,kanban.json}`, `sessions/.pstack-dossier-current`, `sessions/.project-current`, `sessions/.hero-agent-state.json`, `config/agent-roles.json`, `sessions/.avatars/<heroId>.svg` (roster heroes only). Anything else → `400`. Max 2000 files, 256 KB each, 2 MB body. `heroNames` (`{heroId: name}`) carries desk-side display names.
- **Hub:** one Mongo doc (`project_snapshot`, `_id: "current"`), replaced per push, cached in memory. Reads prefer the snapshot, then the Hub's own disk, so Hub-local rooms still appear.

## Cockpit snapshot

The phone app's root menu mirrors the terminal cockpit, so the desk pushes what that menu shows (`services/gotchibot-api/cockpit.mjs`).

- **Desk:** `gotchibot hub cockpit push [--force] [--dry-run] [--json]` collects from the desk's own sources (`agent-focus list --json`, `gotchi-kanban --json`, `bot-inbox`, `hub-network`, `sessions/.onboarding.json`, the current project); no abra. The `hub projects watch` service pushes it after every project push and every 60s, skipping when the content hash (minus `collectedAt`) matches `cockpitHash` in `sessions/.hub-projects-push.json`.
- **Shape (allow-list):** `collectedAt`, `header {wallet, cartridgeId, cartridgeChain, orchestrator{id,name,collateral}, rosterCount, project, deskName}`, `roster {heroes, local, remoteOk, remoteReason, agents[≤200]{id,name,host,kind,status,collateral,task}}`, `kanban {seatsTotal, seatsUsed, seatsFree, columns[≤12]{key,title,cards[≤60]{id,name,status,collateral,host,role,task,age,chief,stale}}}`, `inbox {project, unread, messages[≤50]{id,from,to,kind,subject,body≤500,ts,read}}`, `hub {deskPaired, hubInstalled, hubHost, deskName}`. Strings are trimmed and length-capped; anything else is dropped.
- **Hub:** one Mongo doc (`cockpit_snapshot`, `_id: "current"`), replaced per push.

## Project desks

Each project has one chat that every device shares: the phone, the MBP, the iMacs. The agent runs on the Hub. The chat holds many **sessions**; a session is a fresh agent context, and the chat keeps every session's turns.

- **Sessions:** each is an OpenCode session on the Hub's `opencode serve` (loopback, `GOTCHIBOT_OPENCODE_URL`, default `http://127.0.0.1:4096`), agent `gotchi` (`GOTCHIBOT_DESK_AGENT`), working in the Hub's checkout, with the orchestrator's tools and memory. Mongo `desk_sessions` (`_id` = slug) keeps `sessions[]` (`sessionId`, `startedAt`, `startedBy`, `lastMirroredId`, `lastActiveAt`) plus the current `sessionId`. Docs from before sessions migrate on first write. Two callers creating the first session at once get the same one; the loser deletes its copy.
- **New session:** `POST /api/gotchibot/projects/:slug/desk/session` (any paired desk or phone; `404` unknown project, `503` when the Hub's OpenCode is down) creates a session, makes it current, and posts a divider into the thread (`role: "system"`, `messageId: session-<id>`, "New session · started on <device>"). Returns `{ threadId, sessionId, startedAt }`. `GET /projects/:slug/desk` reports `sessionStartedAt`. Terminal: `gotchibot hub desk new [slug]`, or just OpenCode's `/new` in an attached terminal.
- **Adopt:** the same route with `{ "sessionId": "ses_…", "device": "Mac desk" }` makes a session the terminal opened itself current. A session new to the chat gets the `session-<id>` divider; switching back to an earlier one posts "Switched session · on <device>" and keeps that session's mirror cursor. Sub-agent child sessions (`parentID`) are refused with `400`, sessions owned by another project with `409`.
- **Thread:** `desk-<slug>` (`kind: "desk"`), created by the Hub on first open and visible to every paired desk and phone. Phones can't create `desk-*` threads themselves (`403`).
- **Phone turns:** messages a phone sends in a desk thread are stamped `threadKind: "desk"`. hub-runner skips them and the desk runner (`services/gotchibot-api/desk-runner.mjs`, `gotchibot hub desk run`) claims them instead. It posts each one to the project session with a phone-context system note, waits up to 10 min (on timeout it aborts the turn and fails the reply), then completes the reply.
- **Mirror:** every ~5s the desk runner copies finished turns into the thread under their OpenCode message ids, so re-mirroring is idempotent. It walks the current session plus any session active in the last 24h, each with its own cursor, so a turn that finishes after a New session still lands. A deleted old session just stops syncing. That covers prompts typed at a terminal and every assistant reply. User turns whose text the phone already wrote are skipped.
- **Terminals:** `gotchibot hub desk open [slug] [--ssh user@hub] [--follow]` asks the Hub for the current session (`?session=1`) and runs `opencode attach` on it: directly on the Hub, over Tailscale SSH from anywhere else. Save the SSH target once with `gotchibot hub desk ssh user@hub` (kept in `sessions/.hub-desk.json`). `--follow` hands the attached TUI `GOTCHIBOT_DESK_SLUG` / `GOTCHIBOT_DESK_DEVICE`; the `gotchi-desk-sync` TUI plugin then syncs both ways, event-driven (no polling): a route change in the terminal (`/new` + first message, or a session switch) is adopted by the Hub (the phone shows the divider), and the plugin holds `GET /projects/:slug/desk/events` open so a New session from the phone moves the terminal to it immediately, without reattaching. The stream reconnects with backoff (1s → 30s). The plugin authenticates with the Hub pin in `sessions/.hub.json` **on the machine running the TUI** — on the Hub itself, pair it to itself once (`gotchibot hub pair` then `gotchibot hub join 127.0.0.1:8794 <code>`). The device label is `Mac desk` / `Linux desk` (never the hostname); set `GOTCHIBOT_DESK_LABEL` to change it. Exit codes: `3` Hub or its OpenCode unreachable, `4` no SSH target. The OpenCode server never listens on the network.
- **Desk chat pane:** with agent `gotchi`, a paired Hub (`sessions/.hub.json`) and a current project, the Gotchi pane runs `hub desk open <project> --follow` (border ` Gotchi · <project> (Hub) `). If that fails it prints the reason and falls back to local OpenCode (border ` Gotchi (offline · local, not synced) `). `GOTCHIBOT_HUB_DESK=0` always stays local.
- **Services (Linux Hub):** `gotchibot hub desk service install | uninstall | status` renders `systemd/gotchibot-opencode.service` (`abra run -p gotchibot -- opencode serve`, reusing hub-runner's drop-ins) and `systemd/gotchibot-desk-runner.service`.

## Checkpoint snapshots

Stored **only** in Hub Mongo (`chat_snapshots`, unique `snapshotId`).

- `content` = `{v:1, kind:"gotchibot-chat-snapshot", createdAt, gitCommit, gitBranch, upToSeq, threads:[…]}` with threads sorted by `threadId` and messages by `seq`.
- `contentHash` = `0x` + sha256 hex of **canonical JSON** (keys sorted recursively, drop undefined, `Date` → ISO, no whitespace, reject non-finite numbers) — 32 bytes = on-chain `bytes32` stateHash.
- `snapshotId` = ULID. `stateUri` = `gotchibot-hub://<snapshotId>` — opaque, **never** a URL or hostname (stateUri goes on chain publicly).
- Canonical JSON over 12 MB → `413` *snapshot too large — pass threadIds*.
- Schemes in `scripts/chat-state-uri.mjs`: `gotchibot-hub` supported; `ipfs` reserved (`supported:false`) for future encrypted IPFS. `isPublicSafeStateUri` rejects `http(s)`, `.ts.net`, `100.x`, and hostnames.

**Verify / on-chain**

```bash
gotchibot chats verify <snapshotId|gotchibot-hub://id> [--expect 0xHASH] [--onchain] [--json]
gotchibot chats checkpoint-prompt          # TTY after commit, or anytime
gotchibot chats checkpoint-prompt --onchain
gotchibot chats onchain                    # broadcast only (pin already written)
gotchibot chats hook install|uninstall|status
```

Flow: Hub snapshot → desk `identity checkpoint` with `gameState.chatSync` → optional MetaMask / cast `checkpointSave` on Base Sepolia. Pin: `sessions/.chat-sync-checkpoint.json`. Skip one commit: `GOTCHIBOT_CHAT_CHECKPOINT=0 git commit …`.

## Install wizard

```bash
gotchibot hub install [--dry-run] [--yes] [--name NAME] [--no-tailscale]
gotchibot hub uninstall [--dry-run]
gotchibot hub install --uninstall   # alias
```

**Eight steps**

1. **Node** — require ≥18; bake `process.execPath` into the service unit.
2. **Mongo** — probe `127.0.0.1:27017`; optionally start `docker/chat-mongo` (bind loopback only); else Homebrew / distro hints.
3. **Tailscale** — read status for MagicDNS + owner login; `--no-tailscale` → loopback-only (no serve).
4. **Hub config** — write `sessions/.hub-api.json` (mode `0600`).
5. **Service** — macOS LaunchAgent / Linux systemd user unit (see below).
6. **Health** — wait up to 15s for `http://127.0.0.1:PORT/health`.
7. **tailscale serve** — `tailscale serve --bg --http=8793 http://127.0.0.1:8793` (never funnel). Warns if AllowFunnel is on.
8. **First pairing code** — mint only if no active desks; print `gotchibot hub join <MagicDNS> <code>`.

Nothing is sent to Arcade: the Hub and its chat store stay on your network.

**What it changes**

| OS | Unit | Log |
|---|---|---|
| macOS | `~/Library/LaunchAgents/com.gotchibot.hub-api.plist` (label `com.gotchibot.hub-api`) | `~/Library/Logs/gotchibot-api.log` |
| Linux | `~/.config/systemd/user/gotchibot-api.service` + `systemctl --user enable --now` + `loginctl enable-linger` | `journalctl --user -u gotchibot-api.service` |

**Undo:** `gotchibot hub uninstall` — stops service + serve; keeps config and chat database.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `NO_HUB_PINNED` | Pin the Hub: `gotchibot hub join` / `db pin-desk`, or set `GOTCHIBOT_DESK_API_BASE` |
| `NO_DESK_TOKEN` | Pair: Hub `gotchibot hub pair`, desk `gotchibot hub join <MagicDNS> <code>` |
| `401` desk token revoked | Mint a new code and re-join; old token stays revoked |
| `403` login mismatch / owner not configured | Remote request’s `Tailscale-User-Login` must match `GOTCHIBOT_HUB_OWNER_LOGIN` / `.hub-api.json`; set owner or use direct loopback |
| `403` funnel not allowed | Turn funnel off: `tailscale funnel --http=8793 off` — we never enable funnel |
| Port busy | Free `:8793` or change `GOTCHIBOT_API_PORT`; conflicting serve: `tailscale serve --http=8793 off` |
| LaunchAgent uses old Node | nvm/path is baked at install time — re-run `gotchibot hub install` after changing Node |
| Install token on chat routes | Expected `401` — install token is Arcade-only; pair the desk |

## Code map

| Path | Role |
|---|---|
| `services/gotchibot-api/{config,store,auth,server}.mjs` | Hub API |
| `scripts/chat-canonical.mjs` | Canonical JSON, `contentHashOf`, ULID |
| `scripts/chat-state-uri.mjs` | `gotchibot-hub://` + reserved `ipfs://` |
| `scripts/chat-hub-client.mjs` | Desk HTTP client |
| `scripts/chat-sync.mjs` | `gotchibot chats …` |
| `scripts/hub-install.mjs` | Install / uninstall wizard |
| `scripts/hub-pair.mjs` | pair / join / desks / revoke / share / unshare / shares |
| `scripts/gotchibot-api.mjs` | `gotchibot api start\|stop\|status` |

Also: [GOTCHIBOT-HUB.md](./GOTCHIBOT-HUB.md) (Hub checklist), short package README at `services/gotchibot-api/README.md`.
