# Friends beta — install token rollout

Per-install auth for Solo GotchiBot (`GOTCHIBOT_INFRA_TOKEN`). Server details:
[AarcadeGh-t `docs/GOTCHIBOT-INSTALL-AUTH.md`](../../AarcadeGh-t/docs/GOTCHIBOT-INSTALL-AUTH.md).

## Phase 0 — defaults (safe ship)

| Component | Env | Effect |
|-----------|-----|--------|
| Aarcade API | `GOTCHIBOT_ENFORCE_INSTALL_TOKEN=0` (default) | Register + validate work; missing token only logged |
| Envio proxy | `SUBGRAPH_PROXY_ENFORCE=warn` (default) | Anonymous tunnel GraphQL logged, not blocked |
| Julius desk | No `GOTCHIBOT_INFRA_TOKEN` | Unchanged — abra operator secrets only |

## Phase 1A — Deploy gate checklist (Julius ops)

Do these on **Vercel (AarcadeGh-t / www)** and the **iMac Envio proxy**. Code is already in-repo; this is flip-the-switch work.

- [x] Deploy AarcadeGh-t to Vercel with install-auth routes (`/api/gotchibot/register`, `/api/gotchibot/install/status`, middleware on subgraph / owned-gotchis / cartridge-sim).
- [x] Confirm Mongo collection `gotchibot_install_tokens` + indexes exist.
- [x] Set `GOTCHIBOT_INSTALL_ALLOWLIST=0xFriend1,0xFriend2,…` (comma wallets). **Do not leave empty** if the GotchiBot repo is public — empty allowlist = open register.
- [ ] Friend smoke: `./scripts/gotchibot onboard` → doctor shows solo install token valid. *(Julius wallet on allowlist; run `onboard` once with MetaMask sign — abra `EVM_PRIVATE_KEY` ≠ connected wallet.)*
- [x] Julius regression: `abra run gotchibot -- ./scripts/gotchibot doctor` → `legacy operator secrets`.
- [x] Flip `GOTCHIBOT_ENFORCE_INSTALL_TOKEN=1` on Vercel (www GotchiBot-facing routes).
- [x] Re-smoke friend + Julius. *(Julius regression green; friend onboard pending MetaMask sign.)*
- [x] Tunnel: `SUBGRAPH_PROXY_ENFORCE=hard` on iMac graphql-proxy (+ `GOTCHIBOT_SUBGRAPH_PROXY_KEY` in abra for legacy tunnel path).

## Invite playbook

### Julius

1. Friend shares wallet (`./scripts/gotchibot wallet` after connect, or MetaMask address).
2. Vercel → Aarcade project → **Environment Variables** → set/update `GOTCHIBOT_INSTALL_ALLOWLIST` (append `0x…`, lowercase ok).
3. Redeploy if the env change does not hot-reload on serverless.
4. Tell friend: clone GotchiBot → `./scripts/gotchibot onboard`.

### Friend

1. Install **abracadabra** + `tmux` + Node ≥ 18 (macOS, Linux, or Windows/WSL2 — see [SOLO-LINUX-WINDOWS.md](./SOLO-LINUX-WINDOWS.md)).
2. `npm i -g @userdefault/abracadabra @userdefault/gotchibot` → `abra doctor` → `./scripts/gotchibot onboard`.
3. BYO models: `abra set gotchibot OPENCODE_API_KEY` (never paste into chat/git).
4. `./scripts/gotchibot tmux` (WSL2 on Windows).

No Julius operator secrets. Token lives only in **their** abra as `GOTCHIBOT_INFRA_TOKEN`.

### Revoke

1. Mongo `gotchibot_install_tokens`: set `{ revoked: true }` on matching `wallet` (+ `installId` if needed).
2. Remove wallet from `GOTCHIBOT_INSTALL_ALLOWLIST` to block **new** registers.
3. Optional: `./scripts/gotchibot infra-usage` to confirm they stop showing fresh `lastUsedAt`.

## Cost learning (usage report)

Install tokens count API hits by kind (`subgraph`, `cartridge`, `owned_gotchis`, `status`). Status probes do **not** burn daily quota.

```bash
# from GotchiBot (sibling AarcadeGh-t + Mongo via abra):
./scripts/gotchibot infra-usage
./scripts/gotchibot infra-usage --json

# or directly in AarcadeGh-t:
abra run AarcadeGh-t -- node scripts/infra-usage-report.mjs
```

**Cost proxy** (fill after 1–2 weeks of Vercel / Envio / DO bills):

```text
cost_proxy ≈ subgraph_calls * UNIT_SUBGRAPH
           + cartridge_writes * UNIT_CARTRIDGE
           + owned_gotchis * UNIT_OWNED
```

Set env when reporting: `GOTCHIBOT_UNIT_COST_SUBGRAPH`, `GOTCHIBOT_UNIT_COST_CARTRIDGE`, `GOTCHIBOT_UNIT_COST_OWNED` (defaults `0` = unset). Use the report to estimate **cost per active wallet** before inventing Golden/Silver prices.

## Phase 2 — Solo smoke (clean Mac)

```bash
./scripts/gotchibot onboard
./scripts/gotchibot tmux
```

Expected: doctor shows `solo install token` + valid status; init mints cartridge via www API; no operator secrets required.

## Phase 3 — Julius regression

Without `GOTCHIBOT_INFRA_TOKEN` in abra:

```bash
abra run gotchibot -- bash -c 'unset GOTCHIBOT_INFRA_TOKEN; ./scripts/gotchibot doctor'
abra run gotchibot -- bash -c 'unset GOTCHIBOT_INFRA_TOKEN; ./scripts/gotchibot init'   # if needed
abra run gotchibot -- bash -c 'unset GOTCHIBOT_INFRA_TOKEN; ./scripts/gotchibot roster --wallet'
```

Expected: `legacy operator secrets`; direct tunnel + service key path unchanged.

**Status (2026-09-01):** ✓ doctor → legacy operator secrets; tunnel subgraph 200; roster 23 gotchis; init idempotent.

## Phase 4 — flip API enforcement

1. Set `GOTCHIBOT_ENFORCE_INSTALL_TOKEN=1` on Vercel (www routes).
2. Re-run Solo smoke — anonymous GotchiBot clients must 401.
3. Re-run Julius regression — still green with operator secrets.

**Status (2026-09-01):** enforced on Vercel; anonymous `/api/subgraph/*` returns 401.

## Phase 5 — flip tunnel enforcement

On iMac Envio compat proxy (`aavegotchi-envio-indexers`):

1. `SUBGRAPH_PROXY_ENFORCE=warn` for ~48h — watch logs for stray anonymous clients.
2. `SUBGRAPH_PROXY_ENFORCE=hard` — naked `subgraph.aarcadeghst.com` GraphQL requires `X-Subgraph-Proxy-Key`.
3. Confirm Vercel `subgraphUpstream.cjs` and Julius abra still forward operator secret.

**Status (2026-09-01):** hard mode live on iMac graphql-proxy; `GOTCHIBOT_SUBGRAPH_PROXY_KEY` in abra; Julius legacy subgraph queries green.

## Test matrix

| Case | Expected | Verified |
|------|----------|----------|
| No topology file, no install token, abra secrets | Legacy Julius path | ✓ |
| Solo + install token, no operator secret | register → init → roster via www | pending onboard sign |
| Invalid/revoked token | 401 on API; doctor fail with fix hint | ✓ (no_token / invalid) |
| Token wallet ≠ query owner | 403 on owned-gotchis / cartridge ensure | — |
| Anonymous `subgraph.*` after tunnel hard | 401 | ✓ |
| SPA `/api/subgraph` in browser | Still works (no GotchiBot token required) | — |

## Roadmap (deferred — not this beta)

| Later | Notes |
|-------|--------|
| Golden cartridge (first ~2k signups) | Signup counter + cartridge / token `tier` metadata |
| Silver (next ~5k) + 50% off infra | Needs list price first; store `infraDiscount` on token doc |
| $10/mo Infra Pass | Stripe or Base NFT — plugs into same entitlement fields |
| Bundle abra into GotchiBot | Keep abra as separate Mac install |
| Public open register | Stay allowlist-gated until cost model is known |
