---
name: dossier-ai-cron-site
description: >-
  Use when extending GotchiBot's pstack dossier pane to show ai-cron-site agents,
  cron schedules, success/fail run history, and logged results. Pane UI only —
  partner data-ai-cron-site owns fetch/persist. Local ~/dev/GotchiBot only; never cloud.
---

# Dossier AI-Cron Site (pane UI)

## Job
Render ai-cron-site agents / schedules / run history / logs inside the **existing**
pstack dossier pane (`scripts/pstack-window.mjs`, mode `pstack-dossier`).

## Do
1. Read `scripts/pstack-dossier.mjs`, `scripts/pstack-window.mjs`, `config/pstack-dossier-policy.json`.
2. Read `scripts/cron402-client.mjs` + `mcp-servers/cron402` (or partner data layer) for real shapes.
3. Agree contract with `data-ai-cron-site`: agentId, name, schedule, lastRuns, status.
4. Extend the existing pane — no parallel UI, no invented cron rows.
5. Prove with a real local check; report files + verify steps.

## Don't
- Cloud agents / clone elsewhere
- Fake history or invented APIs
- Wallet / mint / spend
- Steal fetch/persist from `data-ai-cron-site`
