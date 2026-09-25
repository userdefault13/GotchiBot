# GotchiBot Hub API (self-hosted)

## What it is

`gotchibot-api` runs on **your** Hub next to **your** Mongo. Chat bodies never leave that machine’s database.

Arcade (`www`) keeps metadata only: install token, `hub.tailscaleHost`, `hub.chatStore.kind`. No URIs, no messages.

The Arcade install token (`GOTCHIBOT_INFRA_TOKEN` / `X-GotchiBot-Install-Token`) **never** unlocks chat data. Desks pair with a one-time code and use a desk token (`X-GotchiBot-Desk-Token`).

## Quick start

**On the Hub**

```bash
gotchibot hub install
# → local Mongo (if needed), LaunchAgent/systemd, tailscale serve (tailnet only), first pairing code
```

**On each desk**

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

**Phone visibility.** A phone desk can list/pull only threads where `createdByDeskId` is itself or `sharedWithDeskIds` contains it. Thread list entries for phone callers omit `deskId` (another desk’s id) but include `shared`. Pulling an inaccessible `threadId` returns `404` *thread not found* (no existence leak). Pushing into an existing unshared thread → `403` *thread not shared with this desk*. Creating a new `threadId` owns that thread.

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
| `GOTCHIBOT_DESK_API_BASE` | (from pin) | Desk | Hub API base, e.g. `http://<MagicDNS>:8793` |
| `GOTCHIBOT_DESK_TOKEN` | (from pin) | Desk | Desk token override |
| `GOTCHIBOT_HUB_PIN` | `sessions/.hub.json` | Desk | Absolute path override for the pin file |

Env wins over the Hub config file. Prefer bind `127.0.0.1` and expose with `tailscale serve`.

## Ports

Hub API default bind is **8793**. The live Hub host often runs the API on **8794**. Other features must not default to either port — see the frozen registry in `scripts/lib/ports.mjs` (`RESERVED_HUB_PORTS`, checkpoint sign on 8796, etc.).

## Files

| Path | Where | Notes |
|---|---|---|
| `sessions/.hub-api.json` | Hub | `{ownerLogin, host, port, dbName, mongoUri, tailscaleHost, appUrl?, installedAt}` — mode `0600`, under `sessions/` (gitignored) |
| `sessions/.hub.json` | Desk | Pin: MagicDNS / `deskApiBase` / `deskToken` / pairing fields — mode `0600`, gitignored |

## Routes

JSON in/out. Body limit 2 MB. Unknown route → `404` `{ok:false,error}`. Errors `{ok:false,error}`.

| Method | Path | Auth | Response sketch |
|---|---|---|---|
| `GET`/`HEAD` | `/` | origin (same as `/app/`) | `302` `Location: /app/` — exact pathname `/` only |
| `GET` | `/health` | none | `{ok, service:"gotchibot-api", version, db:"ok"\|"down"}` — never reveals owner, tokens, or URIs |
| `POST` | `/api/gotchibot/hub/pair/claim` | pairing code in body (`kind` optional) | `{ok, deskId, deskToken, name, kind}` |
| `GET` | `/api/gotchibot/hub/whoami` | desk token | `{ok, deskId, name, kind}` |
| `GET` | `/api/gotchibot/hub/desks` | desk token (desk kind only) | `{ok, desks:[{deskId,name,kind,createdAt,lastSeen,revokedAt}]}` — never hashes; phone → `403` |
| `POST` | `/api/gotchibot/chats/push` | desk token | `{ok, threadId, inserted, skipped, lastSeq, results:[…]}` |
| `GET` | `/api/gotchibot/chats/pull?threadId=&after=&limit=` | desk token | `{ok, threadId\|null, messages:[…], nextAfter, hasMore}` — limit default 100, max 500 |
| `GET` | `/api/gotchibot/chats/threads?limit=` | desk token | `{ok, threads:[…]}` sorted `updatedAt` desc |
| `POST` | `/api/gotchibot/chats/snapshot` | desk token (desk kind only) | `{ok, snapshotId, contentHash, stateUri, messageCount, threadIds, upToSeq, createdAt}` — phone → `403` |
| `GET` | `/api/gotchibot/chats/snapshot/:snapshotId` | desk token (desk kind only) | `{ok, snapshotId, contentHash, stateUri, content, createdAt}` — phone → `403` |

Install token alone on a chat/hub route → `401` *install token cannot unlock chat data — pair this desk: gotchibot hub join \<host\> \<code\>*.

## Auth

**Desk tokens.** `gbd_` + base64url(32 random bytes). Hub stores only `sha256` hex as `tokenHash` in `desks` (`deskId` ULID, `name`, `kind` (`desk`\|`phone`, default `desk`), `createdAt`, `lastSeen`, `revokedAt`). Header: `X-GotchiBot-Desk-Token`. Missing/unknown → `401` *desk token required — run: gotchibot hub join \<host\> \<code\>*. Revoked → `401` *desk token revoked*. `lastSeen` updates at most once per minute.

**Pairing codes.** One-time, 8 Crockford base32 chars shown as `XXXX-XXXX`, 15 minutes. Stored as sha256 of normalized code (uppercase, no dash) in `pairing_codes` with optional `kind`. Claim is atomic (`usedAt` null + not expired); kind-mismatch checks run before consume. More than 20 failed claims in 10 minutes → `429`.

**Hub CLI** (talks to Mongo directly when there is no token yet): `hub pair [--kind] [--qr] [--app-url]`, `hub desks`, `hub revoke`, `hub share` / `unshare` / `shares`. Desk: `hub join <host> <code>`.

**Origin.** Direct loopback = socket is `127.0.0.1` / `::1` / `::ffff:127.0.0.1` **and** none of `x-forwarded-for`, `forwarded`, `x-forwarded-host`, `tailscale-user-login`, `tailscale-headers-info`, `tailscale-funnel-request`. Everything else is remote.

- Any `tailscale-funnel-request` → `403` *funnel not allowed*.
- Remote requests must carry `Tailscale-User-Login` equal (case-insensitive, trimmed) to `ownerLogin`. No owner configured → remote rejected `403` (fail closed). Applies to all routes except `/health`, including pair/claim.
- Direct loopback skips the login check but still needs a desk token (or a pairing code for claim).

**Why bind `127.0.0.1`.** Tailscale serve sets `X-Forwarded-For` and strips client-supplied `Tailscale-User-*`. Binding loopback means identity headers only come from the serve proxy. Non-loopback bind logs a loud warning (headers can be spoofed).

## Sync model

- **Append-only** `chat_messages`. Unique `{threadId, messageId}`. Indexes on `{seq}` and `{threadId, seq}`.
- Push is **idempotent**: existing `(threadId, messageId)` → `duplicate` with existing `seq`; else allocate `seq` via `counters` (`_id: "chat_seq"`) and insert. `E11000` race → duplicate (seq gaps are fine).
- `messageId` / ULID-friendly ids: 1–128 of `[A-Za-z0-9_-]`. Max 200 messages per push; text max 32000 chars.
- **Edit / delete** are new tombstone rows (`op: "edit"` with new text / `op: "delete"` with empty text) referencing `targetMessageId` — never mutate or remove old docs.
- **Pull** with `after=<seq>` (cursor). Messages sorted by `seq` ascending.
- **Threads** last-writer-wins on `(updatedAt, deskId)`: apply incoming title only when incoming `updatedAt` is greater, or equal and incoming `deskId` is greater (string compare). Always `$max` `lastSeq` / `lastMessageAt`.

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

**Eight steps + Arcade metadata**

1. **Node** — require ≥18; bake `process.execPath` into the service unit.
2. **Mongo** — probe `127.0.0.1:27017`; optionally start `docker/chat-mongo` (bind loopback only); else Homebrew / distro hints.
3. **Tailscale** — read status for MagicDNS + owner login; `--no-tailscale` → loopback-only (no serve).
4. **Hub config** — write `sessions/.hub-api.json` (mode `0600`).
5. **Service** — macOS LaunchAgent / Linux systemd user unit (see below).
6. **Health** — wait up to 15s for `http://127.0.0.1:PORT/health`.
7. **tailscale serve** — `tailscale serve --bg --http=8793 http://127.0.0.1:8793` (never funnel). Warns if AllowFunnel is on.
8. **First pairing code** — mint only if no active desks; print `gotchibot hub join <MagicDNS> <code>`.

Then **Arcade metadata (optional)**: if `GOTCHIBOT_INFRA_TOKEN` is set, publish `chatStore kind=local`; optionally `hub enable <MagicDNS>` (wallet-signed). Never sends chats.

**What it changes**

| OS | Unit | Log |
|---|---|---|
| macOS | `~/Library/LaunchAgents/com.gotchibot.hub-api.plist` (label `com.gotchibot.hub-api`) | `~/Library/Logs/gotchibot-api.log` |
| Linux | `~/.config/systemd/user/gotchibot-api.service` + `systemctl --user enable --now` + `loginctl enable-linger` | `journalctl --user -u gotchibot-api.service` |

**Undo:** `gotchibot hub uninstall` — stops service + serve; keeps config and chat database.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `NO_HUB_PINNED` | Pin the Hub: `gotchibot hub join` / `hub enable` / `db pin-desk`, or set `GOTCHIBOT_DESK_API_BASE` |
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
