# Project tickets (agent request/submit protocol) vs kanban (the board)

Tickets are the **thin request/claim/submit layer** between agents. The kanban
is the **board** that shows the work. A ticket links to a kanban card
(`cardId`) — there is **no second backlog**.

| Layer | Script | Purpose |
|-------|--------|---------|
| **Project tickets** | `./scripts/project-tickets.mjs` | Agent → agent request/claim/submit/accept; PKM owns lifecycle |
| **Project kanban** | `./scripts/project-kanban.mjs` | Sealed-project **tasks** board + desk minis |
| **Passoff** | `./scripts/gotchibot passoff …` | Hand live work + context to another gotchi (ticket may carry `passoffId`) |

## Layout

- Tickets: `sessions/pstack/<slug>/tickets/<ticketId>.json`
- Index: `sessions/pstack/<slug>/tickets/index.json` (rewritten on every mutation)
- Card: `sessions/pstack/<slug>/kanban.json` (same board as project-kanban)

## States

```
open → claimed → submitted → accepted | rework → closed
```

- `open → closed` = cancel (no card needed).
- `rework → submitted` = the fix loop (resubmit after rework).
- `rework → closed` / `claimed → closed` / `submitted → closed` = abandon/withdraw.

## Card moves (only when a card exists)

| Ticket status | Card column |
|---------------|-------------|
| request (with `--card`) | `todo` (owner = `to`) |
| claimed | `doing` |
| submitted | `review` |
| accepted | `done` |
| rework | `todo` |
| closed | `done` |

## CLI

```bash
./scripts/gotchibot project-tickets request --from owned-954 --to starter-link-h1-1 "Fix the login flow" \
    --acceptance "login works in sim" --body "see passoff p…" --card
./scripts/gotchibot project-tickets claim t… --by starter-link-h1-1
./scripts/gotchibot project-tickets submit t… --by starter-link-h1-1 --note "done" --passoff p…
./scripts/gotchibot project-tickets accept t… --by owned-954 --note "verified"
./scripts/gotchibot project-tickets rework t… --by owned-954 --note "edge case missing"
./scripts/gotchibot project-tickets close t… --by owned-954 --note "cancel"
./scripts/gotchibot project-tickets show t… [--json]
./scripts/gotchibot project-tickets list [--to <hero>] [--from <hero>] [--status <s>] [--json]
./scripts/gotchibot project-tickets inbox <hero> [--json]
./scripts/gotchibot project-tickets digest [--json]
```

Add `--project <slug>` to any command to target a specific sealed project.

## Who does what

- Any desk: `request` (to a hero or a role), `claim`, `submit` for its own hero id.
- **PKM (kanban-manager)** + requester: `accept`, `rework`, `close`, `digest`.
- `inbox <hero>` = open/claimed/submitted/rework where `to=hero` **or** `claimer=hero`.
- `digest` = counts by status — PKM/orch status line.

## Desk pack

```bash
gotchibot templates install kanban-manager   # free, no hero
gotchibot templates apply kanban-manager --hero <available> --yes   # apply gate
```

Skills: `project-kanban` (board) + `project-tickets` (request/submit protocol).