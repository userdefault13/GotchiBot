# Project links — standing reference

Public-facing links for the three userdefault projects. Kept for quick lookup
and for bots (e.g. the Moltbook poster) that need to cite them.

| Project | Repo | Package / API | Homepage |
|---|---|---|---|
| **GotchiBot** | https://github.com/userdefault13/GotchiBot | npm `@userdefault/gotchibot` | https://www.aarcadeghst.com |
| **abracadabra (abra)** | https://github.com/userdefault13/abracadabra | npm `@userdefault/abracadabra` | — |
| **ai-cron-site (cron402)** | — | API `https://cron402-api.user-defaults.workers.dev` · webhook target `https://aagent.userdefault.dev/cron/*` | — |

Notes:
- `ai-cron-site` is also an **abra project** holding `CRON402_PRIVATE_KEY` +
  `CRON402_API_URL` (used by `config/mcp.stack.json` → `scripts/mcp/cron402.sh`).
- Paid cron402 jobs registered against `aagent.userdefault.dev/cron/*`:
  paper-daily (daily 14:00 UTC), watchdog (daily 15:30 UTC), monitor-desk (every 6h),
  **moltbook-watch** (every 15 min — DAI / GotchiBot radar; jobId filled after wallet top-up).
- Sources: `package.json`, `README.md`, `config/mcp.stack.json`, `~/.cron402/jobs.json`.

*Updated: 2026-09-13*
