---
description: List cAavegotchis + local/remote sessions; optional select N to focus avatar
agent: gotchi
---

Prefer **`/switch`** for the same flow (list + switch avatar/chat). `/list` remains for compatibility.

If `$ARGUMENTS` is empty, run:

```bash
abra run gotchibot -- ./scripts/agent-focus.mjs list
```

If `$ARGUMENTS` is a number or an id, prefer switch so direct-chat mode is enabled:

```bash
abra run gotchibot -- ./scripts/agent-focus.mjs switch $ARGUMENTS
```

Fallback without abracadabra: `./scripts/agent-focus.mjs list` / `switch $ARGUMENTS`.

After select/switch, tell the user:
- Avatar pane now shows that gotchi
- Further prompts route with `./scripts/agent-focus.mjs chat "…"` while focus is SUB
- `/orch` returns to the orchestrator

Do not invent agents. Only show what the script prints.
