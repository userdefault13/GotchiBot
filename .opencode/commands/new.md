---
description: Open a fresh OpenCode session to multitask while current chat is QUEUED/busy (Codex-style)
agent: gotchi
---

When Julius wants to keep working while this session is **QUEUED** / busy (Codex-style parallel chat):

1. Tell them to type **`/new`** (or **`/multitask-session`**).
2. That creates a **new OpenCode session** and switches the TUI to it. The previous session **keeps running** — queued prompts there are not cancelled.
3. Do **not** respawn the tmux chat pane. Do **not** run `opencode-dispatch` for this.
4. Do **not** confuse this with swarm **`gotchi-multitask.mjs`** (parallel cAavegotchi sub-agents). `/new` = another OpenCode chat. `/multitask` script = fan-out workers.

If they ask you to open it for them and you have no TUI slash, say: press `ctrl+p` → “New session (multitask)” or type `/new`.
