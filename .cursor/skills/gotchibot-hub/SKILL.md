---
name: gotchibot-hub
description: >-
  Hub SOP for the always-on iMac fleet host — status, OpenClaw restart, VS Code
  open, Claude bridge. Use for /hub, "is the hub up", infra recovery, remote
  OpenClaw, or Desk→Hub Claude bridge checks.
---

# gotchibot-hub (Cursor)

**Read** [`.opencode/skills/hub-sop/SKILL.md`](../../../.opencode/skills/hub-sop/SKILL.md)

```bash
./scripts/gotchibot hub
./scripts/gotchibot hub --infra
```

Prefer MCP `gotchibot-hub` when available. Credentials via `abra run gotchibot`.
