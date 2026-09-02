---
description: Ask Hub Claude Code pane for logic (orchestrator stays on big-pickle)
---

**Do not** `/model @claudemode`. Stay on **big-pickle**.

If `$ARGUMENTS` is empty, `--check`, or `check`:

```bash
abra run gotchibot -- ./scripts/gotchibot bridge --check
```

Otherwise ask Hub Claude and then **continue the task** using the reply:

```bash
abra run gotchibot -- node ./scripts/claudemode-ask.mjs $ARGUMENTS
```

Fallback: `abra run gotchibot -- ./scripts/gotchibot bridge $ARGUMENTS`

Read stdout as Claude's answer. Do not invent it. Act on it (spawn, edit, summarize).
Do not switch OpenCode models. Do not modify theme files.
