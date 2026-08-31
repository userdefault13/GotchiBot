---
name: goball-teammate
description: >
  Play GoBall as a GotchiBot teammate in the Aarcade shell. Poll pending invites,
  accept with an available cAavegotchi, read match observations, LLM-decide actions,
  and post them back. Release hero to available when done.
homepage: https://aarcadeghst.com
metadata:
  openclaw:
    requires:
      bins:
        - node
        - curl
      env:
        - AARCADE_API_BASE
        - GOBALL_AGENT_SECRET
        - ABRA_KEY
        - ABRA_PROJECT
    primaryEnv: GOBALL_AGENT_SECRET
---

## Safety

- Never log `GOBALL_AGENT_SECRET` or `COMM_AUTOMATION_SECRET`. Fetch via abra only.
- Only accept invites when hero `status` is `available` or `idle`. Mark `working` on accept; `available` on release.
- LLM returns JSON actions only. Invalid output → `{ "hold": true }`.

## Endpoints

Base: `AARCADE_API_BASE` (default `https://aarcadeghst.com`). Bearer: agent secret.

| Method | Path | Who |
|--------|------|-----|
| GET | `/api/goball-agent/invites` | GotchiBot |
| POST | `/api/goball-agent/accept` | GotchiBot `{ inviteId, heroId }` |
| GET | `/api/goball-agent/observation?seatToken=` | GotchiBot |
| POST | `/api/goball-agent/action` | GotchiBot `{ seatToken, action }` |
| POST | `/api/goball-agent/end` | GotchiBot `{ seatToken }` |
| GET | `/api/goball-agent/roster` | Shell (session) or agent |

## Workflow

1. Player invites from GameViewer (goball) → `POST /invite`.
2. `./scripts/goball-teammate.mjs poll` — list pending invites.
3. `./scripts/goball-teammate.mjs play [--hero <id>]` — accept first invite, LLM loop until match ends.
4. On exit or match end → `release` sets hero `available`.

## Action schema

```json
{ "moveTo": [x, y], "face": [x, y], "passTo": "Home_Field_4", "shoot": true, "punch": true, "dive": true, "hold": true }
```

## Commands

```bash
abra run gotchibot -- ./scripts/goball-teammate.mjs poll
abra run gotchibot -- ./scripts/goball-teammate.mjs play --hero starter-dai-h1-1
abra run gotchibot -- ./scripts/goball-teammate.mjs release --hero starter-dai-h1-1
```

OpenCode: `/goball poll|play|release …`
