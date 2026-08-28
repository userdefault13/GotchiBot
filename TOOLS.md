# TOOLS.md - Local Notes

Skills define how tools work. This file is the cheat sheet for Julius's actual setup.

## Machines

- **MBP** — Julius's MacBook. Client. Repo at `~/Dev/GotchiBot`.
- **iMac** — home always-on host for GotchiBot + `opencode serve`. Prefer this when Tailscale SSH is up.
- Remote attach: `abra run gotchibot -- ./scripts/gotchibot attach`
- Remote status: `abra run gotchibot -- ./scripts/gotchibot remote-status`

## Secrets

- Everything through abracadabra. `abra run gotchibot -- <cmd>`
- Never ask Julius to paste a key. Never write secrets to disk, session logs, or `output.md`.

## Orchestration commands

- Pick an agent: `abra run gotchibot -- ./scripts/delegate-pick.mjs`
- Spawn: `abra run gotchibot -- ./scripts/gotchi-orchestrate.mjs spawn --host auto --model nim "…"`
- Focus/chat: `./scripts/agent-focus.mjs chat "…"`
- List / switch / orch: `/list` `/switch` `/orch` (or the `agent-focus.mjs` equivalents)
- Wallet gate: `./scripts/wallet-gate.mjs`

## Data

- Aavegotchi data: AarcadeGh-t tunnel subgraphs in `config/subgraph.endpoints.json`. Never hit LAN IPs directly.

## Voice / TTS

- Opt-in only (`config/tts.personas.json5`). Don't surprise Julius with speech.

## Models

- Default coding: `opencode/hy3-free` (`nim`)
- Hard: `deepseek/deepseek-v4-pro` (needs `DEEPSEEK_API_KEY` via abra)
- Private/offline: local Ollama on the iMac
