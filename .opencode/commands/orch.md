---
description: Return avatar + chat focus to the GotchiBot orchestrator
---

Restore orchestrator focus (clear SUB focus, pin orchestrator cAavegotchi).
Does **not** restart the chat pane. Optional: `orch --respawn` / `--restart` for a
full OpenCode reload. `--no-respawn` / `--no-restart` are no-ops.

From **Sub** mode, also Tab to **gotchi** (or `./scripts/gotchibot mode gotchi`) if you
want the full orchestrator desk, not only ORCH chat focus.

```bash
./scripts/agent-focus.mjs orch
```

Confirm focus is ORCH and the avatar is the orchestrator hero.
Subsequent messages are orchestrator again (delegate-pick → spawn/merge as usual).
Do not call select/respawn from chat paths.
