---
description: Add a directory to the GotchiBot write/read allowlist
argument-hint: [path | list | remove <path>]
allowed-tools: Bash(./scripts/gotchibot add-dir:*), Bash(node scripts/add-dir.mjs:*)
---

```bash
./scripts/gotchibot add-dir $ARGUMENTS
```

Empty → list. Path → add. `remove <path>` → drop. Skill: **add-dir**.
