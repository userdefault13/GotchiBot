---
name: gotchibot
description: GotchiBot orchestrator — always delegate-first to local/remote cAavegotchi agents; every sub-agent requires a cAavegotchi identity
license: MIT
compatibility: opencode
metadata:
  audience: orchestrator
  workflow: swarm
---

## Delegate-first (required)

Before doing real work yourself, pick an available agent:

```bash
abra run gotchibot -- ./scripts/delegate-pick.mjs
abra run gotchibot -- ./scripts/delegate-pick.mjs --json
```

Then `chat` / `spawn` / surface `blocked` as directed. See skill **`delegate-first`**.

Prefer **iMac over Tailscale SSH** when reachable; **local MBP** otherwise.

Gotchi-mode spawn defaults to `--host auto` (iMac if `REMOTE_HOST` SSH works):

```bash
./scripts/gotchi-orchestrate.mjs spawn --host auto --model nim "…"
./scripts/gotchi-orchestrate.mjs spawn --host auto --sandbox --model nim "…"  # new project box
./scripts/gotchi-orchestrate.mjs wait --host imac <id>
./scripts/gotchi-orchestrate.mjs output --host imac <id>
```

**`--sandbox`:** Docker isolation on iMac/local. Requires `GOTCHIBOT_HERO_ID` with
`status === available`. Never auto-mint. Never steal assigned desks. Abra only
inside the box (`ABRA_KEY`). Coding = opencode in-container (no host cursor-cli).

## Core rule: cAavegotchi required

**Every sub-agent requires a cAavegotchi.** No exceptions.

- Spawns are blocked without a connected wallet, a gotchibot cartridge, and **at least one cAavegotchi** on that cartridge.
- Each new sub-agent session is **bound to a cAavegotchi** at spawn time (`identity bind --session <id>`).
- Never bypass the gate with raw `opencode run` for swarm work — use the spawn scripts only.
- Remote (iMac) spawns sync wallet/identity over Tailscale, then run the same gate on the iMac.

Check before spawning:

```bash
./scripts/wallet-gate.mjs
./scripts/gotchi-orchestrate.mjs gate
abra run gotchibot -- ./scripts/agent-focus.mjs list
abra run gotchibot -- ./scripts/gotchibot remote-status
```

## If spawn is blocked

| Error | Fix |
| --- | --- |
| No wallet | `./scripts/gotchibot connect` |
| No cartridge | `abra run gotchibot -- ./scripts/gotchibot init` |
| No cAavegotchis | `abra run gotchibot -- ./scripts/gotchibot identity bind` |
| iMac unreachable | `abra run gotchibot -- ./scripts/gotchibot remote-status` then `--host local` |

Tell the user clearly: sub-agents cannot run until they have a cAavegotchi on the cartridge.

## Spawn (one sub-agent)

```bash
# Preferred in gotchi mode (Tailscale iMac when up)
GOTCHIBOT_HERO_ID=<hero> \
  ./scripts/gotchi-orchestrate.mjs spawn --host auto --model nim \
  "self-contained prompt; write to sessions/<id>/output.md"

# New project → Docker sandbox (hero must be available; never auto-mint)
GOTCHIBOT_HERO_ID=<available-hero> \
  ./scripts/gotchi-orchestrate.mjs spawn --host auto --sandbox --model nim \
  "Create X under /work; write /session/output.md"

# Force local
GOTCHIBOT_HERO_ID=<hero> ./scripts/gotchi-orchestrate.mjs spawn --host local --model nim "…"
```

Sandbox ops: `./scripts/gotchibot sandbox status|promote <id> <dest>|rm <id>`.
Do not steal LINK/YFI/WBTC standing desks. Do not call abra on the host.

## Multitask (parallel sub-agents)

Each parallel worker still needs the gate — one cAavegotchi on the cartridge minimum; each session gets its own bound hero when the service key is available:

```bash
./scripts/gotchi-multitask.mjs run "task A, task B, task C"
```

## Monitor

```bash
./scripts/opencode-dispatch.sh list
abra run gotchibot -- ./scripts/agent-focus.mjs list   # includes iMac sessions
abra run gotchibot -- ./scripts/gotchi-orchestrate.mjs wait --host imac <id>…
abra run gotchibot -- ./scripts/gotchi-orchestrate.mjs output --host imac <id>
```

## Cursor CLI (optional)

When the user wants **Cursor Agent** instead of gated sub-agents:

```bash
./scripts/cursor-cli.mjs run "prompt" [--mode plan|ask]
```

The gotchi bundles handoff + sub-agent context automatically. See skill `cursor-cli`.

## Claude Code on Hub (`@claudemode` tool)

**Stay on big-pickle.** Do not `/model @claudemode`.

```bash
abra run gotchibot -- node ./scripts/claudemode-ask.mjs "hard logic question…"
# then continue the task using that reply
```

Skill: **`gotchibot-bridge`**. Commands: `/claudemode`, `/bridge`.

## Hard rules

- Delegate-first: do not implement coding tasks yourself while idle agents exist.
- In gotchi mode, prefer Tailscale iMac spawns (`--host auto` / `--host imac`).
- New projects → `--sandbox` + available hero only. Never auto-mint. Never steal LINK/YFI/WBTC.
- Never install tools/skills autonomously; surface skill requests to the user.
- Abra / secrets: **not on host Desk**. Sandbox containers only (`ABRA_KEY`).
- Do not edit files under `sessions/` except reading outputs and state.
