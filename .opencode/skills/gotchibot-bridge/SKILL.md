---
name: gotchibot-bridge
description: Desk→Hub Claude Code via OpenCode model @claudemode (or gotchibot bridge CLI)
license: MIT
compatibility: opencode
metadata:
  audience: orchestrator
  workflow: desk-hub
---

# @claudemode (model) — Hub VS Code Claude

`@claudemode` is an **OpenCode model**, not a Tab agent mode.

## Use it

1. Start the Desk proxy (once):

```bash
./scripts/gotchibot claudemode-proxy
# or: node ./scripts/claudemode-proxy.mjs
```

2. In OpenCode Desk chat:

```
/model @claudemode
```

   Also listed as `claudemode/@claudemode`. Alias: `node scripts/model-auto.mjs resolve claudemode`

3. Chat normally — each turn POSTs to Hub VS Code Claude (pane, Terminal fallback)
   and waits for the Desk receiver reply.

## One-shot CLI (no model switch)

```bash
abra run gotchibot -- ./scripts/gotchibot bridge "prompt"
```

## Prerequisites

- Hub: VS Code + `gotchibot-bridge` (claudeUiMode=auto)
- Desk: Tailscale/abra; receiver `:45679`; proxy `:45680`

## Do not

- Treat `@claudemode` as `gotchibot mode …` / Tab cycle (that broke Tab).
- Invent Claude replies.
- Paste secrets into prompts.
- Modify theme files.
