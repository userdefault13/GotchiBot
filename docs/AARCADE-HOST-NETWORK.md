> **Status: PARKED for privacy (rented hosts see plaintext prompts).** Chats run on your own Hub — see [GOTCHIBOT-API.md](./GOTCHIBOT-API.md).

# Aarcade Host Network (GHST compute mesh)

**Status: LOCKED** (product decisions frozen — build via [`AARCADE-HOST-NETWORK-BUILD.md`](./AARCADE-HOST-NETWORK-BUILD.md) P0–P6).

Community hosts with **spare CPUs** join a mesh, provide compute, and earn **GHST**.
Arcade is the **matcher + escrow metadata plane** — not a data custodian.

Owned Hub + BYO chat remain as documented in [`GOTCHIBOT-HUB.md`](./GOTCHIBOT-HUB.md).
This doc covers the **rental / provider** path (`hub.kind: "rental"`).

## Locked decisions

| Decision | Choice |
|----------|--------|
| Network | **Aarcade Host Network** (not Akash/Spheron as the provider join path) |
| What powers CPUs | Community host machines (spare Mac/Linux); GHST pays, does not power |
| Products | **Hybrid:** job **slots** + **Hub seats** on one mesh |
| Launch | **Slots-first**; Hub seats gated (see [Hub seat gate checklist](#hub-seat-gate-checklist)) |
| Settlement | Renters pay **GHST on Base**; providers earn GHST from escrow |
| Data | Arcade never holds chat bodies, Mongo URIs, prompts, or job payloads |
| Stack | **BYO model** (incl. **OpenCode Go**) + **BYO DB**; infra **BYO** (owned Hub) or **CaaS** (mesh) |
| Provider client | **Node.js** GotchiBot host agent (supervisor; spawns work tools — not the compute engine) |
| Money / later mesh protocol | **Solidity on Base**; agents stay Node |
| Routing | No classic LB — matcher + host pull/claim |
| Coordination (MVP) | Arcade registry / queue / matcher |
| Post-MVP match | **Claim-race** first |
| Decentralization claim | Supply + BYO data + GHST on-chain; **not** “fully decentralized” until ladder |

## Protocol surface (what is Solidity?)

**MVP is hybrid — not a full on-chain compute protocol.**

| Piece | MVP | Language / where |
|-------|-----|------------------|
| GHST escrow (`lockJob` / `release` / `refund` / `feeBps`) | **Yes — on-chain** | **Solidity** on Base (Sepolia first) — `GotchiBotHostEscrow` |
| Provider registry, heartbeats | Off-chain | Arcade Node + Mongo (`gotchibotHostNetwork`) |
| Job queue + matcher | Off-chain | Arcade Node + Mongo |
| Host agent / Desk CLI | Off-chain | GotchiBot JS (`scripts/`) |
| Job bodies / chat | Off-chain | Renter artifacts + BYO Mongo |

**Post-MVP (decentralization ladder):** more Solidity on Base — provider registry + stake, job intents, claim-race `claim()` — still with off-chain signed heartbeats (not full heartbeat spam on L1).

**When coordination goes on-chain, the mesh protocol is written in Solidity (Base).** Host agent, Desk, and heartbeat chatter stay **Node.js / JavaScript** (GotchiBot / Arcade). The runtime that powers provider machines day-to-day is **Node**. No second chain or CosmWasm/Akash rewrite for the community earn path.

So: the **money protocol** is Solidity from P4; the **coordination protocol** starts as Arcade APIs and only moves to Solidity in the post-MVP ladder.

Optional later: Arcade-operated overflow (e.g. Akash) for capacity Arcade rents itself — **not** the community earn path.

## Stack taxonomy (BYO vs CaaS)

Arcade is **not** a hosted DB or model cloud. Users (or their Desks) bring credentials and data stores.

| Layer | Meaning | Who provides it |
|-------|---------|-----------------|
| **BYO model** | LLM / agent runtime the Desk already uses — **OpenCode Go** (e.g. `opencode/big-pickle` / Zen free), Nemotron tiers, plus work tools (Cursor, Claude, Codex) via the renter’s own accounts/keys (abra) | Renter — Arcade is not an inference host and does not bill model tokens |
| **BYO DB** | Chat Mongo (`local` \| `atlas` \| `none`) | Renter — Arcade metadata only; rental = atlas\|none, Desk owns URI |
| **BYO infra** | Always-on Hub machine (OpenClaw, Tailscale, gotchibot-api) | Renter’s own Mac/Linux — **owned Hub** path |
| **CaaS** | Metered or leased compute from the Host Network | Community hosts paid in GHST — **slots** (v1) or gated **Hub seats** |

**Owned Hub:** BYO model + BYO DB + **BYO infra**.  
**Slots:** BYO model + BYO DB + **CaaS** (burst CPU); renter still needs some home for identity/chat (usually owned Hub).  
**Rental Hub seat:** BYO model + BYO DB + **CaaS** (leased Hub metal); not Arcade DBaaS.

Arcade’s role in all paths: install token, match/escrow metadata, GHST settlement — not model host, not database host.

## Decentralization (summary)

**MVP:** community CPUs + BYO data + on-chain GHST; Arcade coordinates.  
**Not:** fully trustless dePIN. Full ladder (on-chain registry → job intents → claim-race matcher) lives in [`AARCADE-HOST-NETWORK-BUILD.md`](./AARCADE-HOST-NETWORK-BUILD.md#decentralization-posture).

## Architecture

```
Provider host agent
  → advertise { slots, hubCapable, cpu, ram, disk } + heartbeats
  → Arcade registry (metadata only)

Renter Desk
  → lock GHST escrow (Base)
  → slot job OR Hub lease
  → chat: Desk → renter Atlas (or none) — never Arcade, never provider Mongo URI
```

**Arcade stores:** provider wallet, capacity ads, heartbeats, lease/job IDs, status, `hub.rental` pin fields, GHST escrow refs.

**Arcade never stores:** Mongo URIs, chat bodies, prompts, job payloads/results (IDs + content hashes / renter pointers only).

## Products (SKUs)

### Job slots (v1 launch target)

- Metered CPU bursts (dispatch units, backtests, fan-out).
- Host runs a sandboxed worker; intermittent / laptop-friendly.
- Results go to a **renter-provided** artifact pointer — not Arcade body storage.
- Renter keeps their **owned** Hub (or other always-on home) for identity + BYO chat.

### Hub seats (gated)

- Full rental GotchiBot Hub: Tailscale pin, OpenClaw on provider metal for the lease window.
- Install record: `hub.kind: "rental"` + `hub.rental` metadata (see schema below).
- Chat: **`atlas` or `none` only** — never provider-local Mongo.

## Data invariants (BYO + sixth rule)

1. **Keep BYO as the product** for owned Hubs: `local` | `atlas` | `none`.
2. **Rental leases:** prefer / require **atlas** or **none** (renter-controlled remote). Reject `local`.
3. Provider may run OpenClaw (+ later desk API duties as designed).
4. **Sixth rule:** **Desk owns Mongo access.** Provider **never** stores `MONGODB_URI` (disk, env, or logs). Chat sync is Desk → renter Atlas, or `none`.
5. **Lease end:** mandatory wipe of Hub workspace on the provider. Chat does not need wipe-from-provider — it was never there.
6. **`none`** remains valid (Hub without chat sync).

Residual (accepted for gated Hub seats): prompts/session files may exist **on provider disk during the lease**. That is temporary host custody, not Arcade custody — hence the wipe gate and slots-first launch.

## `hub.rental` schema (metadata only)

On the install token doc (`hub.rental`), public view:

```json
{
  "leaseId": "lease_…",
  "providerId": "prov_…",
  "tailscaleHost": "host.tailnet.ts.net",
  "expiresAt": "2026-10-01T00:00:00.000Z",
  "sku": "hub",
  "chatStorePolicy": "atlas"
}
```

| Field | Notes |
|-------|--------|
| `leaseId` | Escrow / matcher id |
| `providerId` | Host registry id (not a secret) |
| `tailscaleHost` | Pin for Desk `remote-lib` (same role as owned Hub host) |
| `expiresAt` | ISO lease end |
| `sku` | `"hub"` for Hub seats; slots use a separate job record, not this object |
| `chatStorePolicy` | `"atlas"` \| `"none"` — enforced when setting `hub.chatStore` |

When `hub.kind === "rental"`, `POST …/hub/chat-store` with `kind: "local"` is rejected (`RENTAL_NO_LOCAL_CHAT`).

Arcade implementation: `AarcadeGh-t/lib/gotchibotHub.cjs` (`rentalPublicView`, `setChatStore` guard).

## Slot job record (Arcade metadata)

Schema file (GotchiBot): [`config/host-network.slot-job.schema.json`](../config/host-network.slot-job.schema.json).

Arcade **never** stores prompt or result bodies — only hashes and renter artifact URLs.

| Field | Owner |
|-------|--------|
| `jobId` | Arcade (`job_…`) |
| `renterWallet` / `renterInstallId` | Arcade (from install token) |
| `status` | Arcade: `queued` → `assigned` → `running` → `done` \| `failed` |
| `providerId` | Arcade after assign (`prov_…`) |
| `artifactPutUrl` / `artifactGetUrl` | **Renter** |
| `promptHash` / `resultHash` | Hashes only (`0x` + 64 hex) |
| `maxCoreMinutes` / `priceGhstWei` | Renter at enqueue |
| `escrowTx` | Base lock tx (required at enqueue) |

APIs: `POST /api/gotchibot/slots/enqueue|claim|complete`, `GET /api/gotchibot/slots/:jobId`  
Hosts: `POST /api/gotchibot/host/register|heartbeat`, `GET /api/gotchibot/host/me|list`

## GHST flow

1. Renter locks GHST for a slot job or Hub lease (`GotchiBotHostEscrow` — or SIM without chain).
2. Matcher assigns a provider; Hub path writes `hub.kind: "rental"` + `hub.rental`.
3. Provider claims on successful heartbeat / clean lease end (and wipe attestation for Hub).
4. Arcade fee skim — align with existing Base GHST treasury patterns (License / Concierge).
5. Optional: provider stake required for `hubCapable`.

## Hub seat gate checklist

Public Hub SKU ships only when **all** are true:

- [ ] Host agent supports isolated workspace + **mandatory wipe** on lease end (attested).
- [ ] Provider runtime **cannot** receive or persist `MONGODB_URI` / Atlas passwords.
- [ ] Arcade rejects `chatStore.kind: local` for `hub.kind: rental`.
- [ ] Provider advertises `hubCapable: true` only after always-on + Tailscale + disk checks.
- [ ] Optional but recommended: GHST **stake** (or reputation threshold) for Hub seats.
- [ ] Desk path for rental pin documented (`sessions/.hub.json` kind rental) without long-lived abra secrets on the host.
- [ ] ToS: Arcade is matcher/escrow metadata — not processor of chat or job content.

Until then: **slots only** on the public mesh.

## Non-goals (product)

- Akash / Spheron as the way spare-CPU users **earn GHST**.
- Arcade-hosted Mongo or shared chat for product Solo.
- Provider-local chat DB as a rental product path.

## Build plan

Implementation phases (slots-first → gated Hub seats):  
[`AARCADE-HOST-NETWORK-BUILD.md`](./AARCADE-HOST-NETWORK-BUILD.md)

| Piece | Build phase |
|-------|-------------|
| Slot job / artifact contract | P0 |
| Provider registry API | P1 |
| Host agent (slots) | P2 |
| Matcher + queue | P3 |
| Base GHST escrow | P4 |
| Desk CLI / UX | P5 |
| Public Hub seat leasing | P6 (gates above) |

## Related docs

- [`GOTCHIBOT-HUB.md`](./GOTCHIBOT-HUB.md) — owned Hub + BYO
- [`AARCADE-HOST-NETWORK-BUILD.md`](./AARCADE-HOST-NETWORK-BUILD.md) — build phases
- Aarcade [`GOTCHIBOT-INSTALL-AUTH.md`](../../AarcadeGh-t/docs/GOTCHIBOT-INSTALL-AUTH.md) — install + `hub` status shape
- Aarcade [`GOTCHIBOT-HOME-API.md`](../../AarcadeGh-t/docs/GOTCHIBOT-HOME-API.md) — desk API / BYO Mongo
