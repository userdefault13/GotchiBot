---
name: unity-login-cartridge-sop
description: >-
  Load when starting a new Unity game (PaarcelWars, GotchiCraft, or any
  future Aarcade title) or when adding/fixing the wallet-login scene or the
  cAavegotchi cartridge-bind scene in an existing one. Gotchiverse2D is the
  template: its ServerConfig + GameBootstrap + BootstrapSetup one-click
  scene-builder is the skeleton every game should copy. Pour GotchiCraft's
  Reown wallet logic and Paarcel's cartridge logic into that skeleton — don't
  copy Paarcel's or GotchiCraft's project structure, and don't re-litigate
  wallet SDK choice (MetaMask SDK / Thirdweb were tried and abandoned in
  Paarcel; Reown AppKit is settled).
license: MIT
compatibility: opencode
metadata:
  audience: game-dev-subagent
  workflow: unity
---

# Unity login + cartridge SOP

Every Aarcade Unity game needs two onboarding building blocks before
gameplay starts:

1. **Login** — connect an EVM wallet (Reown AppKit / WalletConnect, MetaMask
   included) and read Base-chain balances/NFTs.
2. **Cartridge bind** — bind a **cAavegotchi** hero from the Aarcade
   cartridge SIM (own / mint-starter / rent) before a match can start.

No single repo has both done well. **Three different repos each contribute
one piece — don't copy any of them wholesale:**

| Repo | What it's good for | What NOT to copy |
|---|---|---|
| `~/Dev/Gotchiverse2D` | **The template.** `ServerConfig` (ScriptableObject, dev/prod URL split), `GameBootstrap` (single entry point, idempotent `Ensure*` systems), `BootstrapSetup.cs` (one-click Editor menu that builds the whole scene from code — no prefab GUIDs to keep in sync), clean per-domain namespaces (`Gotchiverse.Config/Network/Schema/Wallet/World/Editor`). Its `WalletService.cs` is an explicit **stub** ("Wire MetaMask Unity SDK here for production") with a dev-wallet generator for Multiplayer Play Mode testing — it has no cartridge layer at all. | Nothing — this is the skeleton to copy for every new game. |
| `~/Dev/GotchiCraft` | The real wallet implementation: `WalletManager` wrapping Reown AppKit, `WalletController` UI. | Its `SceneInitializer` / `GameSceneSetupEditor` GUID-based prefab patching — Gotchiverse2D's code-generated `BootstrapSetup` is strictly better (nothing to keep in sync, reproducible from a clean checkout). |
| `~/Dev/Paarcel` | The real cartridge implementation: 11 files under `Assets/Scripts/Cartridge/` + `AarcadeBridge.cs`. | Its project structure/bootstrap — it's ~30 one-off `Assets/Editor/*.cs` scripts and hand-wired scenes, no config ScriptableObject, no single entry point. Its repo root also has ~150 ad hoc `*_FIX.md`/`*_SUCCESS.md` files documenting a MetaMask SDK → Thirdweb → Reown migration — that history is why Reown is settled and not up for debate. |

`PaarcelWars` is currently blank (`SampleScene` + zero scripts) — it's a
future target for this SOP, not a reference.

## The pattern: fill Gotchiverse2D's stubs, don't replace its skeleton

Gotchiverse2D was clearly built with this in mind — `WalletService` already
has the right public surface (`Instance`, `ConnectedAddress`,
`OnWalletConnected`, `ConnectDevWallet()`) and a comment telling you where to
wire a real SDK. The work is:

1. **Wallet**: replace `WalletService`'s internals with GotchiCraft's
   `WalletManager` (Reown AppKit calls) while **keeping the same public API**
   (`Instance`, `ConnectedAddress`, `OnWalletConnected`) so `GameBootstrap.
   BootstrapAsync()` doesn't need to change at all. Add a `WalletConfig`
   ScriptableObject next to `ServerConfig` (same `Resources`-asset pattern) to
   hold the per-game `reownProjectId` / `projectName` / `metadataUrl` instead
   of scene-baked `SerializeField`s.
2. **Cartridge**: there's no existing stub, so create `Assets/Scripts/Cartridge/`
   fresh and port Paarcel's files into it verbatim (adjust namespace to
   `Gotchiverse.Cartridge`, rename the `PaarcelGameId`-equivalent const per
   game). Wire it into `BootstrapSetup.SetupHubBootstrapScene()` the same way
   `WalletService`/`ColyseusClientManager` are added to `GameSystems`, and gate
   `GameBootstrap.BootstrapAsync()`'s room-join on
   `CartridgeService.Instance.IsReadyForMatch` (mirrors Paarcel's
   `LobbyManager.RefreshMatchButtons`).

## 1. Package setup (once per Unity project)

Add to `Packages/manifest.json` (copy verbatim from GotchiCraft — Gotchiverse2D's
manifest has neither package yet):

```json
{
  "dependencies": {
    "com.nethereum.unity": "5.0.0",
    "com.reown.appkit.unity": "1.5.0"
  },
  "scopedRegistries": [
    {
      "name": "package.openupm.com",
      "url": "https://package.openupm.com",
      "scopes": [
        "com.nethereum.unity", "com.reown.appkit.unity", "com.reown.core",
        "com.reown.core.common", "com.reown.core.crypto", "com.reown.core.network",
        "com.reown.core.storage", "com.reown.sign", "com.reown.sign.nethereum",
        "com.reown.sign.nethereum.unity", "com.reown.sign.unity",
        "com.reown.unity.dependencies"
      ]
    }
  ]
}
```

Get a **new** Reown Cloud project id per game at cloud.reown.com — never
reuse another game's project id, and add the game's deployed/WebGL domain to
that project's allowlist or wallets reject the session.

## 2. Wallet: fill `WalletService`

Reference: `~/Dev/GotchiCraft/Assets/Aavegotchi/Blockchain/Scripts/WalletManager.cs`

- `AppKitConfig.supportedChains` must include **both**
  `ChainConstants.Chains.Ethereum` and `.Base` — Base-only causes MetaMask to
  reject the session immediately; switch to Base after connect for actual
  gameplay.
- Set `enableAnalytics = false` (avoids a `ReownHttpException` timeout hitting
  `api.web3modal.com`).
- Keep Gotchiverse2D's existing event/singleton shape: `OnWalletConnected`
  fires with the address (as it already does for the dev-wallet path), add
  `OnWalletDisconnected` / `OnBalancesUpdated` if the game needs balances.
- Init is async — anything that reads `ConnectedAddress` before AppKit
  finishes must wait on an `IsInitialized()`-style flag first, same as
  GotchiCraft's `SceneInitializer` polls `WalletManager.Instance.IsInitialized()`
  with a timeout. `GameBootstrap.EnsureBootstrapSystems()` is the right place
  for that wait.

**Shared across all games (don't re-derive):** Base chainId `8453`, GHST
token `0xcd2f22236dd9dfe2356d7c543161d4d260fd9bcb`, USDC
`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, Aavegotchi NFT
`0xA99c4B08201F2913Db8D28e71d020c4298F29dBF`, Wearables (ERC1155)
`0x052e6c114a166B0e91C2340370d72D4C33752B4b`.

**Per-game (goes in `WalletConfig`, not code):** `reownProjectId`,
`projectName`, `projectDescription`, `metadataUrl`.

## 3. Cartridge: new `Assets/Scripts/Cartridge/`

Reference: `~/Dev/Paarcel/Assets/Scripts/Cartridge/*.cs`, `Assets/Scripts/Aarcade/AarcadeBridge.cs`

- **`AarcadeBridge`** — `RuntimeInitializeOnLoadMethod(BeforeSceneLoad)`
  singleton. In the Aarcade WebGL embed (GameViewer iframe) it receives a
  session payload (`sessionToken`, `cartridgeId`, `gameId`, `cartridgeSim`)
  via a `__Internal` JS bridge and fires `OnSessionReady`. Standalone/Editor
  builds never populate this — expected, `CartridgeService` falls back.
- **`CartridgeService`** — singleton, selects provider:
  - `JsonCartridgeProvider` (local fixture) in Editor/standalone/no Aarcade
    session — develop without the SIM running.
  - `HttpCartridgeProvider` in WebGL when `cartridgeSim` is on and a session
    token exists — talks to the cartridge SIM writer (`:8791` behind
    `cartridge.aarcadeghst.com`), **never** the lore API `:3010` (read-only,
    SIM disabled there — see skill `cartridge-mint`).
  - Set the game's id as a const (mirror `PaarcelGameId`) and validate it
    against the loaded cartridge's `gameId` — reject mismatches.
  - Exposes `IsGuestMode` (`PlayerPrefs["IsGuestMode"]` — Editor-only escape
    hatch, useful for Gotchiverse2D's Multiplayer Play Mode testing since it
    already auto-generates dev wallets), `NeedsBind`, `IsReadyForMatch`,
    `BindOwnedAsync`/`BindStarterAsync`/`BindRentalAsync`, `ToAavegotchiData()`,
    `SaveGameStateCheckpointAsync`.
- **`CartridgeLobbyHero`** / **`CartridgeBindUI`** — port as-is; `CartridgeBindUI`
  builds its UI at runtime (no prefab dependency, fits Gotchiverse2D's
  code-generated-scene philosophy). Starter collateral list is fixed — reuse
  verbatim, must match the 16-collateral set used everywhere in GotchiBot
  (`usdc, dai, weth, aave, link, usdt, wbtc, matic, sushi, yfi, uni, tusd,
  usdp, frax, lusd, rai`).
- **Checkpoint signing** (only if the game persists state to the cartridge):
  `CartridgeWalletSigner` requests a `personal_sign` via JS interop —
  **WebGL Aarcade embed only**, throws `NotSupportedException` in
  Editor/standalone by design.
- Gate room-join / match-start on
  `CartridgeService.Instance == null || CartridgeService.Instance.IsReadyForMatch`.

## 4. Wire both into `BootstrapSetup.cs` / `GameBootstrap.cs`

Follow the existing idioms exactly:

- In `BootstrapSetup.SetupHubBootstrapScene()`, add `WalletConfig` creation
  next to `CreateBootstrapAssets()`'s `ServerConfig`, and add
  `systems.AddComponent<CartridgeService>()` (or rely on its
  `RuntimeInitializeOnLoadMethod` bootstrap, matching `AarcadeBridge`'s
  pattern) next to the existing `WalletService`/`ColyseusClientManager` adds.
- In `GameBootstrap.EnsureBootstrapSystems()`, add an `EnsureCartridgeService()`
  following the same `FindAnyObjectByType` idempotency as
  `EnsureCameraFollow()`/`EnsureCellTilemapLoader()`.
- In `GameBootstrap.BootstrapAsync()`, after `walletService.ConnectDevWallet()`
  (or the real connect call), await cartridge load/bind readiness before
  calling `clientManager.JoinNeighborhoodAsync(...)` / `JoinDefaultHubAsync(...)`.

## 5. New-game checklist

1. Fork/copy Gotchiverse2D's skeleton (`ServerConfig`, `GameBootstrap`,
   `BootstrapSetup.cs`, namespace layout) as the starting point for the new
   game — not Paarcel's or GotchiCraft's project structure.
2. Add the Reown/Nethereum package block (§1); get a fresh Reown Cloud
   project id.
3. Fill `WalletService` with GotchiCraft's Reown logic (§2); add
   `WalletConfig` ScriptableObject for per-game values.
4. Port Paarcel's Cartridge folder into `Assets/Scripts/Cartridge/` (§3);
   rename the game-id const to what's registered on the cartridge SIM (see
   skill `cartridge-mint` / `caavegotchi-spawn` for how a game's cartridge
   gets provisioned).
5. Wire both into `BootstrapSetup.cs` and `GameBootstrap.cs` (§4).
6. Test with `IsGuestMode` PlayerPrefs flag before wiring real SIM calls; only
   then point at the tunnel host and confirm a real bind round-trip.

## Hard rules

- Copy Gotchiverse2D's bootstrap/config/editor-setup conventions, not
  Paarcel's or GotchiCraft's. Code-generated scenes (Gotchiverse2D) beat
  prefab-GUID patching (GotchiCraft) — nothing to keep in sync across Unity
  version bumps or prefab renames.
- Don't reopen the wallet-SDK decision. Reown AppKit is settled; MetaMask SDK
  and Thirdweb were tried in Paarcel and abandoned (see its `*_FIX.md` trail).
- `supportedChains` must include Ethereum alongside Base or the wallet
  connect handshake fails silently ("User rejected").
- Cartridge **writes** (mint/bind/checkpoint) only ever go through the
  cartridge SIM (`:8791` / `cartridge.aarcadeghst.com`), never the lore API
  (`:3010`) — same rule as the bot-side `cartridge-mint` skill.
- Every cross-scene manager (`WalletService`/`WalletManager`,
  `CartridgeService`, `AarcadeBridge`, `CartridgeWalletSigner`) is a
  `DontDestroyOnLoad` singleton created idempotently (`Instance != null`
  guard in `Awake`, or `RuntimeInitializeOnLoadMethod` bootstrap) — never
  assume a scene load destroys and recreates them.
- Don't sign or call checkpoint save outside `UNITY_WEBGL && !UNITY_EDITOR` —
  there is no wallet to sign with in Editor/standalone.

## Reference

- Template skeleton: `~/Dev/Gotchiverse2D/Assets/Scripts/{Config,Network,Schema,Wallet,World,Editor}/`, `~/Dev/Gotchiverse2D/BOOTSTRAP.md`
- Wallet implementation to port in: `~/Dev/GotchiCraft/Assets/Aavegotchi/Blockchain/Scripts/WalletManager.cs`
- Cartridge implementation to port in: `~/Dev/Paarcel/Assets/Scripts/Cartridge/`, `~/Dev/Paarcel/Assets/Scripts/Aarcade/AarcadeBridge.cs`
- Bot-side minting rules (backends, 16 starters, forbidden VRF): skill `cartridge-mint`
- Bot-side spawn UI for binding a hero to an agent (not a game player): skill `caavegotchi-spawn`
- Cartridge SIM endpoints: `config/subgraph.endpoints.json`, `cartridge.aarcadeghst.com`
