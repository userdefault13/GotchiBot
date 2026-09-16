---
name: add-dir
description: >-
  Extra workspace roots for GotchiBot (/add-dir). Remaps Cursor/Claude --add-dir
  into a session allowlist that write-guard honors. Prefer ~/Dev repos.
compatibility: opencode
metadata:
  audience: orchestrator
  workflow: workspace
---

# add-dir (GotchiBot)

Julius sometimes needs the agent to touch a **second tree** (e.g. Gotchi-Trader
beside GotchiBot). Cursor CLI has `--add-dir`; Claude Code has `/add-dir`.
GotchiBot remaps that to a desk allowlist so hooks stay the wall.

## When to load

- Julius says `/add-dir` or "also open ../OtherRepo"
- A task clearly requires writes outside the GotchiBot checkout

Skip for paths already inside this repo. Skip broad roots (`/`, `$HOME`).

## CLI

```bash
./scripts/gotchibot add-dir <abs-or-rel-path>
./scripts/gotchibot add-dir list
./scripts/gotchibot add-dir remove <path>
```

Store: `sessions/.gotchibot-add-dirs.json` (array of absolute realpaths).
`write-guard.mjs` merges these into ALLOWED on every Write/Delete check.

## Rules

1. Path must exist and be a directory before add.
2. Refuse `/`, home root, and other overly broad trees (see script).
3. Prefer `~/Dev/<project>`. Ask Julius before anything outside `~/Dev`.
4. Adding a dir does **not** relaunch `cursor-agent --add-dir` mid-session —
   report that honestly. For a fresh CLI session, pass `--add-dir` via
   `cursor-cli` if Julius wants both.
5. Never invent paths. Never auto-add sibling repos.
6. Use `remove`, not `rm` — bash guard false-positives on `rm /abs`.

## Remap

| Upstream | GotchiBot |
|---|---|
| `agent --add-dir ./other` | `gotchibot add-dir ./other` + write-guard |
| Claude `/add-dir` | `.claude/commands/add-dir.md` |
| Mid-session root expand | allowlist only (hooks); new CLI roots need new process |
