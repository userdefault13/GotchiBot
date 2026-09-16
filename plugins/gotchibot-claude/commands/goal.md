---
description: Start a durable goal that Cursor pursues until the objective is fully complete
argument-hint: [objective]
---

Load and follow **goal** now (`.cursor/skills/goal` → full body in `.opencode/skills/goal`):

1. If `$ARGUMENTS` is empty → reply `Usage: /goal <objective>` and stop.
2. Strip a leading time limit (`30m`, `2h`) if present — say time-limited goals are not supported yet, keep the objective without the budget.
3. Restate the objective (deliverables + evidence you will verify).
4. Call Cursor `CreateGoal` **exactly once** with that objective. Do not invent goal files.
5. Start the first concrete unit of work in this turn. Do not stop at planning.

Completion: only `UpdateGoal` status `complete` after a requirement-by-requirement audit against the live tree. Do not mark complete because you are pausing.

Recurring work ("every 5m") → `/loop`, not `/goal`. Contested design → `/pstack`. Same-prompt iteration → `/ralph`.

Arguments: `$ARGUMENTS`
