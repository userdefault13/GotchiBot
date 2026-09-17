# cron-hints — cron-manager

- Schedule truth: `./scripts/gotchibot moltbook schedule status` is the only source of truth for whether the desk's waker is loaded.
- cron402: webhook crons live in Gotchi-Trader config/cron402-jobs.json; status via `npm run cron402 -- status` / mcp-cron402. Never invent a cron402 job a status command does not confirm.
