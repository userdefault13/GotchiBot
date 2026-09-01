# GotchiBot

Open-source **Aavegotchi agent orchestrator** for macOS — OpenClaw / OpenCode cockpit,
cAavegotchi heroes, and Solo or Fleet topology.

**License:** [PolyForm Noncommercial 1.0.0](LICENSE) — source is public for trust; commercial
use and official hosted infra require a separate entitlement. See [COMMERCIAL.md](COMMERCIAL.md).

## Requirements

- macOS
- Node ≥ 18
- `tmux` (`brew install tmux`)
- [abracadabra](https://www.npmjs.com/package/@userdefault/abracadabra) for secrets (Touch ID vault)
- **GotchiBot install token** for official AarcadeGh$t API access (wallet onboarding)

## Install

```bash
npm install -g @userdefault/gotchibot
```

Or from git:

```bash
git clone https://github.com/userdefault13/GotchiBot.git
cd GotchiBot
./scripts/gotchibot onboard
./scripts/gotchibot tmux
```

## Quick start

```bash
gotchibot onboard    # wallet → install token → cartridge → doctor
gotchibot tmux       # open cockpit (checks for updates on launch)
gotchibot doctor     # env checklist
```

BYO model keys live in abracadabra (`abra set gotchibot OPENCODE_API_KEY`), never in repo files.

## Updates

Launch commands (`tmux`, `attach`, `onboard`) check for newer releases via
https://www.aarcadeghst.com/api/release-manifest?product=gotchibot and apply with `git pull`
when installed from git.

```bash
gotchibot update --check
gotchibot update --apply
```

## Docs

| Doc | Purpose |
|-----|---------|
| [AGENTS.md](AGENTS.md) | Agent rules |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Fleet / Solo deployment |
| [docs/SOLO-AND-FLEET.md](docs/SOLO-AND-FLEET.md) | Topology |
| [docs/FRIENDS-BETA-ROLLOUT.md](docs/FRIENDS-BETA-ROLLOUT.md) | Install token beta |
| [COMMERCIAL.md](COMMERCIAL.md) | NFT entitlements & commercial licensing |

## Official infra

Shared subgraph, cartridge sim, and install auth are operated at
[www.aarcadeghst.com](https://www.aarcadeghst.com). Solo clients authenticate with a
per-install token obtained during `gotchibot onboard` — not operator secrets.
