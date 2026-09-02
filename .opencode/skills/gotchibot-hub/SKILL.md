---
name: gotchibot-hub
description: Monitor the always-on Hub (iMac OpenClaw fleet host) from the Desk — SSH, gateway, sessions, tunnel, Docker
license: MIT
compatibility: opencode
metadata:
  audience: orchestrator
  workflow: fleet
---

# GotchiBot Hub

**Desk** = local tmux cockpit (MBP). **Hub** = always-on iMac where OpenClaw bots live (Tailscale).

## Commands

```bash
abra run gotchibot -- ./scripts/gotchibot hub --live
abra run gotchibot -- ./scripts/gotchibot hub --infra
abra run gotchibot -- ./scripts/gotchibot hub --json
```

OpenCode: `/hub` or `/hub infra`. Cockpit: Hub status / Hub infra.

## Do not

- Invent container or gateway state — run the command.
- Modify theme or color files.
- Add this skill to `skills/registry.json` without Julius approval.
