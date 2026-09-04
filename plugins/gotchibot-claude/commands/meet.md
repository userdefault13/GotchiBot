---
description: GotchiBot meeting room — status, say, colabo, end
argument-hint: [status | say "…" | colabo "…" | invite <hero> | end]
allowed-tools: Bash(./scripts/gotchibot meet:*), Bash(node scripts/gotchi-meet.mjs:*), Bash(cat sessions/meetings/*)
---

Run this now, do not ask first:

```bash
./scripts/gotchibot meet $ARGUMENTS
```

No arguments → `status` (the open meeting, or none).

| Julius types | Runs |
| --- | --- |
| `/meet` | `status` |
| `/meet say let's recap @LINK` | `say "…"` — `@mentions` pick who answers |
| `/meet colabo "ship or hold?"` | every invited agent answers |
| `/meet invite LINK` / `invite all` | add participants |
| `/meet end` | minutes + handoff |

`say` and `colabo` **wake real agents and spend quota** — they are outward
actions. Run them when Julius asks for them; do not fire one to "check if it
works".

For minutes or a recap of what was said, use `/minutes` (the meet-scribe
subagent) rather than reading the transcript into this session.

Only `gotchi-meet.mjs` drives meeting flow. Do not invent agents or turns.
