---
description: Shared meeting room — start, invite, say, end (chair-led, in OpenCode)
agent: gotchi
---

Run immediately, do not ask. `$ARGUMENTS` is the meet subcommand.

```bash
./scripts/gotchi-meet.mjs $ARGUMENTS
```

If that fails for env/secrets, retry:

```bash
abra run gotchibot -- ./scripts/gotchi-meet.mjs $ARGUMENTS
```

Empty `$ARGUMENTS` (`/meet`) prints status of the current meeting.

| Julius types | Script |
| --- | --- |
| `/meet start` or `/meet start trader desk` | `start ["topic"]` |
| `/meet invite LINK` | `invite <n\|id\|name>` — same roster as `/switch` |
| `/meet` | `status` |
| `/meet say let's recap @LINK` | `say "…"` — the working turn |
| `/meet end` | `end` (writes minutes, clears current) |

Show the script stdout to Julius (the meeting block). Do not invent agents — only cartridge / OpenClaw ids the script resolves. Stay in this TUI; do not open Discord or a new TUI.
