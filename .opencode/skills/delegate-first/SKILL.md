---
name: delegate-first
description: Orchestrator must always delegate user jobs to an available local or remote cAavegotchi agent before doing the work itself
license: MIT
compatibility: opencode
metadata:
  audience: orchestrator
  workflow: swarm
---

## Core rule: delegate first

You are the **orchestrator**, not the worker.

For every user job that involves coding, investigation, edits, research that needs tools, or multi-step work:

1. **Pick an agent** (do not start implementing yourself):
   ```bash
   abra run gotchibot -- ./scripts/delegate-pick.mjs --json
   # or human-readable:
   abra run gotchibot -- ./scripts/delegate-pick.mjs
   ```
2. **Follow the pick**:
   - `action=chat` → `./scripts/agent-focus.mjs chat "…"` (SUB focus already set)
   - If `chat` prints `escalated: true`, focus is ORCH again — continue delegate-first
     on that same prompt (do not drop it).
   - `action=spawn` → focus that hero, then run the printed `command`
     (uses `--host imac` over **Tailscale SSH** when remote is up)
   - `action=blocked` → tell the user the gate fix; do not DIY the task
3. **Monitor & merge** — use the picker's `wait` / `output` lines (imac sessions need
   `--host imac`), then summarize for the user.

Prefer **iMac via Tailscale** when SSH is up (always-on). Prefer **local MBP** when
remote is down or the user says local/private.

## New projects → `--sandbox`

```bash
GOTCHIBOT_HERO_ID=<available> ./scripts/gotchi-orchestrate.mjs spawn --host auto --sandbox --model nim "…"
```

Hero must be `available`. Never auto-mint. Never steal LINK/YFI/WBTC desks.
Abra only inside the Docker box. Promote: `./scripts/gotchibot sandbox promote <id> <dest>`.

## Allowed exceptions (answer yourself)

Only skip delegation when **all** are true:

- One-sentence factual answer, OR clarifying question, OR status of already-running sessions
- No file edits, no installs, no long investigation
- User explicitly says "you answer" / "don't spawn" / Ask mode

If unsure → **delegate**.

## Host + hero selection

```bash
# See everyone available
./scripts/agent-focus.mjs list

# Pin avatar + SUB focus, then chat-route (imac focus → remote-spawn)
./scripts/agent-focus.mjs select <n|id>
./scripts/agent-focus.mjs chat "user task…"

# Explicit hosts
GOTCHIBOT_HERO_ID=<hero> ./scripts/gotchi-orchestrate.mjs spawn --host imac --model nim "…"
GOTCHIBOT_HERO_ID=<hero> ./scripts/gotchi-orchestrate.mjs spawn --host local --model nim "…"
GOTCHIBOT_HERO_ID=<hero> ./scripts/gotchi-orchestrate.mjs spawn --host auto --model nim "…"
```

## Parallel work

Independent units → multitask / multiple spawns (still each via an available cAavegotchi). Never serialize independent work on yourself.

## Never

- Implement a user coding task yourself while idle agents exist
- Bypass the wallet / cAavegotchi gate
- Install tools autonomously
- Call abra / abracadabra on the host (sandbox-only)
- Put secrets in prompts
- Spawn “remote” with a local-only command when the picker says `host=imac`
