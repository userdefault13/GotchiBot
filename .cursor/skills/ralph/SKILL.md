---
name: ralph
description: >-
  GotchiBot-adapted ralph-loop for the orchestrator. Use for /ralph, iterative
  self-referential loops, or repeated autonomous iteration on one prompt until
  a completion promise fires or max iterations hit.
---

# ralph (Cursor)

Load and follow the full GotchiBot-adapted protocol:

**Read** [`.opencode/skills/ralph/SKILL.md`](../../../.opencode/skills/ralph/SKILL.md)

While active: you are the **chief** (owned-954) — frames the loop prompt +
completion promise + max-iterations (default 20, never unlimited). Workers
iterate (prefer spare DAI; never LINK/YFI/WBTC). Store:
`./scripts/gotchibot ralph …` → `sessions/ralph/<slug>/` + `sessions/ralph/ACTIVE`.
Hooks: `.cursor/hooks/ralph-capture.mjs` (promise → done flag) +
`ralph-stop.mjs` (bump + followup) drive the loop; stop/followup remaps to
`gotchibot ralph`. Sticky until done flag / max iterations / `gotchibot ralph cancel`.

Remap: Cursor `stop` hook → `ralph-stop.mjs` first, then contexter-restore
(loop_limit 1); hard code → `cursor-cli`; handoff → `passoff`. Does not
replace `delegate-first`.