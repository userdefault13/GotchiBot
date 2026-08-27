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
abra run gotchibot -- ./scripts/gotchi-orchestrate.mjs spawn --host auto --model nim "…"
abra run gotchibot -- ./scripts/gotchi-orchestrate.mjs wait --host imac <id>
abra run gotchibot -- ./scripts/gotchi-orchestrate.mjs output --host imac <id>
```

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
GOTCHIBOT_HERO_ID=<hero> abra run gotchibot -- \
  ./scripts/gotchi-orchestrate.mjs spawn --host auto --model nim \
  "self-contained prompt; write to sessions/<id>/output.md"

# Force local
GOTCHIBOT_HERO_ID=<hero> ./scripts/gotchi-orchestrate.mjs spawn --host local --model nim "…"
```

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

## Hard rules

- Delegate-first: do not implement coding tasks yourself while idle agents exist.
- In gotchi mode, prefer Tailscale iMac spawns (`--host auto` / `--host imac`).
- Never install tools/skills autonomously; surface skill requests to the user.
- Secrets via abracadabra only — never raw credentials in prompts or logs.
- Do not edit files under `sessions/` except reading outputs and state.
