---
description: Kanban board — 3-pane clawbot seats, details, logs
---

Open the GotchiBot kanban (opencode-kanban-style layout). Run immediately, do not ask.

```bash
./scripts/gotchi-kanban.mjs $ARGUMENTS
```

If that fails for env/secrets, retry:

```bash
abra run gotchibot -- ./scripts/gotchi-kanban.mjs $ARGUMENTS
```

| UserDefault types | Script |
| --- | --- |
| `/kanban` | interactive 3-pane TUI (tty) |
| `/kanban --once` | plain text dump |
| `/kanban --json` | machine-readable board |
| `/kanban --watch` | plain refresh every 5s |

**Layout:** left = Tasks by Category · top-right = Details · bottom-right = Logs  
**Keys:** `j/k` select/scroll · `PgUp`/`PgDn` page · `Space` collapse · `Tab` pane · `Enter` session · `r` reload · `q` quit

**Cockpit:** `/cockpit` → **Kanban (agents · tasks · seats)**.

Seat cap = cartridge mint count. Chief = `orchestrator`. Charter: `CHARTER.md`.
