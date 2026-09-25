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

## Docs

See [`docs/GOTCHIBOT-API.md`](../../docs/GOTCHIBOT-API.md) (and Hub overview in [`docs/GOTCHIBOT-HUB.md`](../../docs/GOTCHIBOT-HUB.md)).
