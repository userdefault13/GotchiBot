# Project kanban (tasks) vs seat kanban (fleet)

| Board | Script | Purpose |
|-------|--------|---------|
| **Seat kanban** | `./scripts/gotchi-kanban.mjs` | Clawbot seats / status (`/kanban`) |
| **Project kanban** | `./scripts/project-kanban.mjs` | Sealed-project **tasks** + desk minis |
| **Project tickets** | `./scripts/project-tickets.mjs` | Agent request/claim/submit protocol — tickets link to cards (see `docs/PROJECT-TICKETS.md`) |

## Layout

- Main: `sessions/pstack/<slug>/kanban.json`
- Desk mini: `sessions/pstack/<slug>/desks/<heroId>/kanban.json`
- Columns: `backlog` · `todo` · `doing` · `review` · `done`

## Desk pack

```bash
# install is free (no hero). apply needs an available gotchi on your cartridge roster.
gotchibot templates install kanban-manager
gotchibot templates apply kanban-manager --hero <available> --yes
# apply gate: roster + available + starter one-crew; --force overrides with WARNING
```

Skill: `project-kanban`. Every other desk keeps a mini via `desk ensure` / AGENTS.common.

```bash
./scripts/gotchibot project-kanban show
./scripts/gotchibot project-kanban desk ensure owned-12444
./scripts/gotchibot project-kanban sync
```
