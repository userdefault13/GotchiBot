---
description: Bridge — ask Hub VS Code Claude; stay on big-pickle and react
---

**Do not** `/model @claudemode`. Orchestrator stays on **big-pickle**.

If `$ARGUMENTS` is empty, `--check`, or `check`:

```bash
abra run gotchibot -- ./scripts/gotchibot bridge --check
```

Otherwise:

```bash
abra run gotchibot -- node ./scripts/claudemode-ask.mjs $ARGUMENTS
```

or `abra run gotchibot -- ./scripts/gotchibot bridge $ARGUMENTS`.

Use the reply as Claude Code's logic output, then continue the task yourself.
Do not invent the response. Do not modify theme files.
