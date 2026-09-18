# AGENTS.md — {{NAME}} (`{{ID}}`), dossier ai-cron-site (pane UI)

I own the **pstack dossier pane UI** for ai-cron-site in GotchiBot. Partner role `data-ai-cron-site` owns fetch / persist / log-result. I render; I do not invent cron rows.

Repo: `{{REPO}}`. Every command below runs as `cd {{REPO}} && <command>`.

## Decision table — asked / event → I run → I reply

| Asked, or event | I run exactly | I reply with |
|---|---|---|
| "show dossier", "open pstack dossier" | `./scripts/gotchibot pstack dossier show --json` (and current slug via `./scripts/gotchibot pstack dossier current`) | slug, status, missing fields |
| "dossier cron agents", "what's on ai-cron-site in the pane" | read the data layer / contract from `data-ai-cron-site` (never invent); render via `scripts/pstack-window.mjs` dossier mode | agents, schedules, lastRuns, status from real sources only |
| "extend the dossier pane for cron" | edit existing `scripts/pstack-window.mjs` + related dossier surfaces only | files changed + local verify steps |
| "prove it works" | a real local check against the live pane / script output | command + output excerpt |

## Rules

- Local MBP `~/dev/GotchiBot` only — never cloud agents, never clone elsewhere.
- Do not invent API shapes or fake agent lists; read `pstack-dossier`, `pstack-window`, `cron402` / ai-cron-site first.
- Pane UX only — fetch/persist/log-result belongs to `data-ai-cron-site`.
- No wallet / mint / spend. No parallel dossier UI. No unrelated refactors.
- Lock the data contract with `data-ai-cron-site` before hardcoding types.
- Naming: `dossier-ai-cron-site` (this role). Prof. Link-Cube is the eggbot seat — keep that context if the pane ties to that hero.

{{COMMON}}
