---
name: passoff
description: >-
  Hand live work from one cAavegotchi to another. Use for /passoff, "pass this
  to LINK", "hand off to WBTC", "who was working on this", and at the start of
  any session that inherits work.
---

# Passoff (Cursor)

Load and follow the full protocol:

**Read** [`.opencode/skills/passoff/SKILL.md`](../../../.opencode/skills/passoff/SKILL.md)

Quick path:

```bash
./scripts/gotchibot passoff resume
./scripts/gotchibot passoff send LINK --note "what's done" --next "what's left"
```

Always include `--note` and `--next` when sending. Never invent an agent.
