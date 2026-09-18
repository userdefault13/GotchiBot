---
name: bot-inbox
description: >-
  Internal bot mail for UserDefault and orch — FYI/report/ask/alert without
  AgentMail, passoff, or meet. Use when a desk needs to leave a durable note.
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

Prefer inbox for overnight FYIs; use meet only when UserDefault wants a live round; use passoff for work handoff.
