---
name: ask-mode
description: Switch to read-only Ask mode for Q&A without file edits or sub-agent spawns
license: MIT
compatibility: opencode
metadata:
  audience: user
  workflow: read-only
---

## What Ask mode is

Cursor-style **read-only chat**: explain code, answer questions, no edits.

## Switch to Ask

- **Tab** — cycle primary agents until the indicator shows **Ask** (Shift+Tab reverse)
- CLI: `./scripts/gotchibot mode ask --restart`

Autocomplete in the prompt uses **Ctrl+Space** (Tab is reserved for agent cycle).

## Switch back to work mode

- **Tab** to **Gotchi** (orchestrator + spawns)
- CLI: `./scripts/gotchibot mode gotchi --restart`

## Ask vs Plan vs Gotchi

| Agent | Edits | Spawns | Use for |
| --- | --- | --- | --- |
| **ask** | never | never | Questions, explanations |
| **plan** | plans only | no | Design before building |
| **gotchi** | with approval | yes | Orchestration + sub-agents |

Do not spawn sub-agents or edit files while in Ask mode.
