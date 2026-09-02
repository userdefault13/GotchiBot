# GotchiBot
A macOS / Linux / Windows orchestrator for Aavegotchi agents — manage your fleet from the home iMac.

Open-source **Aavegotchi agent orchestrator** — macOS, Linux, and Windows (WSL2 for tmux cockpit).
OpenClaw / OpenCode cockpit, cAavegotchi heroes, and Solo or Fleet topology.

**npm:** [`@userdefault/gotchibot`](https://www.npmjs.com/package/@userdefault/gotchibot) ·
**Source:** [github.com/userdefault13/GotchiBot](https://github.com/userdefault13/GotchiBot) (public) ·
**Site:** [aarcadeghst.com](https://www.aarcadeghst.com)

## Trust & licensing

GotchiBot ships as **open source** under [PolyForm Noncommercial 1.0.0](LICENSE) so you can
audit agents, scripts, and API calls before granting wallet or model access. **Commercial use**
and official hosted infra require a separate entitlement — see [COMMERCIAL.md](COMMERCIAL.md).

| What you need | Why |
|---|---|
| [**abracadabra**](https://www.npmjs.com/package/@userdefault/abracadabra) | Secrets vault (Keychain / keytar) — never in repo files |
| **GotchiBot install token** | Authenticates your install with official AarcadeGh$t API (subgraph proxy, cartridge sim) |
| **Abra License NFT** (for abra) | Full abracadabra activation when using the vault alongside GotchiBot |

Install tokens come from `gotchibot onboard` (wallet flow). BYO model keys:

```bash
abra set gotchibot OPENCODE_API_KEY
```

## Requirements

- **macOS**, **Linux**, or **Windows** (WSL2 recommended for `gotchibot tmux`)
- Node ≥ 18
- `tmux` — [platform install hints](docs/SOLO-LINUX-WINDOWS.md)
- [abracadabra](https://www.npmjs.com/package/@userdefault/abracadabra) for secrets (`abra doctor`)

Linux: `sudo apt install libsecret-1-dev build-essential` before `npm i -g @userdefault/abracadabra`.

See [docs/SOLO-LINUX-WINDOWS.md](docs/SOLO-LINUX-WINDOWS.md) for full cross-platform onboarding. **Windows:** use WSL2 (`gotchibot wsl`).

## Install

**From npm (recommended):**

```bash
npm install -g @userdefault/gotchibot @userdefault/abracadabra
abra doctor
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

## Home iMac fleet (for agents & humans)

This repo runs on the home iMac via a Cloudflare tunnel (`cartridge.aarcadeghst.com` →
cartridge SIM Docker on `127.0.0.1:8791`), aarcade-mongo (`127.0.0.1:27017`), Commsies
(`:3002` + Ollama), and the AarcadeGh-t cartridge SIM backend. Agents are bound to
cAavegotchi heroes on the cartridge; first-time users run `gotchibot onboard` to
connect a wallet, grab an install token, and pick a starter hero (YFI, BTC, LINK, etc.).
The `gotchibot tmux` command opens the Desk (OpenClaw cockpit) for fleet management, agent
spawning, and PnL monitoring. From the Desk, `gotchibot hub` / `/hub` monitors the Hub
(always-on iMac): SSH, OpenClaw gateway, sessions, tunnel, and Docker (`hub --infra` for
the container table). GoBall cartridges and the GoBall SIM follow the same
pattern — see the `cartridge-mint` skill for mint/bind workflows.

## Docs

| Doc | Purpose |
|-----|---------|
| [AGENTS.md](AGENTS.md) | Agent rules and model tiers |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Fleet / Solo deployment |
| [docs/SOLO-AND-FLEET.md](docs/SOLO-AND-FLEET.md) | Topology overview |
| [docs/FRIENDS-BETA-ROLLOUT.md](docs/FRIENDS-BETA-ROLLOUT.md) | Install token beta |
| [COMMERCIAL.md](COMMERCIAL.md) | NFT entitlements & commercial licensing |
| [ORCHESTRATOR.md](ORCHESTRATOR.md) | Orchestrator configuration |
| [Gotchibot.md](Gotchibot.md) | GotchiBot abilities and agent skills list |