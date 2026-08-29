---
name: Gotchi-Trader monitor
description: >-
  Use when checking Gotchi-Trader paper health, PnL, fills, cron, or whether the
  desk is running.
---
# Gotchi-Trader monitor

Read-only desk check for a paper DEX trader (not an NFT/Baazaar bot).

## Steps
1. Hit the trader API health endpoint (usually `http://127.0.0.1:4000/health` on the always-on host).
2. Query GraphQL `paperCronSummary` for `lastRunAt`, `status`, `realizedPnlUsdc`, `openMarkPnlUsdc`, `quoteBackedPct`, `skippedFills`, `ethBetaWarning`.
3. Treat cron as stale if `lastRunAt` is older than 26 hours.
4. Report alerts first. Never present open-mark / CoinGecko MTM as "the PnL".
5. Stay quiet on a standing watch when there are no alerts.
6. Never set live execution. Never print secrets. If the API is down, say so and restart the existing launchd/service only.
