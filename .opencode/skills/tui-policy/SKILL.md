---
name: tui-policy
description: >-
  Tab-in-TUI policy for GotchiBot. Load when changing Tab, agent cycle, tmux
  key tables, chat-pane restart, or OpenCode tui.json keybinds. Enforced by
  scripts/tui-policy.mjs + config/tui-policy.json.
license: MIT
compatibility: opencode
metadata:
  audience: everyone
  workflow: tui
---

# TUI policy — Tab cycles in the UI

**Hard rule:** **Tab** cycles OpenCode primary agents **inside the TUI**.
tmux must not steal Tab. Tab must not respawn the chat pane.

That dump (`mode: plan (was verse)` / `chat pane restarted`) is a policy
violation — it is `agent-mode.mjs cycle --restart` via `run-shell`.

## Source of truth

| File | Role |
| --- | --- |
| `config/tui-policy.json` | Policy (keybinds, forbidden tmux steal) |
| `config/tui.json` | Chat pane OpenCode TUI (`OPENCODE_TUI_CONFIG`) |
| `.opencode/tui.json` / `tui.json` | Mirrors |
| `scripts/tui-policy.mjs` | show / enforce / apply |
| `.opencode/tui-plugins/gotchi-agent-sync.ts` | Persist `.agent-mode.json` **without** `--restart` |

```bash
./scripts/gotchibot tui-policy show
./scripts/gotchibot tui-policy enforce
./scripts/gotchibot tui-policy apply
```

## Keybinds

| Action | Key |
| --- | --- |
| Agent cycle | **Tab** (`agent_cycle`) |
| Reverse | **Shift+Tab** |
| File autocomplete | **Ctrl+Space** |
| Hard pane restart (optional) | **F2** |

Cycle order: Gotchi → Sandbox (pink) → Verse → Plan → Build (cyan) → Ask → Project (orange).

## Meet room

Tab is **mention complete** (`@LINK`), not agent-mode. Pane flag
`@gotchibot-meet-room` — never `@gotchibot-chat` while the room is up.

## Do not

- `tmux bind-key -n Tab` → `agent-mode.mjs cycle --restart`
- `agent_cycle: "<leader>tab"` (hides native cycle)
- Respawn chat-pane from `gotchi-agent-sync` on Tab
- Set `GOTCHIBOT_TAB_TMUX=1` to steal Tab (ignored / forbidden)

## Related

Skill **model-policy** — working models only (separate from input).
