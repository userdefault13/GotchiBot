---
description: Leave meet room (or restore) OpenCode chat + avatar desk
---

Run immediately, do not ask. Restore the orchestrator desk: OpenCode chat + avatar.

```bash
./scripts/gotchibot chat opencode
```

If that fails (no tmux / wrong cwd):

```bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
./scripts/gotchibot chat opencode
```

What this does:
- If layout is **meet-gallery**, runs `leave-meet-gallery` → Files | Gotchi (OpenCode) | Avatar
- Otherwise respawns chat + avatar panes

In the **meet room** prompter you can also type:
- `/chat` — back to OpenCode chat/avatar (meeting stays open; `/meet open` to rejoin)
- `/end` — end meeting + back to OpenCode chat/avatar

Do not spawn sub-agents for this. Show stdout if useful.
