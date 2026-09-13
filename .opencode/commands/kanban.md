---
description: Kanban board — clawbot seats, status, assigned tasks
---

Show the GotchiBot kanban (cAavegotchi seats + tasks). Run immediately, do not ask.

```bash
./scripts/gotchi-kanban.mjs $ARGUMENTS
```

If that fails for env/secrets, retry:

```bash
abra run gotchibot -- ./scripts/gotchi-kanban.mjs $ARGUMENTS
```

| Julius types | Script |
| --- | --- |
| `/kanban` | print board once |
| `/kanban --json` | machine-readable board |
| `/kanban --watch` | refresh every 5s |

**Cockpit:** `/cockpit` → **Kanban (agents · tasks · seats)**.

Seat cap = cartridge mint count. Chief = `owned-954`. Charter: `CHARTER.md`.
