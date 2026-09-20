---
description: Meeting menu — resume/end open meeting, or start a new one
agent: gotchi
---

Open the GotchiBot **meeting menu** in this chat pane (resume / end / start). Run immediately, do not ask, do not run `gotchi-meet status`:

```bash
./scripts/agent-focus.mjs meet
```

That respawns this pane into the meeting menu. If a meeting is already open you get Resume / End / Back. When they leave into the room or back to chat, the desk restores.

For CLI subcommands only when Julius typed them after `/meet` (e.g. `/meet say …`, `/meet end`, `/meet invite all`):

```bash
./scripts/gotchi-meet.mjs $ARGUMENTS
```

Empty `$ARGUMENTS` → **only** `agent-focus meet` above. Never status. Never invent agents.
