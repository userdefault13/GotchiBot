---
description: Shared meeting room — start, invite, say, morning recap, colabo, end
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
| `/meet start --morning` | morning-recap kind |
| `/meet invite LINK` | `invite <n\|id\|name>` |
| `/meet invite all` | `invite all` |
| `/meet morning collect` | wake agents → recaps |
| `/meet morning present` / `next` / `finish` | chair present loop |
| `/meet colabo "…"` | all agents reply |
| `/meet` | `status` |
| `/meet say let's recap @LINK` | `say "…"` |
| `/meet end` | `end` (minutes + handoff.md) |
| `/chat` | leave meet room UI |

**Cockpit menu:** Start meeting → **Meeting** (unchanged) or **Morning recap**
(auto topic `morning meeting` + invite all).

Meet room prompter extras: `/colabo …` · `/recap-next` · `/recap-present`  
(Gallery page next remains `/next` or `.`)

Skills: **morning-recap**, **colabo**. MCP: **gotchibot-meet**.

**Only** use `gotchi-meet.mjs` for meeting flow. Meet **menu** opens **meet-gallery**.
After `/meet end`, orch stays on **big-pickle** and uses Claude as a tool (pane proxy).

Show script stdout to Julius. Do not invent agents. Stay in this TUI.
