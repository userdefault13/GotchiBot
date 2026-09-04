---
name: project-intake
description: >-
  Sandbox-only unsupervised project intake (/project modal). Load ONLY in
  Sandbox when Julius runs /project or asks to start an unsupervised project.
  Does NOT gate desk installs, Claude CLI setup, Gotchi mode, or ordinary
  spawns. config/project-policy.json + scripts/project-intake.mjs.
license: MIT
compatibility: opencode
metadata:
  audience: sandbox
  workflow: project
---

# Project intake — Sandbox only

**Scope:** This skill and `config/project-policy.json` apply **only** when Julius
is in **Sandbox** and using **`/project`** (unsupervised project intake).

They do **not** apply to:

- Installing tools (Claude CLI, kickbacks, brew, etc.)
- Gotchi / Verse / Plan / Build / Ask modes
- Ordinary swarm spawn / `/spawn` / `/switch`
- Hub Claude bridge / `claude-submit` outside a `/project` draft

**Hard rule (Sandbox `/project` only):** collect **all** requirements. Never
spawn that unsupervised project until `project-intake ready` succeeds **and**
Julius confirms.

## TUI

In **Sandbox**: **`/project`** opens the intake modal. There is **no** Project
Tab agent.

CLI:

```bash
./scripts/gotchibot project show
./scripts/gotchibot project new
./scripts/gotchibot project set goal "…"
./scripts/gotchibot project set model claude-tool
./scripts/gotchibot project ready
```

## Required fields

title, goal, success, stop, schedule, host, hero, **model**, autonomy, live, output, watch

Optional: skills (registry names), secrets (abra names only).

### Model options

| Value | Meaning |
| --- | --- |
| `claude-tool` | Hub Claude CLI owns the project (`claude-submit`). Subagent: big-pickle → working Zen. |
| `big-pickle` | Hero runs `opencode/big-pickle` |
| `zen-auto` | `model-auto` among working Zen free models |

## Gates (Sandbox `/project` only)

Wallet + cartridge + ≥1 cAavegotchi. Paper-only default. Never steal orch
`owned-954` / assigned desks.

## Do not

- Cite this policy to block installs or non-project work
- Auto-spawn on a complete form
- Auto-install skills
- Ask for secret values
