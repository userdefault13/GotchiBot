---
name: multitask
description: Cursor-style parallel sub-agents — decompose a compound request and spawn async workers
license: MIT
compatibility: opencode
metadata:
  audience: orchestrator
  workflow: parallel
---

## What I do

Run **parallel sub-agents** instead of doing work serially in chat (like Cursor `/multitask`).

When the user says `/multitask …` or asks to multitask / run tasks in parallel:

```bash
./scripts/gotchi-multitask.mjs run "their compound request"
```

For explicit task lists:

```bash
./scripts/gotchi-multitask.mjs run --tasks "refactor auth module" "add unit tests" "update README"
```

## When to use me

- Several **independent** requests at once
- Large work that can split into chunks (frontend + tests + docs)
- User wants background work while chat stays free

## After spawning

Report the `multitask m…` group id and session ids. User can:

- `./scripts/gotchibot list` — see all sub-agents
- `./scripts/gotchibot multitask status <groupId>` — group progress
- `./scripts/gotchibot multitask wait <groupId> --merge` — wait + merged output

Do **not** implement subtasks yourself in the foreground — always delegate via the script.

## Notes

- Sub-agents require wallet + **at least one cAavegotchi** on the cartridge (spawn gate). Each session is bound to a cAavegotchi at spawn.
- Prefer 2–5 parallel tasks; avoid overlapping edits to the same files.
- Use `--model pro` on individual hard units only when decomposition assigns it.
