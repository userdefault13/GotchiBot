# gotchibot-api

Self-hosted Hub chat/desk API. Chat bodies stay on **your** Mongo next to this process; Arcade only keeps install metadata (token, `hub.tailscaleHost`, `chatStore.kind`). The Arcade install token never unlocks chat data — desks pair with a one-time code and use `X-GotchiBot-Desk-Token`.

## Run (foreground)

```bash
# defaults: 127.0.0.1:8793, mongodb://127.0.0.1:27017, db GotchiBot
node services/gotchibot-api/server.mjs
```

Or import and start:

```js
import { startApiServer } from "./services/gotchibot-api/server.mjs";
const { close } = await startApiServer();
// … later
await close();
```

## Env vars

| Var | Default | Meaning |
|---|---|---|
| `GOTCHIBOT_API_HOST` | `127.0.0.1` | Bind address |
| `GOTCHIBOT_API_PORT` | `8793` | Bind port |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017` | Mongo connection |
| `MONGO_DB_NAME` | `GotchiBot` | Database name |
| `GOTCHIBOT_HUB_OWNER_LOGIN` | (from config file) | Tailscale login required for non-loopback / proxied requests |
| `GOTCHIBOT_HUB_CONFIG` | `sessions/.hub-api.json` | Install-wizard JSON (`ownerLogin`, host, port, …) |

Env wins over the config file. Prefer binding to loopback and exposing via `tailscale serve`.

## Phone app (`/app/`)

`GET`/`HEAD` `/` redirects `302` to `/app/`. Owner/tailnet-only static PWA served
from [`app/`](./app/) at `/app/`. Same origin as the Hub API; shell only (no React
build). See [`app/README.md`](./app/README.md) and [`app/NOTICE`](./app/NOTICE) for
licensing (Mobilecode-open + jsQR, Apache-2.0).

## Phone send / reply tracking (S2)

- `POST /api/gotchibot/chats/send` — `{ threadId?, clientMessageId?, text, title? }` → creates a thread when `threadId` omitted; stamps phone messages with `originKind:"phone"` and `reply:{status:"pending",…}`.
- `POST /api/gotchibot/chats/retry` — re-queue a phone user message whose `reply.status` is `error` (or stale `claimed`).
- `GET /api/gotchibot/hub/runner` — runner heartbeat (`ok` / `error` / `offline`).
- Phone `push` hardens role/`op`/empty text server-side; desks unchanged. Runner helpers live on the store object (`claimNextPendingReply`, `completeReply`, …) for a later hub-runner process.

## Docs

See [`docs/GOTCHIBOT-API.md`](../../docs/GOTCHIBOT-API.md) (and Hub overview in [`docs/GOTCHIBOT-HUB.md`](../../docs/GOTCHIBOT-HUB.md)).
