---
name: gotchibot-bridge
description: Stay on big-pickle; call Hub VS Code Claude Code pane for hard logic via gotchibot bridge, then react to the reply
license: MIT
compatibility: opencode
metadata:
  audience: orchestrator
  workflow: desk-hub
---

# @claudemode — Claude Code as a logic tool (not a model switch)

**Stay on `opencode/big-pickle`.** Do **not** run `/model @claudemode` and do **not**
change the OpenCode chat model. The orchestrator keeps executing the task; Claude
Code on the Hub is a **side-channel** for hard logic.

When Julius says **`@claudemode`**, "ask Claude Code", "use the Claude pane", or
you need Hub Claude for reasoning you will then act on:

## Call

```bash
abra run gotchibot -- ./scripts/gotchibot bridge "…"
# thin wrapper (reply-only on stdout):
abra run gotchibot -- node ./scripts/claudemode-ask.mjs "…"
```

That POSTs to Hub VS Code Claude (same pane when `continueSession`), waits for
Desk `:45679`, and prints Claude's text.

## Then react

1. Read the bridge reply (do not invent it).
2. Continue the task as gotchi on **big-pickle**: spawn, edit, summarize, ask Julius.
3. Call bridge again for follow-up logic in the **same** Claude chat as needed.

## Prerequisites

- Hub: VS Code + `local.gotchibot-bridge` (≥0.0.8), Claude logged in
- Desk: Tailscale/abra; receiver on `:45679` (auto-started by bridge if missing)

## Do not

- `/model @claudemode` or leave big-pickle for this path
- Treat `@claudemode` as Tab agent mode
- Invent Claude replies
- Paste secrets into bridge prompts
- Modify theme files
