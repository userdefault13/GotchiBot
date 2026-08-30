---
name: aarcadeghst-changes
description: >
  Skill for passing AarcadeGh-t frontend changes to BTC bot 22899 (owned-22899).
  Tracks UI changes in the AarcadeGh-t My Paarcels (/mypaarcel) area:
  surveys, bounce gate images, left column narrowing, installations drawers.
  Enables BTC bot to read, write, and sync these changes across the GotchiBot
  infrastructure.
type: skill
---

# aarcadeghst-changes

This skill provides the infrastructure for GotchiBot agents (especially BTC Bot #22899,
`owned-22899`, amWBTC) to pass AarcadeGh-t frontend changes back and forth. It is
intended to complement the My Paarcels UI plan (surveys, bounce gate, left column,
installations drawers) by providing a persistent mechanism for tracking and syncing
these changes.

## Scope

- **AarcadeGh-t frontend changes** — UI modifications in `/mypaarcel`:
  - Surveys: round alchemica data fetching and display (rounds 0..surveyRound-1)
  - Bounce Gate: correct tile art (remove 145 → northGate override, fix spritesheet frame)
  - Left column: narrowed from 430px to 280px, expanded right panel from 900px to 1100px
  - Installations: collapsible drawers grouped by kind (Altar, Harvester, Reservoir, Bounce Gate, Other)
- **BTC Bot 22899** — `owned-22899` (amWBTC) assigned to handle AarcadeGh-t work
- **Sync mechanism** — persistent role assignment via `scripts/hero-agent-state.mjs`
- **GotchiBot infrastructure** — iMac Docker, :8787 subgraph, Cloudflare tunnel, cartridge-sim

## Detection

Check that BTC Bot 22899 has the AarcadeGh-t role assigned:

```bash
abra run gotchibot -- node scripts/hero-agent-state.mjs get owned-22899
```

Expected output includes `task: "Handle AarcadeGh-t (My Paarcels / product surface)"`.

Check that the AarcadeGh-t plan is recorded:

```bash
ls ~/.cursor/plans/MyLand/
```

Expected: `surveys UI-7993409c.plan.md` and related plan files.

## Sync Protocol

### 1. Assign BTC Bot to AarcadeGh-t task

```bash
abra run gotchibot -- node scripts/hero-agent-state.mjs set owned-22899 assigned \
  --task "Handle AarcadeGh-t (My Paarcels / product surface)" \
  --host local
```

### 2. BTC Bot reads AarcadeGh-t changes

The bot can reference the plan file at `~/.cursor/plans/MyLand/surveys UI-7993409c.plan.md`
and the associated implementation files in `/Users/juliuswong/Dev/AarcadeGh-t/`.

### 3. BTC Bot writes/syncs changes

After implementing AarcadeGh-t changes, the bot should:

```bash
# Record the sync date and changes
echo "## $(date -u +%Y-%m-%dT%H:%M:%SZ) — aarcadeghst-changes sync" \
  >> ~/.hero-agent-state.json

# Or use the GotchiBot sync mechanism
abra run gotchibot -- node scripts/hero-agent-state.mjs set owned-22899 assigned \
  --task "Handle AarcadeGh-t (My Paarcels / product surface)" \
  --host local
```

## Files Touched

Typical AarcadeGh-t changes touch these files in `/Users/juliuswong/Dev/AarcadeGh-t/`:

| File | Change |
|------|--------|
| `src/composables/useParcelRealmDetail.ts` | Fetch + sum `getRoundAlchemica` for prior rounds |
| `src/components/MyLand/ParcelRealmPanel.vue` | Surveys totals UI; install drawers |
| `src/helpers/installationThumbs.ts` | Remove 145 → northGate override; fix spritesheet frame |
| `src/helpers/parcelInstallStatus.ts` | Bounce Gate kind label |
| `src/views/MyLand.vue` | Left column + page width tweaks |

## Escalation

If AarcadeGh-t changes cannot be implemented or synced after 3 attempts:

1. Append a dated alert to `sessions/infra-alerts.md`:
   ```markdown
   ## <ISO8601> — aarcadeghst-changes escalation
   - failed changes: <surveys|bounce-gate|left-column|installations>
   - attempts: 3
   - last error: <message>
   - action: notify orchestrator
   ```
2. Notify the orchestrator (`owned-954`) so a human/agent can inspect the AarcadeGh-t repo
   or provide guidance on the implementation approach.

## Safety

- **No autonomous installs.** If a tool is missing, request it; don't `npm i` or modify
  package.json without approval.
- **Secrets via abracadabra only.** If a change requires a credential (e.g. wallet bind),
  ask the orchestrator to fetch it through `abra`.
- **No Blockscout / no token-id hunting.** Never hit Blockscout for NFT token ids when
  working on AarcadeGh-t UI changes.
- **Paper-only for sim changes.** Cartridge-sim :8791 changes are simulation only; no
  mainnet writes.