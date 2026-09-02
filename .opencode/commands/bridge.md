---
description: Bridge — Desk→Hub Claude Code (VS Code pane, terminal fallback)
---

Send a prompt from Desk to Claude Code on the Hub (iMac VS Code).

**Prefer the model path** so the reply is a normal Desk assistant bubble:

```
/model @claudemode
```

(proxy: `./scripts/gotchibot claudemode-proxy`)

If `$ARGUMENTS` is empty, `--check`, or `check`:

```bash
abra run gotchibot -- ./scripts/gotchibot bridge --check
```

Otherwise, for a one-shot CLI (not via `/model`):

```bash
abra run gotchibot -- ./scripts/gotchibot bridge $ARGUMENTS
```

Then **reply as the assistant** with Claude's text only (no "Hub Claude:" prefix,
no System/tool bubble as the final answer). Do not invent the response.
Do not modify theme or color files.
