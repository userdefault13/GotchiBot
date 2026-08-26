# GotchiBot Identity System

Every agent in the GotchiBot orchestrator wears a minted cAavegotchi identity.
This document describes how identities are minted, stored, and rendered.

## Principle

GotchiBot is a **cartridge inside the AarcadeGh-t platform** — we reuse its
existing cPortal / cAavegotchi minting infrastructure rather than building a
parallel system. No new contracts, no new Mongo schema, no new wallet-connect
UI.

## Mint flow (mimicking AarcadeGh-t's cPortal)

```
User connects wallet (AarcadeGh-t Wallet.vue flow)
  → POST /api/cartridge-sim/cartridges/ensure   { owner, gameId: 'gotchibot' }
  → POST /api/cartridge-sim/portals/mint        (VRF trait roll)
      on-chain: CPortalVrfConsumer.requestMint(batchId, qty)
      fulfillDev locally (Anvil/dev) or real VRF on Base
  → status machine: pack_pending_vrf → pack → sealed → revealed
  → traits[6] + collateral assigned
  → SVG composed via official Aavegotchi diamond previewAavegotchi()
  → identity doc stored in cartridge snapshot (cAavegotchis[])
```

Differences from the Portal War game flow:

- Reveal is immediate after seal (no PvP winners step)
- One identity per agent role, not blind packs of 10 (qty=1 mints)
- Service-key auth added alongside wallet-JWT sessions so the orchestrator can
  mint sub-agent identities programmatically

## Components reused from `~/Dev/AarcadeGh-t`

| Component | Path | Reuse |
|---|---|---|
| VRF trait-roll contract | `contracts/CPortalVrfConsumer.sol` | Roll identity traits instead of BRS; `fulfillDev` for local Anvil testing |
| SIM inventory server | `lib/cartridgeSim.cjs` | Snapshot-per-owner storage; simplified status machine |
| MongoDB | db `Aarcadeghst`, collections `cartridge_sim_instances`, `cartridge_sim_checkpoints` | Unchanged |
| Wallet connect | `src/stores/web3Store`, `src/components/Wallet/Wallet.vue` | Unchanged |
| Mint drawer UI | `src/components/PortalWar/CPortalMintDrawer.vue` | Pattern for gotchibot identity mint UI |
| SVG composition | `src/services/cartridgeHeroSvg.ts` (`previewAavegotchi`) | Official Aavegotchi art, zero rendering infra |
| Session auth | `api/routes/game-session.js` | Wallet JWT for humans + NEW service key for agents |

## Service-key auth (new work)

Current `cartridge-sim.js` routes assume human wallet signatures. GotchiBot
adds:

- `GOTCHIBOT_SERVICE_KEY` generated once, stored in abracadabra
- Requests with `Authorization: Bearer <service-key>` may:
  - read the gotchibot cartridge roster
  - mint sub-agent identities (rate-limited, logged)
  - write checkpoints (handoff summaries)
- All service-key actions are logged to the same audit trail as human actions

## Identity documents

```jsonc
{
  "id": "owned-{tokenId}",           // or starter-{collateral}-h{n}
  "role": "orchestrator" | "sub-coder" | "sub-hard" | "sub-local",
  "owner": "0x…",                    // your wallet
  "traits": [n,n,n,n,n,n],          // 6 numericTraits, Aavegotchi ranges
  "collateral": "…",
  "svg": "<svg>…</svg>",            // composed via previewAavegotchi
  "mintedAt": "2026-08-25T…",
  "checkpoints": ["…"]              // handoff summary refs
}
```

Sub-agent lifecycle: spawn → mint identity via service key → inject avatar +
traits into the session bootstrap prompt → run → checkpoint results back to
the cartridge.

## Terminal rendering (2D-first)

- Apple Terminal has no graphics protocol, so avatars render via
  [chafa](https://hpjansson.org/chafa/) ANSI/half-block mode (flat-color
  Aavegotchi art renders well).
- Two surfaces:
  1. **Midnight Commander F3 binding** — `mc.ext.ini` maps `.svg` files to
     chafa in the viewer; browse the roster directory and preview any avatar.
  2. **tmux live pane** — `scripts/avatar-pane.sh` polls the active agent from
     `sessions/` state and re-renders via chafa on change.
     Layout: mc left; right pane top = your (orchestrator) gotchi, bottom =
     active sub-agent. Pin any agent with `gotchibot avatar <agentId>`.
- Launcher: `gotchibot tmux` arranges the layout.

## 3D (deferred)

Later phase: render GLB models via the Aavegotchi renderer batch API
(`POST https://www.aavegotchi.com/api/renderer/batch`, hash format
`<Collateral>-<EyeShape>-<EyeColor>-<Body>-<Face>-<Eyes>-<Head>-<RightHand>-<LeftHand>-<Pet>`),
deriving hashes from the home Envio core-base subgraph through the tunnel
(`https://subgraph.aarcadeghst.com/subgraphs/name/aavegotchi-core-base`) —
no Goldsky, no local indexers. Audio-driven lip-sync pairs
with TTS output when enabled.
