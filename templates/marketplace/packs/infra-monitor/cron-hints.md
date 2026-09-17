# cron-hints — infra-monitor

- Schedule truth: `./scripts/gotchibot infra schedule status` is the only source of truth for whether the desk's waker is loaded.
- launchd: iMac LaunchAgents are installed per-desk (`gotchibot <desk> schedule install`); `schedule status` confirms load + last run.
