---
description: List all agents and switch avatar + chat to the selected one
agent: gotchi
---

Switch GotchiBot focus between cAavegotchis / sessions. This pins the avatar and
makes **this chat prompt that agent directly** (SUB focus).

## No argument — list everyone

```bash
abra run gotchibot -- ./scripts/agent-focus.mjs switch
```

If abracadabra is unavailable:

```bash
./scripts/agent-focus.mjs switch
```

Show the numbered list to the user and tell them to run `/switch <n>` or
`/switch <id>` (e.g. `/switch 2` or `/switch starter-link-h1-1`).

## With argument — switch now

`$ARGUMENTS` is a number or id. Run:

```bash
abra run gotchibot -- ./scripts/agent-focus.mjs switch $ARGUMENTS
```

Fallback:

```bash
./scripts/agent-focus.mjs switch $ARGUMENTS
```

After a successful switch:

1. Confirm avatar pinned to that hero and `focus → SUB`.
2. **CRITICAL — direct chat mode:** every following user message in this
   conversation (until `/orch`) MUST be routed with:

   ```bash
   abra run gotchibot -- ./scripts/agent-focus.mjs chat "<exact user message>"
   ```

   Do **not** answer as the orchestrator. Do **not** DIY their task yourself.
   The selected agent runs it (local or iMac per focus host).

3. Remind them: `/orch` returns to the orchestrator avatar + chat.

Selecting the orchestrator hero id restores ORCH focus (same as `/orch`).

Do not invent agents — only what the script prints.
