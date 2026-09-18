---
name: cursor-cli
description: >-
  Load for ALL agent work: edits, debugging, patches, investigation, desk
  deliverables, wake-cycle units. Bot stays on big-pickle / Nemotron / Hy3 for
  talk/route/spawn/summarize only. Work goes through ./scripts/cursor-cli.mjs →
  cursor-agent. Do not switch OpenCode's model to Cursor. Do not DIY on the chat model.
license: MIT
compatibility: opencode
metadata:
  audience: everyone
  workflow: cursor-bridge
---

# Cursor CLI (mandatory for all work)

OpenCode / OpenClaw **stays** on **big-pickle** / **Nemotron** / **Hy3** for talking,
routing, spawning, and summarizing.

**Cursor Agent CLI** is mandatory for **all work**: coding, debugging, patches,
repo investigation, desk deliverables, wake-cycle units. OpenCode cannot attach
UserDefault's Cursor subscription. Do **not** switch the OpenCode model to Cursor.
Do **not** add a Cursor provider. Do **not** put Cursor API keys into OpenCode.
Do **not** implement the work yourself on the chat model and call it done.

Load this skill whenever the job is work — not only when UserDefault says "Cursor",
and not only for "hard logic".

## Split

| Layer | Model | Does |
| --- | --- | --- |
| Bot (gotchi / verse / plan / talk) | big-pickle default, Nemotron ok | Talk, route, spawn cAavegotchi swarm, summarize |
| **All work** | `cursor-agent` via wrapper (logged-in Pro+) | Code, debug, investigate, write patches, desk deliverables |

Spawn OpenCode sub-bots (cAavegotchi identities) still use big-pickle/auto for the
session shell. Those sub-bots **must** pass the work to `cursor-cli.mjs` instead of
implementing it on Nemotron/Hy3/big-pickle.

## Invoke (wrapper only)

Never call Grok `~/.grok/bin/agent`. Never `cursor agent` as the primary binary. Never `--api-key`. Never dump `cursor-agent --help` into chat. Never ask UserDefault for secrets.

```bash
./scripts/cursor-cli.mjs run "self-contained prompt: goal, constraints, repo path, done criteria"
./scripts/cursor-cli.mjs run "…" --cwd ~/Dev/GotchiBot
./scripts/cursor-cli.mjs run "…" --mode plan
./scripts/cursor-cli.mjs run "…" --mode ask
./scripts/cursor-cli.mjs resume "follow-up in the same Cursor chat"
./scripts/cursor-cli.mjs status
```

Headless `run` always execs `$HOME/.local/bin/cursor-agent --print --output-format text --workspace <cwd> --trust`. Default model is the subscription **Auto** — omit `--model` unless UserDefault named one.

`--force` is optional (unattended writes). Do not pass `--api-key`.

Interactive TTY: `./scripts/cursor-cli.mjs launch "…"`. Prefer `run` from OpenCode.

Preview bundled handoff/pin/sub-agent context: `./scripts/cursor-cli.mjs context "…"`.

## Prompt shape

Hand a **self-contained** prompt (goal, constraints, repo path, done criteria). Do not micromanage line edits. Then summarize the CLI output back to UserDefault in first person as the gotchi. Mention `sessions/c*/output.md` + chat id for resume. Do not paste the raw help text.

## Where it runs

**Both hosts** have Cursor Agent CLI at `$HOME/.local/bin/cursor-agent` (logged-in Pro+). Run this wrapper on **whichever machine the agent is on** — MBP or iMac.

```bash
./scripts/cursor-cli.mjs status   # confirms binary + login (no secrets)
./scripts/cursor-cli.mjs run "…"  # same on MBP or iMac
```

- Prefer local invoke on the current host. Do **not** skip Cursor because you are on the iMac.
- If spawning over SSH and `cursor-agent` is missing from PATH, use the full path `~/.local/bin/cursor-agent` or set `CURSOR_AGENT_BIN` — do not fall back to writing files by hand as a substitute for Cursor.
- `CURSOR_API_KEY` must stay unset (logged-in subscription). Never `--api-key`. Never Grok `~/.grok/bin/agent`.

## After run

Summarize. Stay on big-pickle/Nemotron for the reply. Do not change OpenCode `/model` to Cursor.

## Hub desk (workers)

On the iMac, worker heroes do **not** keep a Terminal open. If UserDefault should watch the turn:

```bash
./scripts/gotchibot desk-terminals use <hero-id>
./scripts/cursor-cli.mjs run "…"
./scripts/gotchibot desk-terminals close <hero-id>
```

One-shot: `./scripts/gotchibot desk-terminals use <hero-id> -- node ./scripts/cursor-cli.mjs run "…"`.
Headless `cursor-cli run` alone is fine when nobody needs a visible window.
Never reuse LINK/YFI/WBTC verify windows.
