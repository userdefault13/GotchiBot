---
name: goal
description: >-
  Durable goal via Cursor CreateGoal. Use for /goal, long-lived objectives
  that must reach a checkable end state. Not for /loop, /pstack, or /ralph.
disable-model-invocation: true
compatibility: opencode
metadata:
  audience: orchestrator
  workflow: durable-goal
  upstream: cursor-skills-cursor/goal
---

# goal (GotchiBot)

Cursor-native durable objective for **owned-954 / gotchi** in Cursor. Goal
state lives in conversation tooling (`CreateGoal` / `UpdateGoal`), not in
`sessions/`. This does **not** replace `delegate-first`.

## When to load

- Julius says `/goal` or asks for a durable objective until complete
- Multi-turn work that must survive context turns without shrinking the ask

Skip for one-line status, roster, hub recovery, or work that belongs on a
standing desk cycle. Recurring ticks → `/loop`. Contested design → `/pstack`.
Same prompt until promise → `/ralph`.

## Parse

Accept `/goal <objective>`.

- Empty → `Usage: /goal <objective>`
- Leading time limit (`30m`, `2h`) → say time-limited goals are not supported
  yet; create the goal without the budget
- "Every …" → `/loop`, not `/goal`

## Start

1. Restate the objective, including every explicit deliverable or required
   evidence you will verify against the repo.
2. Call Cursor `CreateGoal` **exactly once**. Do not create goal files by hand
   and do not retry creation.
3. If creation fails, report that no goal was armed.
4. Do the first concrete unit of work immediately — do not stop after planning.

On OpenCode / Hub without `CreateGoal`: tell Julius `/goal` is Cursor-desk
only; continue the work with the same objective text and do not pretend a
CreateGoal row exists.

## Guidelines

- Keep the full objective intact across turns. Do not redefine success around
  a smaller subset.
- Work from the live tree. Prior chat is a hint, not proof.
- Multi-step → TodoWrite tied to the real objective.
- Do not ship a narrower "safer" substitute that leaves the requested end
  state false.

## Completion audit

Before `UpdateGoal` `complete`, treat completion as unproven:

- List every explicit requirement from the objective
- For each, name the authoritative evidence and inspect it now
- Uncertain / indirect / missing → keep working
- Only then call `UpdateGoal` with status `complete`

Do not mark complete merely because you are stopping. User pause/resume is
controlled by Julius; you may set `active` only if he asks to resume.

## Remap

| Cursor idea | GotchiBot action |
|---|---|
| `CreateGoal` | Cursor dynamic tool `CreateGoal` (desk only) |
| `UpdateGoal` | Cursor dynamic tool `UpdateGoal` |
| Hard coding inside the goal | `delegate-pick` / spawn / `cursor-cli` |
| Mid-work handoff | `passoff` |

Still obey Charter: no autonomous installs, no secrets, no chain/post/delete
without Julius saying yes. Never steal LINK / YFI / WBTC desks as generic
workers.
