---
description: Meeting CLI (end / invite / say) — not the menu. Empty /meet uses Ctrl+U or the Meeting menu command.
agent: gotchi
---

Run the GotchiBot meeting CLI with the given args. Do not invent args. If `$ARGUMENTS` is empty, run:

```bash
./scripts/agent-focus.mjs meet
```

Otherwise:

```bash
./scripts/gotchi-meet.mjs $ARGUMENTS
```
