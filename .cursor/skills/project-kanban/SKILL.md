---
name: project-kanban
description: >-
  Headless project + desk mini kanban boards. Load when managing cards on the
  sealed project board, syncing desk minis, or seating the kanban-manager desk.
license: MIT
compatibility: opencode
metadata:
  audience: agents
  workflow: kanban
---

# project-kanban

Sealed projects keep a **main** task board and every desk keeps a **mini**
headless board. The **kanban-manager** desk owns the main board and sync.

Fleet seats TUI (`./scripts/gotchi-kanban.mjs`) is **not** this — that tracks
clawbot seats/status.

## Paths

| Board | Path |
|-------|------|
| Main | `sessions/pstack/<slug>/kanban.json` |
| Desk mini | `sessions/pstack/<slug>/desks/<heroId>/kanban.json` |

Columns: `backlog` · `todo` · `doing` · `review` · `done`

## CLI

```bash
./scripts/project-kanban.mjs show [--json]
./scripts/project-kanban.mjs desk ensure <hero>
./scripts/project-kanban.mjs desk show <hero> [--json]
./scripts/project-kanban.mjs add "title" [--column todo] [--owner <hero>] [--desk <hero>]
./scripts/project-kanban.mjs move <cardId> <column> [--desk <hero>]
./scripts/project-kanban.mjs sync          # desk minis → main
./scripts/project-kanban.mjs pull <hero>   # main → that desk mini
```

Or: `./scripts/gotchibot project-kanban …`

## Policy

- One main board per project.
- Every desk should have a mini (`desk ensure` on seat / roster add).
- Manager runs `sync` to roll desk work into the main board.
- Never invent card moves; cite the file path in status replies.
