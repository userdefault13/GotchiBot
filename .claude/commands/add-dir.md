---
description: Add a directory to the session allowlist (extra workspace root for reads/writes)
argument-hint: [path | list | remove <path>]
allowed-tools: Bash(./scripts/gotchibot add-dir:*), Bash(node scripts/add-dir.mjs:*), Read
---

Run this now, do not ask first:

```bash
./scripts/gotchibot add-dir $ARGUMENTS
```

Rules:

- Empty / `list` → show current extra roots.
- A path → resolve it, require it exists as a directory Julius named, append to
  the session allowlist (`sessions/.gotchibot-add-dirs.json`). Write-guard
  then permits Write/Delete under that root for this desk.
- `remove <path>` → drop that root (use `remove`, not `rm` — bash guard).
- Never invent paths. Never add `/`, `$HOME`, or broad system trees.
- Prefer repos under `~/Dev/…`. Absolute paths only after resolve.
- This is GotchiBot's remap of Cursor/Claude `--add-dir` / `/add-dir`: policy
  allowlist + agent awareness. It does not restart the Cursor CLI with a new
  `--add-dir` flag mid-session — say so if Julius expected that.

After success: confirm the path and that writes under it are now allowed.
Skill: **add-dir**.
