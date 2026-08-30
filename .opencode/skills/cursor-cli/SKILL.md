---
name: cursor-cli
description: >-
  Load whenever coding, debugging, writing patches, or investigating a repo.
  Bot stays on Hy3 Free (opencode/hy3-free) or Nemotron 3 for talk/route/task.
  Hard logic/code goes through ./scripts/cursor-cli.mjs → cursor-agent (Cursor subscription).
  Do not switch OpenCode's model to Cursor. Do not add a Cursor provider.
license: MIT
compatibility: opencode
metadata:
  audience: orchestrator
  workflow: cursor-bridge
---

# Cursor CLI (default for hard logic)

OpenCode **stays** on **Hy3 Free** (`opencode/hy3-free`, default) or **Nemotron 3** (Lightning / Ultra via `/model heavy`) for talking, routing, spawning, and summarizing.

**Cursor Agent CLI** is the default for coding, debugging, patches, and repo investigation. OpenCode cannot attach Julius's Cursor subscription. Do **not** switch the OpenCode model to Cursor. Do **not** add a Cursor provider. Do **not** put Cursor API keys into OpenCode.

Load this skill whenever the job is coding / debugging / patches / investigation — not only when Julius says "Cursor".

## Split

| Layer | Model | Does |
| --- | --- | --- |
| Bot (gotchi / verse / plan / build) | Hy3 Free default, Nemotron 3 ok | Talk, route, spawn cAavegotchi swarm, summarize |
| Hard logic | `cursor-agent` via wrapper (logged-in Pro+) | Code, debug, investigate, write patches |

Spawn OpenCode sub-bots (cAavegotchi identities) still uses Hy3/auto. Those sub-bots **also** pass hard logic to `cursor-cli.mjs` instead of implementing it on Nemotron/Hy3.

## Invoke (wrapper only)

Never call Grok `~/.grok/bin/agent`. Never `cursor agent` as the primary binary. Never `--api-key`. Never dump `cursor-agent --help` into chat. Never ask Julius for secrets.

```bash
./scripts/cursor-cli.mjs run "self-contained prompt: goal, constraints, repo path, done criteria"
./scripts/cursor-cli.mjs run "…" --cwd /Users/juliuswong/Dev/GotchiBot
./scripts/cursor-cli.mjs run "…" --mode plan
./scripts/cursor-cli.mjs run "…" --mode ask
./scripts/cursor-cli.mjs resume "follow-up in the same Cursor chat"
./scripts/cursor-cli.mjs status
```

Headless `run` always execs `$HOME/.local/bin/cursor-agent --print --output-format text --workspace <cwd> --trust`. Default model is the subscription **Auto** — omit `--model` unless Julius named one.

`--force` is optional (unattended writes). Do not pass `--api-key`.

Interactive TTY: `./scripts/cursor-cli.mjs launch "…"`. Prefer `run` from OpenCode.

Preview bundled handoff/pin/sub-agent context: `./scripts/cursor-cli.mjs context "…"`.

## Prompt shape

Hand a **self-contained** prompt (goal, constraints, repo path, done criteria). Do not micromanage line edits. Then summarize the CLI output back to Julius in first person as the gotchi. Mention `sessions/c*/output.md` + chat id for resume. Do not paste the raw help text.

## Where it runs

**Both hosts** have Cursor Agent CLI at `$HOME/.local/bin/cursor-agent` (logged-in Pro+). Run this wrapper on **whichever machine the agent is on** — MBP or iMac.

```bash
./scripts/cursor-cli.mjs status   # confirms binary + login (no secrets)
./scripts/cursor-cli.mjs run "…"  # same on MBP or iMac
```

- Prefer local invoke on the current host. Do **not** skip hard logic because you are on the iMac.
- If spawning over SSH and `cursor-agent` is missing from PATH, use the full path `~/.local/bin/cursor-agent` or set `CURSOR_AGENT_BIN` — do not fall back to writing skill files by hand as a substitute for Cursor.
- `CURSOR_API_KEY` must stay unset (logged-in subscription). Never `--api-key`. Never Grok `~/.grok/bin/agent`.

## After run

Summarize. Stay on Hy3/Nemotron for the reply. Do not change OpenCode `/model` to Cursor.
