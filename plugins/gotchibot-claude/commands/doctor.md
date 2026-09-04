---
description: Health check — env, layout, OpenClaw gateway, and what is actually broken
argument-hint: (no arguments — runs the full sweep)
allowed-tools: Bash(./scripts/gotchibot doctor:*), Bash(./scripts/gotchibot layout-check:*), Bash(./scripts/gotchibot mesh:*), Bash(node scripts/openclaw-fleet.mjs:*)
---

Work through these and report one consolidated verdict — do not stop at the
first green check:

```bash
./scripts/gotchibot doctor
./scripts/gotchibot layout-check check
./scripts/gotchibot mesh
```

If anything touching agent delivery looks wrong, probe the gateway directly:

```bash
node -e 'import("./scripts/openclaw-fleet.mjs").then(async m=>console.log(m.findOpenclawBin(), m.gatewayUrl(), await m.gatewayReachable()))'
```

Known failure shapes seen on this desk — name them rather than guessing:

- `openclaw-agent-failed` with `config is invalid` → `~/.openclaw/openclaw.json`
  has legacy keys; the fix is `openclaw doctor --fix` (Julius runs it — it is
  outside this tree).
- `http-402` on the HTTP fallback → quota/payment, not a config problem. Cool
  down per the model policy; do not retry in a loop.
- state DB "uses newer schema" → the openclaw binary is older than its state.

Report: what is healthy, what is broken, the one command that fixes each. Fix
nothing outside the GotchiBot tree yourself.
