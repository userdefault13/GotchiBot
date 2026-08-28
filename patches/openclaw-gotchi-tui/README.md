# GotchiBot OpenClaw TUI patches

Makes the **OpenClaw TUI** feel closer to **OpenCode chat** while keeping the iMac OpenClaw gateway + fleet agents.

## Features

| Patch | What it does |
|-------|----------------|
| **Theme** (`theme.ts`, `opencode-palette.ts`) | Aavegotchi purple + pink accents, violet-tinted surfaces |
| **Chrome** (`gotchi-tui-chrome.ts`, `tui.ts`) | Compact header/footer instead of verbose gateway dump |
| **Scroll** (`tui.ts`, `gotchi-tui-chrome.ts`) | Scrollable message history (wheel + PageUp/Down); fixed prompt at bottom |
| **Collapse** (`gotchi-system-tray.ts`, `tool-execution.ts`) | System tray + hidden tool details by default; `/details` to expand |
| **Slash commands** (`gotchi-commands.ts`, …) | `/orch`, `/list`, `/switch` |

Enabled automatically from `chat-pane.sh`:

```bash
OPENCLAW_THEME=opencode
GOTCHIBOT_TUI_STYLE=opencode
GOTCHIBOT_TUI_TITLE=Gotchi
GOTCHIBOT_TUI_SCROLL=1          # alt-screen scroll layout (default on)
GOTCHIBOT_TUI_MOUSE=1           # mouse wheel in chat history
GOTCHIBOT_TUI_COLLAPSE_SYSTEM=1 # collapse system + tools (default on)
```

## Build

```bash
cd ~/Dev/openclaw && pnpm install   # once
./scripts/openclaw-gotchi-build.sh
```

Respawn the tmux chat pane after building.

## OpenCode fallback path

When the gateway is down, `chat-pane.sh` falls back to native **OpenCode TUI** — that already uses `config/tui.json` with `"theme": "opencode"`.

## Limits

OpenClaw and OpenCode are different TUIs (pi-tui vs OpenCode's). This patch matches **colors + chrome density**, not every OpenCode widget (diff viewer, command palette, etc.). For identical UX with OpenCode only, set `GOTCHIBOT_OPENCLAW=0` (loses OpenClaw fleet agents).

## Mac shortcuts (no F-keys)

| Action | Shortcut |
|--------|----------|
| Back to orchestrator | **Ctrl+O** in chat pane, or **Ctrl+b o** anywhere |
| Slash | `/orch` `/list` `/switch` `/details` (after build) |
