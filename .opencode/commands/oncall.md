---
description: Ask the on-call advisor (GLM 5.3 via OpenCode Go) a bounded question
---

Do not switch OpenCode models — the advisor is a tool call.

If `$ARGUMENTS` is empty, `status`, or `check`:

```bash
./scripts/gotchibot oncall status
```

Otherwise ask the advisor and then **continue the task** using the reply:

```bash
abra run gotchibot -- ./scripts/gotchibot oncall $ARGUMENTS
```

Read stdout as the advisor's answer. Do not invent it. The advisor is read-only
(no edits, no spawns); real work still goes through a work tool — Cursor first,
then Codex, then Claude.
