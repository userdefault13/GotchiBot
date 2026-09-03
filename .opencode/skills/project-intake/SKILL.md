---
name: project-intake
description: >-
  Unsupervised agent project intake. Load for /project, Project mode, standing
  agents, or “start an unsupervised project”. Collect every requirement before
  spawn. config/project-policy.json + scripts/project-intake.mjs.
license: MIT
compatibility: opencode
metadata:
  audience: orchestrator
  workflow: project
---

# Project intake — unsupervised agents

**Hard rule:** prompt Julius with **all** requirements. Never spawn until
`project-intake ready` succeeds **and** he confirms.

## Commands

```bash
./scripts/gotchibot project show
./scripts/gotchibot project new
./scripts/gotchibot project set goal "…"
./scripts/gotchibot project ready
```

TUI: `/project` (agent **project**, orange).

## Required fields

title, goal, success, stop, schedule, host, hero, autonomy, live, output, watch

Optional: skills (registry names), secrets (abra names only).

## Gates

Wallet + cartridge + ≥1 cAavegotchi (`wallet-gate`). Paper-only default.
Live needs explicit confirm. Never steal assigned desks / orch `owned-954`.

## Do not

- Auto-spawn on a complete form
- Auto-install skills
- Ask for secret values
- Skip the full list on first `/project`
