---
name: cursor-cli
description: Delegate user prompts to Cursor CLI Agent with orchestrator-managed context (handoff, sub-agents, pin)
license: MIT
compatibility: opencode
metadata:
  audience: orchestrator
  workflow: cursor-bridge
---

## When to use Cursor CLI

Use **Cursor Agent** (not OpenCode sub-agents) when:

- The user asks for Cursor specifically, or wants IDE-grade agent tooling
- A task needs Cursor models / MCP / write access outside the cAavegotchi spawn gate
- You want a **persistent Cursor chat** with follow-ups (`resume`)

Use **OpenCode sub-agents** (`gotchi-orchestrate spawn`, `/multitask`) when:

- Parallel gated swarm work with cAavegotchi identities
- Routine fan-out under `sessions/s*/`

## Orchestrator manages context

**Do not** pass raw user text to `cursor agent` alone. Always use the wrapper — it bundles:

- `sessions/HANDOFF.md` (prior work)
- Recent sub-agent `output.md` summaries
- Active avatar pin (`sessions/.pin`)
- The user's prompt

Preview context:

```bash
./scripts/cursor-cli.mjs context "user prompt here"
```

## Headless (recommended from OpenCode)

```bash
./scripts/cursor-cli.mjs run "implement X" [--mode plan|ask] [--new-chat] [--json]
```

Returns output; saves to `sessions/c*/output.md` and tracks Cursor chat id in `sessions/.cursor-cli.json`.

Follow-up in same Cursor chat:

```bash
./scripts/cursor-cli.mjs resume "continue with tests"
```

## Interactive (user TTY)

```bash
./scripts/cursor-cli.mjs launch "user prompt" [--mode plan|ask]
```

Run from a real terminal (or tell the user to). OpenCode gotchi should prefer `run` unless the user wants an interactive Cursor session.

## Chat management

```bash
./scripts/cursor-cli.mjs create --label "feature X"
./scripts/cursor-cli.mjs list
```

## Modes

Pass through to Cursor Agent:

- `--mode ask` — read-only Q&A
- `--mode plan` — plan before edits

## Requirements

- `cursor` on PATH (`cursor agent --help`)
- User logged in: `cursor agent status`
- Project MCP: `.cursor/mcp.json` (already configured for GotchiBot)

## After run

Summarize the Cursor result for the user. Mention `sessions/c*/output.md` and chat id for resume.
