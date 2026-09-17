---
name: project-mailbox
description: >-
  Per-desk local mailboxes (inbox + sent) under the project AgentMail. Load
  when a desk checks its own mail, when mail-courier appends a sent message or
  a relayed inbound, or when seating a desk that needs a mailbox.
license: MIT
compatibility: opencode
metadata:
  audience: agents
  workflow: mail
---

# project-mailbox

One AgentMail address per project, but **every desk keeps a local mailbox** so
agents see their own inbox and sent without holding the key. The **mail-courier**
owns AgentMail send/receive and appends to these files — they are a mirror,
never a second AgentMail inbox.

## Paths

| Box | Path |
|-----|------|
| Inbox | `sessions/pstack/<slug>/desks/<heroId>/mailbox/inbox.json` |
| Sent | `sessions/pstack/<slug>/desks/<heroId>/mailbox/sent.json` |

## CLI

```bash
./scripts/project-mailbox.mjs desk ensure <hero>            # create inbox+sent for a desk
./scripts/project-mailbox.mjs desk ensure-roster            # …for every roster hero
./scripts/project-mailbox.mjs desk show <hero> [--json]     # both boxes
./scripts/project-mailbox.mjs inbox <hero> [--json] [--unread]
./scripts/project-mailbox.mjs sent <hero> [--json]
./scripts/project-mailbox.mjs read <hero> <messageId>       # mark inbox message read
./scripts/project-mailbox.mjs digest [--json]               # per-desk counts
./scripts/project-mailbox.mjs append inbox|sent <hero> --from <x> --to <x> --subject "…" [--snippet "…"] [--thread <id>] [--agent-mail-id <id>] [--passoff <id>] [--read]
```

Or: `./scripts/gotchibot project-mailbox …` (aliases `proj-mailbox`, `mailbox`).

## Policy

- **mail-courier** owns AgentMail send/receive; other desks never hold the key.
- After a successful send → courier appends to the owning desk's `sent.json`.
- After relaying inbound → courier appends to the owning desk's `inbox.json`.
- Append is idempotent: a repeated `--agent-mail-id` in the same box is skipped.
- Inbox messages default `unread: true` (pass `--read` to append as read); sent
  messages are never unread.
- `project-kanban desk ensure` also ensures the mailbox for that hero.
- Never invent message ids or delivery; cite the file path in status replies.