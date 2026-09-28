---
name: codex-cli
description: >-
  Alternate coding agent: when UserDefault says codex / Codex, work goes through
  ./scripts/codex-cli.mjs run "…" → codex exec (non-interactive). Mirror of
  cursor-cli; bot stays on big-pickle/Nemotron/Hy3 for talk/route/spawn/summarize
  only. cursor-cli remains the default coding tool. Never DIY on the chat model.
license: MIT
compatibility: opencode
metadata:
  audience: everyone
  workflow: codex-bridge
---

# Codex CLI (alternate work tool)

OpenCode / OpenClaw **stays** on **big-pickle** / **Nemotron** / **Hy3** for talking,
routing, spawning, and summarizing.

**Codex** is an **alternate** coding agent. Use it when UserDefault says **codex** /
**Codex**. **`cursor-cli` remains the default** coding tool for all other work.
Do **not** DIY edits on the chat model and call them done. Do **not** `/model` to
Codex or Cursor.

## Split

| Layer | Tool | Does |
| --- | --- | --- |
| Bot (gotchi / talk / route) | big-pickle / Nemotron / Hy3 | Talk, route, spawn, summarize |
| **Default work** | `cursor-cli` → `cursor-agent` | Code, debug, patches (default) |
| **Alternate work** | `codex-cli` → `codex exec` | Same class of work when UserDefault asks for Codex |

## When to use

- UserDefault says "codex", "Codex", or "use codex for this".
- Otherwise prefer skill `cursor-cli` → `./scripts/cursor-cli.mjs run "…"`.

## Invoke (wrapper only)

Never pass `--api-key`. Never invent a second install path. Never dump `codex --help`
into chat. Never ask UserDefault for secrets.

```bash
./scripts/codex-cli.mjs run "self-contained prompt: goal, constraints, repo path, done criteria"
./scripts/codex-cli.mjs run "…" --cwd ~/Dev/GotchiBot
./scripts/codex-cli.mjs run "…" --model <id>
./scripts/codex-cli.mjs resume "follow-up"          # codex exec resume --last
./scripts/codex-cli.mjs resume <sessionId> "…"
./scripts/codex-cli.mjs status
./scripts/gotchibot codex run "…"
```

Headless `run` execs `codex exec --sandbox workspace-write -C <cwd> …`. Resume is
trivial via `codex exec resume --last`.

## Prompt shape

Hand a **self-contained** prompt (goal, constraints, repo path, done criteria).
Then summarize the CLI output back to UserDefault in first person as the gotchi.
Mention `sessions/x*/output.md` for the run record.

## Where it runs

Same hosts as Cursor Agent (MBP or iMac). Binary: `$CODEX_BIN` or `codex` on PATH
(codex-cli). Confirm with:

```bash
./scripts/codex-cli.mjs status   # bin path + version (no secrets)
```

Prefer local invoke on the current host. Do not fall back to DIY file edits if
`codex` is missing — report the status error instead.

## After run

Summarize. Stay on big-pickle/Nemotron for the reply. Do not change OpenCode `/model`.
`cursor-cli` stays the default for the next work unit unless UserDefault asks for Codex again.
