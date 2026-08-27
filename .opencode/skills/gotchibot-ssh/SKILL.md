---
name: gotchibot-ssh
description: SSH connection manager for GotchiBot — auto-detects home network (direct SSH) vs remote (Tailscale) and routes sub-agent spawns accordingly. Use when spawning agents on iMac or checking remote status.
---

# GotchiBot SSH Skill

Manages SSH connections to the home iMac orchestrator. Automatically detects network context and selects the optimal transport.

## Behavior

| Context | Transport | Use Case |
|---------|-----------|----------|
| Same LAN (MBP → iMac) | Direct SSH (local IP) | Lower latency, no Tailscale overhead |
| Different network / remote | Tailscale SSH | Works anywhere, NAT traversal |

## Detection Logic

1. **Ping iMac local hostname** (`Juliuss-iMac-2.local`) — if responds in <50ms, use direct SSH
2. **Fall back to Tailscale** — `100.68.95.90` (iMac Tailscale IP)
3. **Cache result** for session (re-check on explicit `remote-status`)

## Commands (wraps existing scripts)

| Action | Script | Network |
|--------|--------|---------|
| Status probe | `./scripts/gotchibot remote-status` | Auto |
| Push code + wallet | `./scripts/gotchibot remote-push` | Auto |
| Start orchestrator | `./scripts/gotchibot remote-serve` | Auto |
| Attach TUI | `./scripts/gotchibot attach` | Auto |
| Spawn sub-agent | `./scripts/gotchi-orchestrate.mjs spawn --host auto "task"` | Auto |

## Sub-Agent Spawn Routing

When `delegate-pick.mjs` returns `host=imac` or `--host auto`:

1. Run detection → pick transport
2. Spawn via `gotchi-orchestrate.mjs` with `--host imac` (always targets iMac orchestrator)
3. Transport is transparent to spawn logic; SSH config handles routing

## SSH Config (managed by `remote-push` / `remote-serve`)

```ssh
Host imac-direct
  HostName Juliuss-iMac-2.local
  User juliuswong
  IdentityFile ~/.ssh/gotchibot_imac
  IdentitiesOnly yes
  ConnectTimeout 5

Host imac-tailscale
  HostName 100.68.95.90
  User juliuswong
  IdentityFile ~/.ssh/gotchibot_imac
  IdentitiesOnly yes
  ConnectTimeout 10
```

## Usage in Orchestrator

```bash
# Auto-detect and spawn on iMac
./scripts/gotchi-orchestrate.mjs spawn --host auto "refactor auth module"

# Force Tailscale (e.g., from coffee shop)
./scripts/gotchi-orchestrate.mjs spawn --host imac "task"  # uses Tailscale via SSH config

# Check current route
./scripts/gotchibot remote-status
```

## Integration with `delegate-first`

The `delegate-pick.mjs` picker reads `remote-status` output to decide `host=imac` vs `host=local`. This skill ensures the underlying SSH connection is optimal regardless of picker decision.

## cAavegotchi Agent / Sub-Agent Model

### Definitions

| Term | Description | cAavegotchi Required |
|------|-------------|---------------------|
| **Agent (Orchestrator)** | The main gotchi process — you, the user's primary interface | **1** (binds at startup via `gotchibot connect` / `identity bind`) |
| **Sub-Agent** | Spawned worker for a discrete task (via `gotchi-orchestrate.mjs spawn` or `opencode-dispatch.sh new`) | **1 per sub-agent** (bound at spawn time) |

### Rules

1. **User requires one cAavegotchi** to run the orchestrator (gotchi mode). This is bound at `gotchibot connect` / `identity bind` and stays bound for the session.
2. **cAavegotchis can open multiple of the same agent type** — the cartridge holds N cAavegotchis; each can run an orchestrator instance (e.g., MBP + iMac both running gotchi mode simultaneously, each bound to a different hero).
3. **Every sub-agent needs a cAavegotchi** — the spawn gate (`wallet-gate.mjs`) enforces this: a sub-agent cannot start unless an *unused* cAavegotchi is available on the cartridge.
4. **1 cAavegotchi ≠ 2 sub-agents** — a cAavegotchi bound to a running sub-agent is **unavailable** until that sub-agent completes (session ends, `output.md` written).
5. **Sub-agent binds a cAavegotchi at spawn** — the hero ID is recorded in `sessions/<id>/state.env` (`GOTCHIBOT_HERO_ID`). While that session is `running`, the hero is locked.
6. **Release on completion** — when `opencode-dispatch.sh wait <id>` returns and `output.md` exists, the cAavegotchi is freed for the next spawn.

### Cartridge Capacity Example

```
Cartridge: sim-0677e437f12f1955 (2 cAavegotchis)
  ├─ hero owned-954  → bound to MBP orchestrator (gotchi mode)  [IN USE]
  └─ hero owned-955  → available for sub-agent spawn
```

- Spawn 1 sub-agent → binds `owned-955` → **0 available**
- Spawn 2nd sub-agent → **BLOCKED** (wallet gate fails) until first completes
- Run 2nd orchestrator (iMac) → needs its own cAavegotchi → **BLOCKED** (both heroes in use)

### Checking Availability

```bash
# Wallet gate status (shows cartridge, hero count, bound heroes)
./scripts/wallet-gate.mjs

# List running sessions (sub-agents) and their bound heroes
./scripts/opencode-dispatch.sh list

# List all cAavegotchis on cartridge + which are free
abra run gotchibot -- ./scripts/gotchibot identity list
```

### Spawn Flow (enforced by `gotchi-orchestrate.mjs spawn`)

1. `wallet-gate.mjs` checks: cartridge exists + ≥1 free cAavegotchi
2. Picks a free hero → binds to new session (`GOTCHIBOT_HERO_ID=<hero>`)
3. Spawns sub-agent over SSH (this skill's transport)
4. On completion → hero released automatically

## Adding to GotchiBot

Add to `.opencode/skills/` (already done). No config changes needed — scripts handle detection.

## Testing

```bash
# On home LAN
./scripts/gotchibot remote-status   # should show direct SSH probe OK

# On different network
./scripts/gotchibot remote-status   # should show Tailscale probe OK

# Check cAavegotchi availability before spawn
./scripts/wallet-gate.mjs
```