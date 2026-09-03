---
name: hub-sop
description: Hub (iMac) standard operating procedures — OpenClaw gateway down, restart remotely, VS Code/Claude bridge, tunnel, status. Load when OC✗, gateway-unreachable, or Julius asks to restart Hub/OpenClaw.
license: MIT
compatibility: opencode
metadata:
  audience: orchestrator
  workflow: hub-ops
---

# Hub SOP (iMac always-on)

**You are a weak model-friendly runbook.** Do **not** invent SSH one-liners.
Always use `abra run gotchibot -- …` from Desk (MBP). Secrets stay in abracadabra.

## Topology (memorize)

| Role | Machine | Notes |
| --- | --- | --- |
| Desk | MBP | Julius chats here; OpenCode TUI |
| Hub | iMac (`juliuss-imac-2`) | OpenClaw gateway `:18789`, Docker, VS Code Claude bridge `:45678` |
| Tunnel | Cloudflare | `subgraph.aarcadeghst.com` |

Bar line: `OC✗` = OpenClaw gateway unreachable. `tun✓`/`tun✗` = subgraph tunnel. `dk N↓` = unhealthy Docker.

## Decision table (symptom → command)

| Symptom | First command | Then |
| --- | --- | --- |
| `OC✗` / `gateway-unreachable` / gotchi fell back to local | `abra run gotchibot -- ./scripts/gotchibot hub restart-gateway` | `abra run gotchibot -- ./scripts/gotchibot hub status` |
| Need Hub dashboard | `abra run gotchibot -- ./scripts/gotchibot hub` | — |
| Claude bridge down / connection refused / pane missing | `abra run gotchibot -- ./scripts/gotchibot hub bridge-ensure` (or MCP `hub_bridge_ensure`) | Then retry `claude_submit` / `claude_ask` |
| Julius says “no chat in VS Code” / headless-only confusion | Load **gotchibot-bridge** HARD RULE: pane → terminal → + headless for Desk. Never invent architecture | `GotchiBot Bridge: Show Log` if UI empty but Desk got reply |
| New Claude pane / create-agent / Claude has no GotchiBot role | `abra run gotchibot -- ./scripts/gotchibot claude-pane-init` (or MCP `hub_claude_pane_init`) | Load skill **claude-pane-proxy** |
| Where is bridge config / globalStorage? | `abra run gotchibot -- ./scripts/gotchibot hub bridge-info` (or MCP `hub_bridge_info`) | There is NO `globalStorage/local.gotchibot-bridge/` folder — config is `settings.json` + `state.vscdb` |
| Ask Hub Claude | MCP `claude_ask` or `abra run gotchibot -- ./scripts/gotchibot claude-ask "…"` | Stay on big-pickle |
| Subgraph / tunnel down | `abra run gotchibot -- ./scripts/gotchibot tunnel status` | `… tunnel restart` |
| Unhealthy Docker (monolith/proxy) | Load skill **infra-recover** | Do not recreate volumes |
| Sync code to Hub | `abra run gotchibot -- ./scripts/gotchibot remote-push` | — |
| Desk says agents running but Hub Claude pane idle | `./scripts/gotchibot hub dashboard` then `bridge-ensure` | Tiled board: `./scripts/gotchibot hub monitor --force` → `tmux attach -t gotchibot-hubmon` |
| Full OpenClaw redeploy | `abra run gotchibot -- ./scripts/gotchibot remote-openclaw` | Heavy; prefer `restart-gateway` first |
| Hub totally unreachable (SSH itself down, not just the gateway) | `abra run gotchibot -- ./scripts/gotchibot hub status --json` (look for `"ssh":{"ok":false}`) | Nothing else in this SOP can run without SSH — every command here goes over `abra run gotchibot -- …`. Tell Julius: check the iMac is powered on and Tailscale is connected. Do not attempt `restart-gateway` / `bridge-ensure` / `doctor` until SSH is back |

## Hub dashboard (OpenClaw + VS Code bridge)

```bash
./scripts/gotchibot hub dashboard          # OC gateway + bridge + receiver tiles
./scripts/gotchibot hub status             # full Hub · SSH/OC/bridge/docker bar
./scripts/gotchibot hub monitor --force    # recreate tiled tmux gotchibot-hubmon
tmux attach -t gotchibot-hubmon
```

Tiles always include **OPENCLAW GATEWAY** and **VS CODE BRIDGE** so Desk
"running" status cannot hide a dead Hub.

## Agent truth board (tiled tmux — not chat layout)

Desk OpenCode can show agents “running” while Hub Claude panes never receive
prompts. When Julius reports empty Hub Claude UI:

```bash
./scripts/gotchibot hub dashboard
abra run gotchibot -- ./scripts/gotchibot hub bridge-ensure   # if bridge ✗
abra run gotchibot -- ./scripts/gotchibot hub restart-gateway # if OC✗
```

This is a **separate** tmux session from the gotchibot chat/avatar layout.

## Restart OpenClaw gateway (exact)

```bash
abra run gotchibot -- ./scripts/gotchibot hub restart-gateway
# equivalent:
abra run gotchibot -- node ./scripts/hub-ops.mjs restart-gateway --wait
```

What it does on Hub:
1. Patches plugins (enable `slack` + `opencode-go` with capability consent; disable stock `opencode` / `perplexity` that block ready).
2. `docker compose … up -d --force-recreate openclaw-gateway` in `~/Dev/openclaw`.
3. Waits for `http://127.0.0.1:18789/healthz`, then Desk re-checks Tailscale reachability.

Doctor only (no restart):

```bash
abra run gotchibot -- node ./scripts/hub-ops.mjs doctor --json
```

## Claude bridge down (exact)

When `claude_ask` / `bridge` fails with **connection refused** or the Desk
receiver `:45679` / Hub bridge `:45678` is down, run the one-shot recovery
(weak-model safe — it checks the receiver, probes the Hub bridge, opens VS Code,
and restarts the bridge server):

```bash
abra run gotchibot -- ./scripts/gotchibot hub bridge-ensure
# or MCP hub_bridge_ensure
```

What it does:
1. Checks Desk receiver `:45679` — starts it if missing.
2. Probes Hub bridge `:45678` (network HTTP). If up → done.
3. If down → opens/focuses Hub VS Code on GotchiBot.
4. If still down → SSH `restart-bridge` (code --command gotchibotBridge.restart + wait).
5. Re-probes. Exit 0 if up; else prints next steps.

If it still fails, tell Julius to check the **Hub** VS Code:
- Reload Window (Command Palette → "Developer: Reload Window")
- Enable the `gotchibot-bridge` extension (Extensions panel)
- Sign into Claude (Claude pane visible)

## Plugin capability consent fix (first-class)

The gateway crash-loops refusing to report ready with:
`Plugin "opencode" requires capability consent` and
`Plugin "perplexity" requires capability consent`. `restart-gateway` already
does this fix — run it first:

```bash
abra run gotchibot -- ./scripts/gotchibot hub restart-gateway
```

If you must fix the plugin config by hand (or restart-gateway did not clear
the consent error), this is exactly what `fix_plugins()` in
`hub-ops-remote.sh` does — reproduce it step by step. The script is
**idempotent** — safe to run multiple times.

1. **Quarantine orphan npm plugin trees** that force capability consent and
   block ready. Move them out of the live tree so OpenClaw stops loading
   them. These are specific known orphans with hex suffixes:

   ```bash
   mkdir -p ~/.openclaw/npm/projects-disabled
   mv ~/.openclaw/npm/projects/openclaw-opencode-provider-641bb4636d ~/.openclaw/npm/projects-disabled/ 2>/dev/null || true
   mv ~/.openclaw/npm/projects/openclaw-perplexity-plugin-9e59921123 ~/.openclaw/npm/projects-disabled/ 2>/dev/null || true
   ```

   The `2>/dev/null || true` suppresses errors when a source directory does
   not exist — this is expected after a clean install or prior quarantine.
   Safe to run even if `~/.openclaw/npm/projects/` itself is missing.

2. **Repair `~/.openclaw/openclaw.json`** (host path — mounted into the
   container). `fix_plugins()` does **not** take its own backup before
   patching — it only restores from `.bak` or `.last-good` (whichever
   exists) as a first step, and only if the current JSON fails to parse.
   It then **merges** these fields into the existing file — it does not
   rewrite the whole file, so `agents`, `channels`, `mcp`, and every other
   top-level key are left untouched:

   ```jsonc
   {
     "gateway": {
       "mode": "local",
       "bind": "lan",
       "http": {
         "endpoints": {
           "chatCompletions": { "enabled": true },
           "responses":       { "enabled": true }
         }
       }
     },
     "plugins": {
       "allow": ["slack", "opencode-go"],
       "entries": {
         "slack":        { "enabled": true },
         "opencode-go":  { "enabled": true }
         // entries.opencode and entries.perplexity are DELETED
       }
     }
   }
   ```

   ⚠️ **This is a partial shape, not the whole file.** If you are editing
   by hand, merge these fields into the existing JSON — do not replace the
   file with just this snippet, or you will delete `agents`, `channels`,
   `mcp`, and everything else already configured. Ensure `gateway.mode`,
   `gateway.bind`, the HTTP endpoints, and the plugin block are all
   present; leave the rest of the file as-is. **Do not edit this file
   inside the container** — it is a host mount and edits inside are lost
   on recreate.

3. **Recreate the gateway container** and wait for health:

   ```bash
   abra run gotchibot -- ./scripts/gotchibot hub restart-gateway
   ```

`openclaw-repair-config.mjs` is a **different, heavier** repair — it does
back up to `.bak-repair-{timestamp}` first, but it also rewrites
`agents.defaults` / `agents.entries` (via `$include`), adds an
`mcp.servers.gotchibot-claude` entry, and deletes `channels.whatsapp` /
`messages`. It encodes the same plugin policy (`allow:
["slack","opencode-go"]`, drops `opencode`/`perplexity`/`whatsapp`) but
**do not run it just to clear a plugin-consent error** — it is for a full
config-schema migration, not this fix. `restart-gateway` / `fix_plugins()`
above is the right tool for this SOP.

## Diagnosing a crash-loop

A crash-loop = the container keeps restarting and `healthz` never goes green.
Work top-down, exact commands, all from Desk via abra:

1. **Read the logs** — hub-ops prints the last lines on failure, or:

   ```bash
   abra run gotchibot -- node ./scripts/hub-ops.mjs doctor --json
   ```

   Look for `Plugin "…" requires capability consent` → do the
   **Plugin capability consent fix** above.

2. **The openclaw CLI is NOT on PATH inside the container.** The binary is
   `/app/openclaw.mjs` and the container command is `node /app/openclaw.mjs`.
   The repair subcommand is **`doctor --fix`** — **not** `openclaw update
   repair` (that is the wrong command here). From the Hub shell, find the
   container name dynamically (it is not always `openclaw-openclaw-gateway-1`):

   ```bash
   # Find the gateway container name:
   C=$(docker ps -a --filter name=openclaw.*gateway --format '{{.Names}}' | head -1)
   docker exec "$C" node /app/openclaw.mjs doctor --fix --non-interactive --json
   ```

   `--non-interactive` and `--json` are not strictly required (doctor
   already skips prompts when stdin isn't a TTY, which a plain `docker
   exec` never is), but pass them anyway — cheap insurance against a hang,
   and `--json` gives you a parseable result instead of prose.

    (Run this on the Hub, not from Desk — the container is only reachable on
    the iMac. If you only have Desk access, prefer `restart-gateway`.)
    `doctor --fix` patches `openclaw.json` (plugins + gateway.mode) and
    restarts the container. It is the CLI equivalent of steps 1–3 above.

3. **Config lives at `~/.openclaw/openclaw.json`**
   (`/Users/juliuswong/.openclaw/openclaw.json`), mounted into the container.
   If it is clobbered / double-written (missing `gateway.mode`), `restart-gateway`
   restores it from `.bak` / `.last-good` and rewrites it. Check it for a valid
   `gateway.mode: "local"` and the plugin block above.

4. **Stale gateway locks** left by crash loops / recreate races block startup.
   `restart-gateway` clears `~/.openclaw/tmp/openclaw-*/gateway*.lock*` before
   recreating — re-run it rather than hand-deleting.

5. **Fleet focus resets to orch after a bounce.** After a gateway restart,
   `/switch` to a sub gotchi may need re-running — the focus does not survive
   the bounce. Re-`/switch` to the sub agent you were on.

6. **fix_plugins needs a running container** (or at least docker available).
   If the gateway container has never started, `fix_plugins()` still runs but
   the `mv` quarantine is the only useful part — the container health check
   won't find a container to inspect. On a fresh Hub, just run
   `restart-gateway` and let it handle everything.

7. If it still crash-loops → `remote-openclaw` only if Julius approves a
   heavier redeploy. Tell Julius: Hub SSH is up but the gateway process is
   unhealthy — do **not** claim Tailscale is down if `hub status` shows SSH up.

## MCP tools (optional)

If MCP `gotchibot-hub` is loaded:

| Tool | Maps to |
| --- | --- |
| `hub_status` | `hub-ops status` |
| `hub_restart_gateway` | `hub-ops restart-gateway --wait` |
| `hub_vscode_open` | `hub-vscode-open` |
| `hub_bridge_check` | `bridge --check` |
| `hub_bridge_ensure` | `hub-ops bridge-ensure` (receiver + bridge + restart) |
| `hub_bridge_info` | `hub-ops bridge-info` (paths/config; no globalStorage folder) |
| `hub_claude_pane_init` | `claude-pane-init` (CLAUDE.md + @gotchibot-proxy) |
| `hub_monitor` | agent truth board snapshot / open `gotchibot-hubmon` |

Prefer named MCP tools when available; otherwise Bash the commands above.

## Do not

- Install packages / `npm i`
- Paste secrets
- Kill random Docker containers without **infra-recover**
- Say "open VS Code manually" before trying `vscode-open`
- DIY raw `ssh` when `abra run gotchibot -- ./scripts/gotchibot hub …` exists
- Edit `~/.openclaw/openclaw.json` inside the container (it is a host mount;
  edits inside are lost on recreate — edit on the host or use `restart-gateway`)
