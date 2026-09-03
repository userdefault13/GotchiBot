---
name: gotchibot-bridge
description: Stay on big-pickle; call Hub VS Code Claude Code pane for hard logic via gotchibot bridge, then react to the reply
license: MIT
compatibility: opencode
metadata:
  audience: orchestrator
  workflow: desk-hub
---

# @claudemode — Claude Code as a logic tool (not a model switch)

**Stay on `opencode/big-pickle`.** Do **not** run `/model @claudemode` and do **not**
change the OpenCode chat model. The orchestrator keeps executing the task; Claude
Code on the Hub is a **side-channel** for hard logic.

When Julius says **`@claudemode`**, "ask Claude Code", "use the Claude pane", or
you need Hub Claude for reasoning you will then act on:

## HARD RULE — UI path (do not reason; copy this)

**Fixed policy (extension enforces it):**

1. Open **VS Code Claude pane** (`anthropic.claude-code` via `claude-vscode.*`).
2. If pane cannot open → **Claude Terminal** fallback.
3. **Also** run headless `claude -p` so Desk gets text (`claude_collect` / receiver).

| Setting | Required value |
| --- | --- |
| `gotchibotBridge.showInClaudeUi` | `true` |
| `gotchibotBridge.claudeUiMode` | `auto` (pane → terminal) |
| `gotchibotBridge.runHeadlessCli` | `true` |

`local.gotchibot-bridge` + `anthropic.claude-code` = **one pipeline**, not two competing chats.

**Forbidden answers (never say these):**
- “There is no chat — it’s headless only.”
- “The Anthropic extension conflicts with the bridge.”
- “You won’t see anything in VS Code by design.”

**If Julius says the pane looks empty but Desk got a reply:** say UI paste/submit may have failed while headless succeeded → `GotchiBot Bridge: Show Log` / MCP `hub_bridge_ensure`. Do not invent a new architecture.

**New / cold Claude pane:** always run proxy init first (skill **claude-pane-proxy**):

```bash
abra run gotchibot -- ./scripts/gotchibot claude-pane-init
# or MCP hub_claude_pane_init
```

That installs `CLAUDE.md` + `.claude/agents/gotchibot-proxy.md` and prefixes `reports_to`.

## Where config lives (memorize — do not search)

Weak models keep hunting for a `globalStorage/local.gotchibot-bridge/` folder.
**There is NO such folder.** The extension uses `context.globalState`, not
`globalStorageUri` files. Config actually lives in two places:

| What | Where |
| --- | --- |
| listenHost / listenPort / settings | User settings keys `gotchibotBridge.*` in `~/Library/Application Support/Code/User/settings.json` |
| Session id / globalState (`gotchibotBridge.cliSessionId`) | SQLite `~/Library/Application Support/Code/User/globalStorage/state.vscdb` (ItemTable keys match `%gotchi%`) |
| Extension code | `~/.vscode/extensions/local.gotchibot-bridge-*` |
| Live endpoints | Hub bridge HTTP `:45678` /health; Desk receiver `:45679` |
| Non-secret Desk config | GotchiBot `config/hub-bridge.json` |

Do not search for a `globalStorage/local.gotchibot-bridge/` directory — it does
not exist. To dump the real paths/keys, call MCP `hub_bridge_info` or:

```bash
abra run gotchibot -- ./scripts/gotchibot hub bridge-info
# or: node ./scripts/hub-bridge-info.mjs --json
```

## Call (orchestrator / interactive Desk)

Desks on Tailscale/LAN **always** hit the Hub bridge (`config/hub-bridge.json` →
`http://juliuss-imac-2:45678/prompt`), then SSH fallback. Never a local Claude.

### Async (preferred for long Claude work — no orch wait/poll)

```bash
# or MCP claude_submit → continue other work → on wake MCP claude_collect
abra run gotchibot -- ./scripts/gotchibot claude-submit "…"
# later:
./scripts/gotchibot claude-collect <id>
```

States: `pending` (Hub accepted) → `ready`/`failed` (Desk `POST /result` push-wake) → `collected`.
Jobs live in `var/claude-jobs/<id>.json`. Receiver spawns `claude-job-wake.mjs` which **injects the Claude reply into the OpenCode Desk chat** (and `sessions/claude-inbox.jsonl`). macOS Script Editor notifications are **off** by default (`GOTCHIBOT_RECEIVER_NOTIFY=1` to opt in). OpenClaw chat inject is opt-in (`GOTCHIBOT_CLAUDE_WAKE_OPENCLAW=1`) because it burns model quota. **Do not poll.**

### Sync (short prompts only)

```bash
abra run gotchibot -- ./scripts/gotchibot claude-ask "…"
# or MCP claude_ask / bridge --wait
```

## Call (sub-agents / headless / Hub iMac)

**Never wrap in `abra`.** Touch ID / SecKeychain cannot run headless.

```bash
node ./scripts/claudemode-submit.mjs "…"   # prefer
node ./scripts/claude-jobs.mjs collect <id>
# sync short only:
node ./scripts/claudemode-ask.mjs "…"
```

On Hub: local `:45678`. On Desk: network Hub bridge (no Touch ID). Desk receiver
`:45679` required for replies (push-wake + collect).

## Then react

1. Prefer **submit** → keep working → **collect** on wake (do not invent the reply).
2. Continue as gotchi on **big-pickle**: spawn, edit, summarize, ask Julius.
3. Follow-ups can reuse the same Hub Claude session (`continueSession`).

## Prerequisites

- Hub: VS Code + `local.gotchibot-bridge` **≥0.0.11** (binds `0.0.0.0:45678`; resolves `~/.local/bin/claude`), Claude logged in
- Desk: Tailscale; `config/hub-bridge.json`; receiver on `:45679` with wake hook (**restart receiver after pull** so notify-off + chat inject load)
- If Desk still gets UI-only / empty CLI replies: set `gotchibotBridge.claudeCommand` to `~/.local/bin/claude`, Restart Server

## If bridge is down / workspace not open

**First call the one-shot ensure** (weak-model safe) — it checks the Desk
receiver `:45679`, probes the Hub bridge `:45678`, opens VS Code, and restarts
the bridge server if needed:

```bash
abra run gotchibot -- ./scripts/gotchibot hub bridge-ensure
# or MCP hub_bridge_ensure
```

Then **retry** `claude-ask` / `bridge`. If it still fails, tell Julius to check
the **Hub** VS Code: Reload Window, enable `gotchibot-bridge`, sign into Claude.

### Desk receiver vs Hub bridge (memorize)

| Endpoint | What | Where |
| --- | --- | --- |
| Hub bridge `:45678` | VS Code extension serving Claude prompts | Hub (iMac), `0.0.0.0:45678` |
| Desk receiver `:45679` | collects the Claude reply on the Desk | Desk (MBP), auto-started by bridge |

`bridge --wait` needs **both**: the Hub bridge to accept the prompt and the Desk
receiver to collect the reply. `bridge-ensure` brings up both.

### Manual fallback (if ensure is unavailable)

```bash
abra run gotchibot -- ./scripts/gotchibot vscode-open
# or: abra run gotchibot -- ./scripts/gotchibot vscode-open --check
```

Then retry `claude-ask` / `bridge`. First launch of VS Code may need the bridge
extension enabled once; after that `vscode-open` is enough.

## Do not

- `/model @claudemode` or leave big-pickle for this path
- Treat `@claudemode` as Tab agent mode
- Invent Claude replies
- Paste secrets into bridge prompts
- Modify theme files
- Tell Julius only “open the folder manually” without trying `hub bridge-ensure` / `hub_bridge_ensure` first
