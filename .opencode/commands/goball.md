---
description: GoBall GotchiBot teammate — poll invites, accept, LLM-play, release
agent: gotchi
---

Run immediately. Do not ask for confirmation.

```bash
abra run gotchibot -- ./scripts/goball-teammate.mjs $ARGUMENTS
```

If abra is unavailable:

```bash
./scripts/goball-teammate.mjs $ARGUMENTS
```

## Subcommands

| Command | Script |
|---------|--------|
| `/goball poll` | `poll [--json]` |
| `/goball play` | `play [--hero id] [--poll-ms N]` |
| `/goball accept INVITE` | `accept INVITE [--hero id]` |
| `/goball release` | `release [--hero id]` |

Player invites from Aarcade GameViewer (goball). Bot polls `/api/goball-agent/invites`, accepts, plays with LLM actions until match ends.
