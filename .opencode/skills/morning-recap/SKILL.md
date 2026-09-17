---
name: morning-recap
description: >-
  Morning meeting recap — before topic, choose Morning recap vs Meeting; wake
  agents on checklist tasks, present summaries with Q&A, then take today's goals.
  Load for /meet morning, overnight forgetfulness, standup.
license: MIT
compatibility: opencode
metadata:
  audience: orchestrator
  workflow: meet
---

# Morning recap

The meet **room is persistent**. Morning recap is a **recording** (`meet start --morning`)
on that room — `/end` stops the recording and writes minutes; the room stays for chat.

## Menu (unchanged meeting otherwise)

Cockpit **Start meeting** now asks:

1. **Meeting** — topic + invite (current flow)
2. **Morning recap** — topic auto-set to `morning meeting`, invite all gotchis

CLI:

```bash
./scripts/gotchibot meet start --morning   # topic + invite all
./scripts/gotchibot meet morning collect --host imac
./scripts/gotchibot meet morning present
# Q&A in meet room (@HERO …), then:
./scripts/gotchibot meet morning next    # or /recap-next in prompter
./scripts/gotchibot meet morning finish  # goals-ready line
./scripts/gotchibot meet end             # minutes + handoff.md
```

## Models

**Policy:** working models only — `config/model-policy.json` / skill **model-policy**.
Meet turns use `scripts/model-policy.mjs` (big-pickle → Zen free chain) before
OpenClaw. 402/429 models are cooled down and skipped.


[`config/morning-recap.json`](config/morning-recap.json) — `defaultTasks`, `byHero`, `byRole`.

```bash
./scripts/gotchibot meet morning tasks
./scripts/gotchibot meet morning tasks --hero starter-link-h1-1
```

## Overnight dept reports feed orch's prep

Every day at 03:00 America/Los_Angeles, each department desk posts a short report to the
orchestrator via the project **iMessage meet channel** (`./scripts/gotchibot meet say "…"`,
tagged for orch) — not AgentMail, not mail-courier. Orch collects those overnight reports
and preps the morning report (project overview, day's plan/workflow/goals, open issues
needing answers) before/with this recap. Policy text only — no cron installer here.

## Chair loop

1. Collect → each agent spawns, writes recap to `sessions/meetings/<id>/recaps/<hero>.md`
2. Present → transcript posts one agent at a time
3. Julius asks questions in room; `/recap-next` advances
4. Finish → "agents ready to take down today's goals"

## MCP

`gotchibot-meet`: `meet_morning_collect`, `meet_morning_present`, `meet_morning_next`, `meet_morning_tasks`

## Forbidden

- Inventing agent reports without collect
- Skipping invite-all on empty morning rooms
- `/model` to Claude — Claude is a tool (pane proxy)
