---
description: Return avatar + chat focus to the GotchiBot orchestrator
agent: gotchi
---

Restore orchestrator focus (clear sub-agent focus, pin orchestrator cAavegotchi):

```bash
./scripts/agent-focus.mjs orch
```

Confirm to the user that focus is ORCH again and the avatar is the orchestrator hero.
If they were chatting as a sub-agent, subsequent messages are orchestrator again (spawn/merge as usual).
