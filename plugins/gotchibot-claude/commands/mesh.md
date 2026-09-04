---
description: Agent count and status across the MBP and iMac (read-only)
argument-hint: [ping | --live | --json]
allowed-tools: Bash(./scripts/gotchibot mesh:*), Bash(node scripts/mesh-status.mjs:*)
---

```bash
./scripts/gotchibot mesh $ARGUMENTS
```

- bare → instant view from the `sessions/.focus-list.json` cache
- `--live` → re-scan the iMac over Tailscale SSH (slower, fresh)
- `ping` → Tailscale + SSH reachability probe, names the exact blocker

Read-only: this never spawns or controls a peer. If the iMac block says
`unreachable`, report the reason it prints and stop — do not try to fix the SSH
setup on your own.

Skill: **gotchibot-mesh**.
