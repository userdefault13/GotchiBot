---
name: cron-manager
description: >-
  Fleet cron desk powered by ai-cron-site (cron402): schedule, preview, create,
  topup, list, pause, resume, delete webhook crons for any GotchiBot agent.
  Load for /cron, "schedule a wake", "list crons", or when another hero needs a
  repeating job. Paid tools spend USDC — confirm first.
license: MIT
compatibility: opencode
metadata:
  audience: agents
  workflow: scheduling
---

# cron-manager

GotchiBot's **cron manager** role. Backend: **ai-cron-site / cron402** (x402 USDC on Base). We dogfood it so every agent can get a reliable wake without inventing launchd.

## When to load

- Julius or a hero asks to schedule, list, pause, topup, or delete a cron
- "wake X every 15 minutes", "is cron402 up", "job credits"
- Mapping a desk (moltbook / infra / trader / comms) to a cloud waker

## MCP first

Use MCP namespace `cron402` (see `config/mcp.stack.json`). Procedure:

1. `cron402_guide` (free)
2. `check_wallet` (free) — if unset, stop: abra project `ai-cron-site` needs `CRON402_PRIVATE_KEY` + `CRON402_API_URL`
3. `preview_schedule` (free) — show next runs; get confirm
4. `create_cron` **once** (paid $0.008, includes 1 credit) — report **jobId**
5. `topup_cron` (paid) so it does not die after one fire
6. `list_crons` / `get_cron` / `pause_cron` / `resume_cron` / `delete_cron` for ops

## Rules

- Never double-call paid tools for one request
- Never schedule `localhost`
- Never invent a schedule — quote MCP or desk `schedule status` output
- Local `gotchibot … schedule install` is fallback only, on the iMac, after Julius yes
- Do not steal LINK/YFI/WBTC standing product work — only coordinate wakes

## Desk catalog (dogfood)

| Need | cron402 target pattern |
|---|---|
| Moltbook | `POST https://aagent.userdefault.dev/cron/moltbook-watch` |
| Custom | public HTTPS webhook the desk already exposes |
| Trader / infra | prefer cron402 when ingress exists; else document launchd status CLIs |

See `docs/PROJECT-LINKS.md` and role template `config/openclaw/templates/AGENTS.cron-manager.md`.
