---
name: ralph-cancel
description: Cancel an active GotchiBot ralph loop. Use when Julius wants to stop, cancel, or abort a running ralph loop.
license: MIT
compatibility: opencode
metadata:
  audience: orchestrator
  workflow: iteration
  upstream: cursor-public/ralph-loop (cancel-ralph)
---

# ralph-cancel (GotchiBot)

Cancel the active ralph loop. Mirrors upstream `cancel-ralph`, remapped to the
GotchiBot store.

## Workflow

1. Check `./scripts/gotchibot ralph status` (or `list`) for an active loop.
2. **No active loop** → tell Julius "no active ralph loop".
3. **Active loop** → cancel it:

   ```bash
   ./scripts/gotchibot ralph cancel [slug]
   ```

   Removes the `sessions/ralph/ACTIVE` pointer, the `<slug>/done` flag and the
   `<slug>/active` marker, and writes `status.md` with state **cancelled**.
   The scratchpad stays for history. Reports the iteration it stopped at.

## Output

A short confirmation with the iteration count, or a message that no loop was
active. The next `stop` hook then exits with no followup — the loop is dead.