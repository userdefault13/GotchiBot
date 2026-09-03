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

```bash
abra run gotchibot -- ./scripts/gotchibot bridge "…"
abra run gotchibot -- node ./scripts/claudemode-ask.mjs "…"
```

## Call (sub-agents / headless / Hub iMac)

**Never wrap in `abra`.** Touch ID / SecKeychain cannot run headless.

```bash
node ./scripts/claudemode-ask.mjs "…"
# or MCP claude_ask
```

On Hub: local `:45678`. On Desk: network Hub bridge (no Touch ID). Desk receiver
`:45679` required for `--wait` replies.

## Then react

1. Read the bridge reply (do not invent it).
2. Continue the task as gotchi on **big-pickle**: spawn, edit, summarize, ask Julius.
3. Call bridge again for follow-up logic in the **same** Claude chat as needed.

## Prerequisites

- Hub: VS Code + `local.gotchibot-bridge` **≥0.0.10** (binds `0.0.0.0:45678`), Claude logged in
- Desk: Tailscale; `config/hub-bridge.json`; receiver on `:45679` (auto-started by ensure/bridge)

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
