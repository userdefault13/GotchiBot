---
name: caavegotchi-spawn
description: >-
  Use when the orchestrator needs to spin up a new GotchiBot agent. Load when
  Julius asks to spawn / mint / add an agent, when no cAavegotchi is available,
  or when delegate-pick is blocked. Follow skill cartridge-mint for how minting
  works (sim :8791, not lore :3010). Spawn UI is still /spawn or
  sessions/.spawn-request.json. Named collateral: cartridge first for an
  available matching cAavegotchi (never owned-954, never steal assigned desks).
  If none, write spawn-request so the TUI overlay can unassign, mint-sub from
  the 16 starters, or bind-owned from wallet by name. If he names a collateral
  (YFI, BTC, LINK, …; typo yifi → yfi), include "collateral":"yfi" and wait —
  never ask for a token id, never discuss packs/VRF/portal paths. Do not call
  the question tool.
license: MIT
compatibility: opencode
metadata:
  audience: orchestrator
  workflow: swarm
---

# cAavegotchi spawn — OpenCode orch spin-up

Every GotchiBot agent wears a **cAavegotchi** identity bound to the `gotchibot`
cartridge on AarcadeGh-t. This skill is for the **OpenCode orchestrator**.

**How minting works:** follow skill **cartridge-mint** (sim `:8791`, not lore `:3010`;
`mint-sub` / `bind-owned`; never `identity bind` / VRF). This skill is only the
spawn **UI**: `/spawn` or `sessions/.spawn-request.json`. Do not invent a third mint UI.

The spawn **UI is a real TUI overlay** (`gotchi-spawn.ts`), same family as
permission cards. A `question` tool call is **not** the UI. Do **not** call
`question`. Do **not** mint from bash yourself.

**Do NOT hunt Blockscout or ask Julius for a token id.** When Julius asks to
spin up / mint / add an agent, never the `blockscout` MCP, never explorer scrape,
never `identity bind` portal VRF. Home-stack subgraph **is** allowed through
`wallet-roster.mjs` / identity roster / curl of `subgraph.aarcadeghst.com` for
**names** after a cartridge miss. Still never arbitrary web curl.

**NEVER tell Julius to check cockpit for a token id.** He should not need one.
**NEVER run `gotchibot identity bind`** — that is portal VRF, not mint.
**NEVER discuss packs, pack_pending_vrf, portal paths, or "need token ID".**
Mint is overlay DialogSelect → confirm → `onboarding-api.mjs mint-sub <spirit>`
($5 simPay). Wallet match → confirm → `bind-owned`. Never auto-mint.

If he names a collateral (YFI, BTC, LINK, DAI, … — typo **yifi → yfi**):

1. **Cartridge first.** `abra run gotchibot -- ./scripts/agent-focus.mjs list --json`
   (or identity roster). Match collateral yfi / maYFI with `status === "available"`.
   Never `owned-954`. Today `starter-yfi-h1-1` is YFI but **assigned** (infra-monitor); `owned-22899` (WBTC) owns daily comms
   — not available; do not steal it. If a match exists → spawn that hero. Do not
   mint. Do not ask for a token id.
2. If none available, write spawn-request with that spirit and **wait for the overlay**.
   Skip the 3-choice AND skip portal talk. Overlay lists:

- Matching 16 starters (e.g. maYFI (H1) spirit yfi) — title = label, description = `mint new cAavegotchi · $5 sim`
- Matching unbound wallet gotchis (collateral name/spirit contains yfi) — title = `name (#id)`, description = `bind from wallet`

ALWAYS show this list even if 1 match. Zero matches → full 16 + toast
`no YFI match — pick from the 16`. Confirm (`$5 sim — mint maYFI (H1)?`) then mint.

Default `/spawn` with no collateral: after no-available, **Mint new collateral**
already lists the 16 — keep that. Julius wants that list automatic.

Write `sessions/.spawn-request.json` or tell him `/spawn`.

Do **not** trust `delegate-pick` for availability — it treats idle as free and
will steal assigned desks.

Always prefix API / secret scripts with `abra run gotchibot --`. Never print
tokens. Never treat assigned+idle as available. `owned-954` is the
orchestrator — never pick it as the new worker.

## 1. Query status yourself

Available means `status === "available"` **ONLY**. Not idle, not assigned, not
working, not watching.

```bash
abra run gotchibot -- ./scripts/agent-focus.mjs list --json
# or:
abra run gotchibot -- ./scripts/gotchibot agents --json
abra run gotchibot -- node scripts/hero-agent-state.mjs get
```

Parse heroes. A candidate is free iff `status` / `agentStatus` is exactly
`"available"`. Example: `starter-link-h1-1` (LINK) owns the trader desk →
**assigned** even when idle. `owned-954` → orchestrator, never a worker.

Optional (orchestrator may query so the overlay is ready; still do not dump
ids at Julius or ask him to look them up):

```bash
abra run gotchibot -- node scripts/wallet-roster.mjs --json
```

## 2. If at least one `available` hero exists

- **No collateral named:** bind/use that hero and spawn. Do **not** mint.
- **Collateral named (YFI / BTC / LINK / …; yifi → yfi):** only spawn if that
  available hero's collateral matches (yfi / maYFI). Otherwise it is not a
  candidate — go to step 3 with `"collateral":"yfi"`. Never treat assigned
  (`starter-yfi-h1-1` infra-monitor / `owned-22899` daily comms) as available.

```bash
GOTCHIBOT_HERO_ID=<hero> abra run gotchibot -- ./scripts/gotchi-orchestrate.mjs spawn --host auto --model auto "<original task>"
```

Then continue the original task with that hero.

## 3. WRITE the spawn-request file (do not call `question`)

The TUI plugin `gotchi.spawn` shows the overlays. Trigger it by writing:

```bash
mkdir -p sessions
cat > sessions/.spawn-request.json << EOF
{"task":"<original task>","at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF
```

If Julius named a collateral (YFI, BTC, LINK, …; typo yifi → yfi) **and the
cartridge had no available match**, include it so the overlay **skips** the
3-choice **and skips portal talk**. Combined DialogSelect: matching 16 starters
+ matching unbound wallet gotchis (wallet-roster is allowed). Always a list.
Never auto-mint. Never ask for a token id. Spirit ids: dai, weth, aave, link,
usdt, usdc, tusd, uni, yfi, wbtc/btc, matic.

```bash
cat > sessions/.spawn-request.json << EOF
{"task":"<original task>","collateral":"yfi","at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF
```

Optional: include `"heroId"` if Julius named a cartridge hero (not a token id).

Then **wait**. The plugin polls ~1s, opens the overlay, and deletes/renames
the file so it does not re-fire.

If the overlay does not appear, respawn the chat pane with `--continue`
(`chat-pane.sh` / `GOTCHIBOT_OPENCODE_CONTINUE=1`) so it reloads the plugin,
or tell Julius to type **`/spawn`**. Do not fall back to `question`. Do not
mint from bash. Do not curl Blockscout / The Graph / any NFT API. Do not
ask him to open cockpit.

After the user picks, continue with the spawned hero. If they dismiss
(Escape), **stop**. Do not mint.

Exact 3-choice copy (only when **no** collateral was named and none available):

- title: `No available gotchis`
- Make an agent available — Unassign a currently assigned cAavegotchi, then continue
- Mint from wallet — Bind an on-chain Aavegotchi you already own
- Mint new collateral — Mint a new cAavegotchi from the 16 starter collaterals ($5 sim)

When `collateral` is set, skip that card. Go straight to the **YFI/BTC/… matches**
list (16 starters + wallet). Do not ask which of 3 portal paths.

## 4–6. Unassign / wallet bind / collateral mint

Handled **inside the TUI plugin**. You do not run these yourself after writing
the request file. Named-collateral DialogSelect **always** shows — even for
one YFI match. Starter titles are labels; wallet titles are `name (#id)`.
Mint is `mint-sub` after confirm. Bind is `bind-owned` after confirm. Never
`identity bind` / portal VRF.

Reference only (plugin commands):

```bash
# unassign then spawn
abra run gotchibot -- node scripts/hero-agent-state.mjs set <heroId> available

# wallet list by name after cartridge miss. Do not ask Julius for an id.
abra run gotchibot -- node scripts/wallet-roster.mjs --json
# bind owned (free) then fleet sync then spawn
abra run gotchibot -- node scripts/onboarding-api.mjs bind-owned <tokenId>
abra run gotchibot -- node scripts/openclaw-fleet.mjs sync

# mint-sub ($5 simPay) — pass SPIRIT id (dai, weth, …) NOT libraryName
abra run gotchibot -- node scripts/onboarding-api.mjs mint-sub <spiritId>
abra run gotchibot -- node scripts/openclaw-fleet.mjs sync
```

**Sync caveat:** `hero-agent-state sync` can re-apply `assigned` if the task
still looks standing (cron / monitor / watch / trader / loop / daily). The
plugin sets `available` as the last write.

Starter labels (plugin DialogSelect): `maDAI (H1)`, `maWETH (H1)`, `maAAVE (H1)`,
`maLINK (H1)`, `maUSDT (H1)`, `maUSDC (H1)`, `maTUSD (H1)`, `maUNI (H1)`,
`maYFI (H1)`, `amDAI (H2)`, `amWETH (H2)`, `amAAVE (H2)`, `amUSDT (H2)`,
`amUSDC (H2)`, `amWBTC (H2)`, `amWMATIC (H2)`. Spirit ids: dai, weth, aave,
link, usdt, usdc, tusd, uni, yfi, wbtc, matic.

## 7. Hard rules

- Always `abra run gotchibot --` for API / secret scripts.
- Never print tokens or session passwords.
- Never treat assigned + idle as available.
- Never mint yourself. Never call `question`. If Julius dismisses the overlay, stop.
- Never pick `owned-954` as the new worker.
- Do not use cockpit readline for these choices.
- Do not trust `delegate-pick` for availability.
- To open the UI: `/spawn`, palette "Spawn agent", or write `sessions/.spawn-request.json`.
- **NEVER** tell Julius to check cockpit for a token id. **NEVER** run `gotchibot identity bind` for this flow.
- Never Blockscout / explorer scrape / `identity bind` for NFT token ids. Home subgraph via wallet-roster / identity / curl `subgraph.aarcadeghst.com` is allowed for names.
- If he names YFI / BTC / LINK / … (yifi → yfi): **cartridge first** (available match → spawn). If none, write `"collateral":"yfi"` and wait. Combined 16-starter + wallet match list. Never auto-mint. Never packs / VRF / token-id questions.
- **Docker `--sandbox` spawn:** only when status is exactly `available`. Never steal LINK/YFI/WBTC standing desks. Never auto-mint for sandbox.

## Reference

- TUI plugin: `.opencode/tui-plugins/gotchi-spawn.ts` (slash `/spawn`)
- Spawn gate + cAavegotchi-required rule: skill `gotchibot`
- Delegate-first (pick an available agent): skill `delegate-first`
- Status model: `scripts/hero-agent-state.mjs` (`available|active|working|assigned|idle|watching`)
- Identity / sim APIs: `scripts/onboarding-api.mjs` (`bind-owned`, `mint-sub`, `bind-starter`)
- Minting rules (backends, 16 starters, forbidden VRF): skill **cartridge-mint**
