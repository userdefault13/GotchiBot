---
description: List all agents and switch avatar + chat to the selected one
---

Switch GotchiBot focus between cAavegotchis / sessions. Pins the avatar and sets
**SUB focus** so later messages go to that OpenClaw agent. Does **not** restart
the chat pane.

Best in **Sub** mode (`./scripts/gotchibot mode sub` / cyan Tab) — desk for the
roster **excluding** orch. From Gotchi mode, `/switch` still works; orch hero
selection restores ORCH.

## No argument — list everyone

```bash
abra run gotchibot -- ./scripts/agent-focus.mjs switch
```

Fallback: `./scripts/agent-focus.mjs switch`

Show the numbered list; tell Julius to run `/switch <n>` or `/switch <id>`
(e.g. `/switch LINK` or `/switch starter-link-h1-1`).

## With argument — switch now

`$ARGUMENTS` is a number or id:

```bash
abra run gotchibot -- ./scripts/agent-focus.mjs switch $ARGUMENTS
```

Fallback: `./scripts/agent-focus.mjs switch $ARGUMENTS`

**Pane stay-alive:** no OpenCode restart. Optional `--respawn` / `--restart` only
if Julius needs a full reload. `--no-respawn` / `--no-restart` are no-ops.

After a successful switch:

1. Confirm avatar pinned + `focus → SUB`.
2. OpenClaw agent id = hero id.
3. **CRITICAL — every following user message until `/orch`:**

   ```bash
   ./scripts/agent-focus.mjs chat --sub "<exact user message>"
   ```

   OpenClaw HTTP/CLI only. Do **not** spawn `opencode-dispatch`, `gotchi-orchestrate`,
   or Task `@LINK` for chit-chat. If OpenClaw fails, surface the error — do not DIY.
   Escape hatch (rare): `chat --dispatch "…"` or `GOTCHIBOT_SUB_CHAT_DISPATCH=1`.

4. Remind: `/orch` returns to the orchestrator.

Selecting the orchestrator hero id restores ORCH (same as `/orch`).

Do not invent agents — only what the script prints.
Prefer `/switch` over `/list` (same roster; `/list` is legacy alias).
