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
| Claude bridge / pane missing | `abra run gotchibot -- ./scripts/gotchibot vscode-open` | `abra run gotchibot -- ./scripts/gotchibot bridge --check` |
| Ask Hub Claude | MCP `claude_ask` or `abra run gotchibot -- ./scripts/gotchibot claude-ask "…"` | Stay on big-pickle |
| Subgraph / tunnel down | `abra run gotchibot -- ./scripts/gotchibot tunnel status` | `… tunnel restart` |
| Unhealthy Docker (monolith/proxy) | Load skill **infra-recover** | Do not recreate volumes |
| Sync code to Hub | `abra run gotchibot -- ./scripts/gotchibot remote-push` | — |
| Full OpenClaw redeploy | `abra run gotchibot -- ./scripts/gotchibot remote-openclaw` | Heavy; prefer `restart-gateway` first |

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

## If restart still fails

1. Read remote logs (hub-ops already prints last lines on failure).
2. Look for `Plugin "…" requires capability consent` → re-run restart-gateway (it accepts capabilities).
3. Look for crash loops → `remote-openclaw` only if Julius approves a heavier redeploy.
4. Tell Julius: Hub SSH is up but gateway process unhealthy — do **not** claim Tailscale is down if `hub status` shows SSH up.

## MCP tools (optional)

If MCP `gotchibot-hub` is loaded:

| Tool | Maps to |
| --- | --- |
| `hub_status` | `hub-ops status` |
| `hub_restart_gateway` | `hub-ops restart-gateway --wait` |
| `hub_vscode_open` | `hub-vscode-open` |
| `hub_bridge_check` | `bridge --check` |

Prefer named MCP tools when available; otherwise Bash the commands above.

## Do not

- Install packages / `npm i`
- Paste secrets
- Kill random Docker containers without **infra-recover**
- Say “open VS Code manually” before trying `vscode-open`
- DIY raw `ssh` when `abra run gotchibot -- ./scripts/gotchibot hub …` exists
