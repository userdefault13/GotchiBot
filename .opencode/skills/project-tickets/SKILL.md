---
name: project-tickets
description: >-
  Thin agent ticketing layer under the project kanban — request/claim/submit/
  accept tickets between heroes; PKM owns lifecycle. Load when a desk requests,
  claims, or submits work to another agent, or when PKM accepts/reworks/closes
  tickets or reports a digest.
license: MIT
compatibility: opencode
metadata:
  audience: agents
  workflow: tickets
---

# project-tickets

Tickets are the **request/submit protocol** between agents. The kanban is the
**board** that shows the work. A ticket links to a kanban card (`cardId`) —
never a second backlog.

## Paths

| Thing | Path |
|-------|------|
| Ticket | `sessions/pstack/<slug>/tickets/<ticketId>.json` |
| Index | `sessions/pstack/<slug>/tickets/index.json` |
| Linked card | `sessions/pstack/<slug>/kanban.json` |

## States

`open → claimed → submitted → accepted | rework → closed`
(`open → closed` cancel; `rework → submitted` resubmit loop).

Card moves when a card exists: request→`todo`, claim→`doing`, submit→`review`,
accept→`done`, rework→`todo`, close→`done`.

## CLI

```bash
./scripts/project-tickets.mjs request --from <hero> --to <hero|role> "title" [--acceptance "…"] [--body "…"] [--card|--no-card] [--project <slug>]
./scripts/project-tickets.mjs claim <id> --by <hero>
./scripts/project-tickets.mjs submit <id> --by <hero> [--note "…"] [--passoff <passoffId>]
./scripts/project-tickets.mjs accept <id> --by <hero> [--note "…"]
./scripts/project-tickets.mjs rework <id> --by <hero> --note "…"
./scripts/project-tickets.mjs close <id> --by <hero> [--note "…"]
./scripts/project-tickets.mjs show <id> [--json]
./scripts/project-tickets.mjs list [--to <hero>] [--from <hero>] [--status <s>] [--json]
./scripts/project-tickets.mjs inbox <hero> [--json]
./scripts/project-tickets.mjs digest [--json]
```

Or: `./scripts/gotchibot project-tickets …`

## Policy

- Any desk requests/claims/submits for its own hero id.
- PKM (kanban-manager) + requester own `accept` / `rework` / `close` / `digest`.
- `submit` must come from the claimer.
- `rework` requires a `--note` (why it bounced).
- `inbox <hero>` = open/claimed/submitted/rework where `to=hero` **or** `claimer=hero`.
- Never invent statuses; cite the ticket id and its card id in replies.