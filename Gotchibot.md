# GotchiBot Abilities

This file lists the core capabilities of the GotchiBot orchestrator and its agent fleet. Each ability is tied to a cAavegotchi hero on the AarcadeGh-t cartridge SIM and is scoped to the home iMac infrastructure.

| Ability | Description | Hero Requirement |
|---|---|---|
| **Agent Orchestration** | Spawn and manage sub-agents via `gotchi-orchestrate.mjs`; each sub-agent requires an available cAavegotchi on the cartridge. | 1 free hero per session |
| **Spawn / Mint** | Mint new cAavegotchi from 16 starter collaterals (maDAI, maWETH, maLINK, etc.) via `$5 sim pay`; or bind-owned from wallet by name; never auto-mint, always confirm from the overlay. | Free hero → binds at spawn |
| **GoBall Cartridge** | Mint and bind GoBall cartridges from the Games catalog; requires goball rules registered on the cartridge SIM (`services/cartridge-sim-proxy`). | Free hero |
| **GoChi-Trader Monitor** | Check paper desk health, PnL, fills, cron status, and whether the desk is running. | Free hero |
| **GoChi-Trader Improve** | Auto-improve or retune a paper trader from its realized trade history. | Free hero |
| **Market News Feed** | Fetch live headlines or risk-on/off veto before adding size to a trading desk. | Free hero |
| **Marketplace / Baazaar** | View, add, and execute Aavegotchi Baazaar listings on Base mainnet (8453). Buy with GHST or USDC. | Free hero |
| **GBM Auctions** | View, create, cancel, bid, and claim Aavegotchi GBM auctions on Base mainnet. | Free hero |
| **Gotchiverse** | Channel alchemica, survey, harvest, craft installations/tiles, build on parcels, manage installation upgrades and craft/upgrade queues. | Free hero |
| **Identity & Wallet** | Connect/EVM wallet generation via `abra`, list owned gotchis, bind-owned from wallet, manage collateral colors. | Free hero |
| **Infra Recovery** | Detect and restart failed Docker containers (graph proxy, tunnel, cloudflared), and Hasura on the home iMac. | Orchestrator only |
| **Sub-Agent Routing** | Spawn sub-agents on the iMac over Tailscale SSH (direct LAN when on same network). | 1 free hero |
| **Vercel Budget Guard** | Pin aarcadeghst.com to the home iMac via Cloudflare tunnel; serve static + all API routes locally to eliminate billable Vercel function invocations. | Orchestrator only |

## Quick Reference

- **One cAavegotchi** is required to run the orchestrator (bound at `gotchibot connect` / `identity bind`).
- **Each sub-agent** binds a hero at spawn; the hero is released when the session completes (`output.md` written).
- **Cartridge SIM** runs on the iMac at `127.0.0.1:8791` behind a Cloudflare tunnel (`cartridge.aarcadeghst.com`).
- **Two backends**: lore API `:3010` (read-only, SIM disabled) vs cartridge SIM `:8791` (mint/bind writer only).
- **Mint paths**: available hero → spawn; cartridge miss → mint-sub (16 starters, $5 sim) or bind-owned (free, by name).
- **GoBall**: same mint/bind flow; collateral whitelist: `usdc, dai, weth, aave, link, usdt, wbtc, matic, sushi, yfi, uni, tusd, usdp, frax, lusd, rai, amazon, apple, disney, gamestop, microsoft, nike, nvidia, spacex, tesla, usollfund`.
- **After mint**: `openclaw-fleet.mjs sync`, then `GOTCHIBOT_HERO_ID=<id> abra run gotchibot -- ./scripts/gotchi-orchestrate.mjs spawn --host auto --model nim "<task>"`.