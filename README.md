# GotchiBot

Open-source **Aavegotchi agent orchestrator** for macOS — OpenClaw / OpenCode cockpit,
cAavegotchi heroes, and Solo or Fleet topology.

**npm:** [`@userdefault/gotchibot`](https://www.npmjs.com/package/@userdefault/gotchibot) ·
**Source:** [github.com/userdefault13/GotchiBot](https://github.com/userdefault13/GotchiBot) (public) ·
**Site:** [aarcadeghst.com](https://www.aarcadeghst.com)

## Trust & licensing

GotchiBot ships as **open source** under [PolyForm Noncommercial 1.0.0](LICENSE) so you can
audit agents, scripts, and API calls before granting wallet or model access. **Commercial use**
and official hosted infra require a separate entitlement — see [COMMERCIAL.md](COMMERCIAL.md).

| What you need | Why |
|---|---|
| [**abracadabra**](https://www.npmjs.com/package/@userdefault/abracadabra) | Model keys and secrets in a Touch ID vault — never in repo files |
| **GotchiBot install token** | Authenticates your install with official AarcadeGh$t API (subgraph proxy, cartridge sim) |
| **Abra License NFT** (for abra) | Full abracadabra activation when using the vault alongside GotchiBot |

Install tokens come from `gotchibot onboard` (wallet flow). BYO model keys:

```bash
abra set gotchibot OPENCODE_API_KEY
```

## Requirements

- macOS
- Node ≥ 18
- `tmux` (`brew install tmux`)
- [abracadabra](https://www.npmjs.com/package/@userdefault/abracadabra) for secrets

## Install

**From npm (recommended):**

```bash
npm install -g @userdefault/gotchibot @userdefault/abracadabra
gotchibot onboard
```

**From git:**

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
gotchibot attach     # reattach to a running session
gotchibot doctor     # env checklist
```

## Updates

Launch commands (`tmux`, `attach`, `onboard`) prompt when a newer release is available.

**npm install:**

```bash
npm update -g @userdefault/gotchibot
gotchibot update --check
```

**git clone:**

```bash
gotchibot update --apply    # git pull --ff-only when behind origin
```

Manifest sources: CDN → [release-manifest API](https://www.aarcadeghst.com/api/release-manifest?product=gotchibot) → GitHub raw.
Skip checks with `GOTCHIBOT_SKIP_UPDATE_CHECK=1`.

## Official infra

Shared subgraph, cartridge sim, and install auth are operated at
[www.aarcadeghst.com](https://www.aarcadeghst.com). Solo clients authenticate with a
per-install token obtained during onboarding — not operator secrets.

## Docs

| Doc | Purpose |
|-----|---------|
| [AGENTS.md](AGENTS.md) | Agent rules |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Fleet / Solo deployment |
| [docs/SOLO-AND-FLEET.md](docs/SOLO-AND-FLEET.md) | Topology |
| [docs/FRIENDS-BETA-ROLLOUT.md](docs/FRIENDS-BETA-ROLLOUT.md) | Install token beta |
| [COMMERCIAL.md](COMMERCIAL.md) | NFT entitlements & commercial licensing |
