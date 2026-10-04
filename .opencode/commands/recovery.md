---
description: Guided Tailscale Hub and desk recovery setup
---

For `$ARGUMENTS` empty or `status`, run `./scripts/gotchibot recovery status` and summarize the actual ready/degraded/stale result for UserDefault.

For `setup`, direct UserDefault to run `./scripts/gotchibot recovery setup` in their terminal. It is an interactive wizard and must inherit a real TTY so UserDefault can answer its prompts and approve service/policy changes. Do not run it headlessly or answer its confirmations for the user.

For `once`, run `./scripts/gotchibot recovery once` only when UserDefault requests a repair cycle. The cycle can restart configured services and synchronize paired Hub state.

Never access host abra, relay login links, or fabricate healthy status. Details: `docs/RECOVERY.md`.
