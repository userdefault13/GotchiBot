---
name: bot-inbox
description: >-
  Internal bot mail for UserDefault and orch — FYI/report/ask/alert without
  AgentMail, passoff, or meet. Use when a desk needs to leave a durable note,
  or when UserDefault says "email me", "notify me", "ping me", "message me
  when ready". There is no personal email for UserDefault — this is the path.
---

# Bot inbox

Internal async mail. **Not** AgentMail. **Not** passoff. **Not** meet.

```bash
./scripts/gotchibot inbox tui            # cockpit / tty list+body
# or: cockpit → Bot inbox

./scripts/gotchibot inbox send --to userdefault --from owned-954 \
  --kind fyi --subject "…" --body "…"
./scripts/gotchibot inbox list --to userdefault --unread
./scripts/gotchibot inbox read <id>
./scripts/gotchibot inbox archive <id>
./scripts/gotchibot inbox digest
```

TUI keys: `j/k` select · `Enter` read · `a` archive · `u` unread-only · `t` cycle to-filter · `q` back.

- `--to userdefault` | `orch` | hero id
- `--kind` `fyi` | `report` | `ask` | `alert`
- Bodies address **UserDefault** only (real names rejected on send)
- Store: `sessions/pstack/<slug>/inbox/` (or `sessions/inbox/` if no project)

## Routing

| User says | Use |
|---|---|
| "email me", "ping me", "notify me", "message me when ready", overnight FYI/report | bot inbox → `--to userdefault` (or `--to orch` for dept reports) |
| External vendor/customer address + courier seated | passoff mail-courier / AgentMail |
| Live round | meet |
| Work handoff | passoff |

## Never

- There is **no personal email for UserDefault** — do not search `USER.md` or the vault for one, and do not open AgentMail to "email Julius".
- Desk mailbox ≠ department email (desk files are local AgentMail mirrors).

Prefer inbox for overnight FYIs; use meet only when UserDefault wants a live round; use passoff for work handoff.
