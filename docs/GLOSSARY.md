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

Desk onboarding opens MetaMask bind flows on **Base Sepolia (84532)** using
per-chain JSON ABI fragments in this repo. Mainnet signing is disabled.

| Chain | Config | bindOwned | bindStarter | Signing |
|---|---|---|---|---|
| Base Sepolia 84532 | `config/cartridgeChain.base-sepolia.json` | wired, free (gas only), selector `0x75002762` | wired, **payable 5 Sepolia test ETH** placeholder (`starterBindFeeWei`), selector `0x100cc61b` — **old Sep 4 facet** until a diamondCut | enabled |
| Base mainnet 8453 | `config/cartridgeChain.base.json` | fragment present, selector `0x75002762` | fragment present (USDC path), selector `0x1b33e284` | **DISABLED** (`MAINNET_DISABLED`) pending AarcadeGh-t PR #28 (`feature/cartridge-chain-provider`) |

**Mainnet (disabled) fee model:** `paymentToken` must be Base USDC
`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`; fee `STARTER_BIND_FEE` = `5000000`
($5, 6 decimals); approve **spender = cartridgeDiamond** (not the facet).
`buildMainnetStarterPlan()` returns the ordered `[approve, bindStarter]` txs for
tests/docs only — never auto-run while `signingEnabled: false`.

**Event (both chains):** `CAavegotchiBound(uint256 indexed cartridgeId, bytes32 indexed heroId, uint8 bindType, uint256 sourceTokenId)`
topic0 `0x1827e5bd6f1d1f8b1db16accce3f4eaa3a7db62d925e97e9eb749276c400baa9`.
`bindType`: 0 None, 1 Owned, 2 Rented, 3 Starter. First hero also becomes
`activeHeroId`.

**Preflight** (read-only, before sign page; injectable `readContract`):
1. `ownerOf(cartridgeId)` == expectWallet (selector `0x6352211e`)
2. `portalStatus` enum: `0 LEGACY`, `1 SEALED`, `2 OPEN` — only **1** blocks bind
   (message: must open via GotchiBotNestFacet `open` first)
3. `lineAPaid(cartridgeId)` must be true (selector `0x184014a2`) — true when mint fee
   is 0 or Line A is paid; on false → PREFLIGHT, no sign page
   (`Cartridge: LINE_A_UNPAID`)
4. bindOwned only: L1 `ownerOf(sourceTokenId)` on `l1AavegotchiDiamond` == sender;
   deterministic owned heroId not already in `heroIds(cartridgeId)`

**Hero readback** (only after mined successful receipt):
1. Parse `CAavegotchiBound` log → `heroId = topics[2]`
2. Else last element of `heroIds(cartridgeId)` (selector `0x614a4e44`)
3. Else deterministic: owned =
   `keccak256(abi.encodePacked("owned-", uint256 id))`; starter =
   `keccak256(abi.encodePacked("starter-", bytes32 templateId, "-", uint256 n))`
   with `n = heroIds.length` **before** the call.
Persist desk id → bytes32 in `sessions/.onchain-hero-ids.json` (bytes32 is
source of truth for the roster matcher).

**templateId encoding (confirmed by Aarcadeghst CoS from ChainCartridgeProvider.ts):**
`0x`-prefixed 32-byte hex as-is; otherwise
`keccak256(toUtf8Bytes(lowercase collateral id))` — e.g. `dai` /
`DAI` → `0x9f08c71555a1be56230b2e2579fafe4777867e0a1b947f01073e934471de15c1`;
`wbtc` → `0x59e50295208418569657dcdbf79b85731eff3be260696ead2b44b1c097916a6c`.
Contract does not validate templateId; it only feeds the starter hero-id hash.

**collateral address arg:** not checked on-chain — only forwarded to FeeSplitter.
AarcadeGh-t client defaults to `address(0)`; this repo prefers the real collateral
token from `assets/collateral-colors.json` / `loadBaseStarterCollaterals` when
present, else `address(0)`. Either works.

**AarcadeGh-t source pointers:** `src/cartridge-sdk/ChainCartridgeProvider.ts`
(`bindStarter` templateId), `contracts/cartridge/facets/CAavegotchiFacet.sol`,
`contracts/cartridge/facets/CartridgeModifiers.sol`,
`contracts/cartridge/facets/GameRulesFacet.sol` (`lineAPaid`),
`contracts/cartridge/facets/GotchiBotNestFacet.sol` (`portalStatus` / open),
`contracts/libraries/LibCartridgeAppStorage.sol` (`PORTAL_*` constants),
`contracts/cartridge/CartridgeEvents.sol`, `contracts/interfaces/IAarcadeCartridge.sol`,
`out/CAavegotchiFacet.sol/CAavegotchiFacet.json` (after forge build). Sepolia facet
stays the old payable version until a diamondCut (needs Julius's go via
Aarcadeghst CoS).

Config load: repo `config/cartridgeChain.*.json` **wins** over any upstream
AarcadeGh-t copy so bind keys are never shadowed. Inject `cfg` in tests.

Or mint via Concierge: `https://www.aarcadeghst.com/concierge/terminal`.

## SIM-side pricing note

Gotchibot.md mentions **“1 free seat per L1 wallet gotchi”** (and related SIM mint
pricing). That is **SIM-side pricing**, not enforced by scripts in this repo
(no desk script gates mint count on L1 wallet gotchi seats). Desk still never
auto-mints.
