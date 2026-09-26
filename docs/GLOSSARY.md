# Glossary — roster vs crew vs wallet gotchis

Short definitions for GotchiBot desk terms. **CREWS.md “crew”** means Grok Bot
fleet crews (bend / makers / orch lanes) — that is **not** the same as a
**project crew** below.

| Term | Meaning |
|---|---|
| **Roster** | All of the user’s minted cAavegotchis on the GotchiBot cartridge (`owned-*` + `starter-*`). Source of truth is the cartridge (SIM or Sepolia nest), with a local cache fallback when offline. |
| **Crew** (project crew) | Gotchis assigned to one project: `sessions/pstack/<slug>/roster.json`. Managed via `project-context.mjs` (`crew` / `crew-add` / `crew-remove`, aliases of `roster` / `roster-add` / `roster-remove`; `--move` reassigns a starter). |
| **wallet gotchis (unminted)** | Aavegotchis sitting in the connected wallet that are **not** yet minted/bound onto the cartridge roster. Listed by `gotchibot roster --wallet` / `wallet-roster.mjs`. |
| **identity roster** | `identity.mjs roster` — lists the owner’s GotchiBot cartridges from the cartridge SIM (`/cartridges?owner=…`). Not the wallet list and not project crews. |
| **hub-roster** | `scripts/hub-roster.mjs` — which bots are working on which desk (machine) across the tailnet. Heroes live on the cartridge; work lives on a desk. Keep the name; do not confuse with project `roster.json` crews. |
| **CREWS.md fleet crews** | Multi-bot **Grok Bot** lanes (bend, makers, orch). Route work there; do not confuse with project `roster.json` crews. |

## Roster / crew rules

1. **`owned-*` (wallet gotchi on cartridge)** — may sit on **many** project crews at once.
2. **`starter-*` (base collateral on cartridge)** — **one** project crew at a time. Move with `crew-remove` then `crew-add`, or `crew-add --move`.
3. **Unknown hero kind** — warn and allow (conservative).
4. **Runtime lock** — sandboxed spawn / template **apply** require hero status `available`. Standing desks — `starter-link-h1-1` (LINK trader desk), `starter-yfi-h1-1` (YFI infra monitor), `owned-22899` (comms) — and the orchestrator (`owned-954` / `gotchi`) are excluded.
5. **Templates** — `template-pack install` is **free** (no hero). `template-pack apply` / equip / resummon run the **apply gate** (roster membership + available + starter crew). `template-pack apply` with no `--hero` lists available heroes and exits. `--force` overrides with a WARNING. `GOTCHIBOT_APPLY_GATE_OK=1` skips re-check (including under `--force`) so nested resummon does not hit the network again. Offline roster → local cache + warning.

CLI shortcuts: `node scripts/project-context.mjs crew|crew-add|crew-remove` (aliases of `roster|roster-add|roster-remove`).

## Sepolia mint (bindOwned / bindStarter)

Desk onboarding can open MetaMask bind flows on Base Sepolia (chain **84532**,
`config/cartridgeChain.base-sepolia.json` → `cartridgeDiamond`).

**This repo does not ship the bind ABI fragments.** Until configured, mint
buttons return a clear **not available** result (`code: ABI_MISSING`) and do
**not** open a browser page.

Configure the **exact** ethers human-readable function fragment from the
deployed cartridge diamond facet (cartridge contracts repo / verified facet on
Base Sepolia) — do not invent signatures. Inputs must be **named** so
`encodeBindCalldata` can map them:

- `cartridgeId` \| `cartId` → cartridgeId
- `sourceTokenId` \| `tokenId` \| `gotchiId` → sourceTokenId
- `templateId` \| `template` \| `collateralId` → templateId
- `collateral` \| `collateralAddress` \| `collateralType` → collateral

Set via chain config or env:

- `bindOwnedAbi` / `CARTRIDGE_BIND_OWNED_ABI`
- `bindStarterAbi` / `CARTRIDGE_BIND_STARTER_ABI`

Unnamed or unrecognised input names → `code: ABI_UNSUPPORTED` (no positional
guessing).

`ok: true` from the MetaMask helper means a **tx hash was submitted**, not that
the tx is mined; onboarding-gate confirms the new hero via hero-list readback.

**bindStarter / USDC:** on-chain bindStarter costs **$5 USDC**. Desk helpers do
**not** run a USDC `approve` step — if the facet needs an allowance the tx
reverts. Approval flow is **TODO**.

Or mint via Concierge: `https://www.aarcadeghst.com/concierge/terminal`.

## SIM-side pricing note

Gotchibot.md mentions **“1 free seat per L1 wallet gotchi”** (and related SIM mint
pricing). That is **SIM-side pricing**, not enforced by scripts in this repo
(no desk script gates mint count on L1 wallet gotchi seats). Desk still never
auto-mints.
