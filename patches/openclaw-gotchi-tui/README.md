# GotchiBot OpenClaw TUI patches

**Default chat (2026-08+):** native **OpenCode TUI** in gotchi mode — routes to the iMac **OpenClaw orchestrator** via `/v1/chat/completions` (`openclaw/orchestrator`). See `scripts/opencode-gotchi-mode.mjs`.

These patches are for the **legacy OpenClaw pi-tui** path (`GOTCHIBOT_OPENCLAW_TUI=1`). They make that TUI feel closer to OpenCode chat while keeping the iMac OpenClaw gateway + fleet agents.

## Features

| Patch | What it does |
|-------|----------------|
| **Theme** (`theme.ts`, `opencode-palette.ts`) | Aavegotchi purple + pink accents, violet-tinted surfaces |
| **Chrome** (`gotchi-tui-chrome.ts`, `tui.ts`) | Compact header/footer instead of verbose gateway dump |
| **Scroll** (`tui.ts`, `gotchi-tui-chrome.ts`) | Scrollable message history (wheel + PageUp/Down); fixed prompt at bottom |
| **Collapse** (`gotchi-system-tray.ts`, `tool-execution.ts`) | System tray + hidden tool details by default; `/details` to expand |
| **Slash commands** (`gotchi-commands.ts`, …) | `/orch`, `/list`, `/switch`, `/cockpit` |

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

## OpenCode gotchi mode (default)

When the gateway is reachable, `chat-pane.sh` launches **OpenCode** with model `openclaw/orchestrator` — your messages hit the iMac OpenClaw orchestrator, which delegates sub-agents. Check status:

```bash
./scripts/gotchibot gotchi-mode status
```

Force local-only orchestrator (no OpenClaw): `GOTCHIBOT_GOTCHI_BACKEND=local`

## Legacy OpenClaw TUI fallback

When the gateway is down, OpenCode falls back to `opencode/hy3-free` locally. To use the patched **OpenClaw TUI** instead of OpenCode:

```bash
GOTCHIBOT_OPENCLAW_TUI=1 ./scripts/chat-pane.sh
```

## Limits

OpenClaw and OpenCode are different TUIs (pi-tui vs OpenCode's). The legacy patch matches **colors + chrome density**, not every OpenCode widget. For identical UX use OpenCode (default). Legacy OpenClaw TUI: `GOTCHIBOT_OPENCLAW_TUI=1`.

## Mac shortcuts (no F-keys)

| Action | Shortcut |
|--------|----------|
| Back to orchestrator | **Ctrl+O** in chat pane, or **Ctrl+b o** anywhere |
| Slash | `/orch` `/list` `/switch` `/cockpit` `/details` (after build) |
