---
name: data-ai-cron-site
description: >-
  Patch-dossier data layer for ai-cron-site / cron402: fetch schedules, success/fail
  history, and result logs into pstack dossier (no second cron store). Load when Julius
  asks for cron history, dossier cron data, or data-ai-cron-site work. Partner
  dossier-ai-cron-site owns the pane UI.
license: MIT
compatibility: opencode
metadata:
  audience: agents
  workflow: pstack-dossier
---

# data-ai-cron-site

Wire **real** cron402 surfaces into the patch dossier data contract.

## Commands

```
./scripts/pstack-dossier-cron.mjs fetch [--slug <slug>] [--json]
./scripts/pstack-dossier-cron.mjs persist --slug <slug> [--json]
./scripts/pstack-dossier-cron.mjs show [--slug <slug>] [--json]
```

## Rules

- SoT: `~/.cron402/jobs.json` + `GET {CRON402_API_URL}/v1/crons/:id`
- Never invent executions. Empty store → empty `agents: []`.
- Field names stay cron402's: `jobId`, `schedule`, `status`, `credits`, `runAt`, `ok`, `statusCode`, `error`, `durationMs`.
- UI is `dossier-ai-cron-site` / `pstack-window.mjs` — do not build the pane.
