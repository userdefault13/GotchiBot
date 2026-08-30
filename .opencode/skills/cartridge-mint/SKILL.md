---
name: cartridge-mint
description: >-
  Load whenever minting, binding, spawning, talking about portals/packs/VRF/cAavegotchi,
  or using Aarcade cartridge APIs. Beats ad-hoc Blockscout/Graph/identity-bind.
  Two backends: lore :3010 (SIM disabled) vs cartridge-sim :8791 (only mint/bind writer).
license: MIT
compatibility: opencode
metadata:
  audience: orchestrator
  workflow: identity
---

# Cartridge mint

This skill **beats** Blockscout, The Graph, `gotchibot identity bind`, portal/pack/VRF, and lore `:3010` for spinning a worker.

Spawn **UI** is still skill **caavegotchi-spawn** (`/spawn` or `sessions/.spawn-request.json`). Do not invent a third mint UI. Do not call OpenCode `question`.

## Two backends — do not mix

**Lore / main Aarcade API** `:3010` (`gotchi-lore-api`) — Cartridge SIM is **DISABLED**. Health/lore/reads only. Never `mint-sub` / `bind-owned` / `bind-starter` against `:3010`.

**Cartridge SIM writer** `127.0.0.1:8791` (Docker `aarcade-cartridge-sim`, hosts cartridge.aarcadeghst.com / aarcadeghst.com). **Only** mint/bind writer. Needs `gotchiOwnership.cjs` beside `cartridgeSim.cjs`. Use `abra run gotchibot --` so secrets stay in abra. Mint **401** → sim key — do **not** switch to `:3010`.

MCP `aarcade-cartridge-schema` is schema-only. Writes still go to sim `:8791`. See `.opencode/mcp/aarcade-cartridge-schema.md`.

## cAavegotchi mint paths (ONLY these)

1. **Available hero** — `status === "available"` only. Spawn. Do not mint.
2. **Mint new collateral** — list the **16 starter collaterals** (DialogSelect / `/spawn`). Julius confirms. Then `onboarding-api.mjs mint-sub <spiritId>` with simPay ($5 sim).
   - Spirit ids: `dai weth aave link usdt usdc tusd uni yfi wbtc matic`
   - Labels: maDAI (H1) maWETH (H1) maAAVE (H1) maLINK (H1) maUSDT (H1) maUSDC (H1) maTUSD (H1) maUNI (H1) maYFI (H1) amDAI (H2) amWETH (H2) amAAVE (H2) amUSDT (H2) amUSDC (H2) amWBTC (H2) amWMATIC (H2)
   - Haunt 3 brand names are **not** in the 16.
3. **Mint from wallet** — list unbound wallet gotchis by **NAME** from cockpit `fetchWalletGotchis` / `wallet-roster.mjs` (never Blockscout, never subgraph scrape, never ask Julius for a token id). Then `bind-owned <tokenId>` (free). Persist collateral on the hero (`bind-owned` used to drop it → wrong avatar color).
4. **Named collateral** (`yifi`→`yfi`, `btc`→`wbtc`): filter 16-list + wallet matches, **ALWAYS show the list**, confirm, then mint-sub or bind-owned.
5. **Unassign** — list assigned agents, set available, spawn. Never unassign `owned-954` (orch).

## Forbidden

- `gotchibot identity bind` / portal mint / seal / VRF / `pack_pending_vrf` for spinning a worker. That is a different pack-opening flow, not cAavegotchi spawn.
- Asking Julius for token IDs or to "check cockpit".
- Hitting `:3010` for mint.
- Treating idle+assigned as available.
- Auto-mint without the overlay confirm.

## After mint

```bash
abra run gotchibot -- node scripts/openclaw-fleet.mjs sync
GOTCHIBOT_HERO_ID=<id> abra run gotchibot -- ./scripts/gotchi-orchestrate.mjs spawn --host auto --model auto "<task>"
```

Avatar colors from `assets/collateral-colors.json` primary/secondary via `collateral-resolve.mjs`. Stay with that gotchi on switch. Status color is label-only.

## UI

TUI plugin `gotchi.spawn`: `/spawn` or write `sessions/.spawn-request.json` `{task, collateral?, at}`.
