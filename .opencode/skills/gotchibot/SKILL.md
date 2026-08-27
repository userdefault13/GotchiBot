---
name: gotchibot
description: GotchiBot orchestrator — spawn gated sub-agents; every sub-agent requires a cAavegotchi identity
license: MIT
compatibility: opencode
metadata:
  audience: orchestrator
  workflow: swarm
---

## Core rule: cAavegotchi required

**Every sub-agent requires a cAavegotchi.** No exceptions.

- Spawns are blocked without a connected wallet, a gotchibot cartridge, and **at least one cAavegotchi** on that cartridge.
- Each new sub-agent session is **bound to a cAavegotchi** at spawn time (`identity bind --session <id>`).
- Never bypass the gate with raw `opencode run` for swarm work — use the spawn scripts only.

Check before spawning:

```bash
./scripts/wallet-gate.mjs
./scripts/gotchi-orchestrate.mjs gate
```

## If spawn is blocked

| Error | Fix |
| --- | --- |
| No wallet | `./scripts/gotchibot connect` |
| No cartridge | `abra run gotchibot -- ./scripts/gotchibot init` |
| No cAavegotchis | `abra run gotchibot -- ./scripts/gotchibot identity bind` |

Tell the user clearly: sub-agents cannot run until they have a cAavegotchi on the cartridge.

## Spawn (one sub-agent)

```bash
./scripts/gotchi-orchestrate.mjs spawn --model nim "self-contained prompt; write to sessions/<id>/output.md"
```

## Multitask (parallel sub-agents)

Each parallel worker still needs the gate — one cAavegotchi on the cartridge minimum; each session gets its own bound hero when the service key is available:

```bash
./scripts/gotchi-multitask.mjs run "task A, task B, task C"
```

## Monitor

```bash
./scripts/opencode-dispatch.sh list
./scripts/opencode-dispatch.sh wait <id>…
./scripts/opencode-dispatch.sh output <id>
```

## Cursor CLI (optional)

When the user wants **Cursor Agent** instead of gated sub-agents:

```bash
./scripts/cursor-cli.mjs run "prompt" [--mode plan|ask]
```

The gotchi bundles handoff + sub-agent context automatically. See skill `cursor-cli`.

## Hard rules

- Never install tools/skills autonomously; surface skill requests to the user.
- Secrets via abracadabra only — never raw credentials in prompts or logs.
- Do not edit files under `sessions/` except reading outputs and state.
