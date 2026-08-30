---
description: Resume the last OpenCode chat session
agent: gotchi
---

Reopen the last OpenCode session in this chat pane. Run immediately, do not ask:

```bash
GOTCHIBOT_OPENCODE_CONTINUE=1 ./scripts/agent-focus.mjs cockpit >/dev/null 2>&1 || true
tmux respawn-pane -t "${GOTCHIBOT_TMUX_SESSION:-gotchibot}:work.1" -k "cd \"$(pwd)\" && GOTCHIBOT_SKIP_COCKPIT=1 GOTCHIBOT_OPENCODE_CONTINUE=1 exec ./scripts/chat-pane.sh"
```

That is `opencode --continue`. Confirm the previous session is back. For a fresh chat, say so instead of running this.
