---
name: goal
description: >-
  Start a durable Cursor goal (/goal). Use when Julius wants a long-lived
  objective pursued until fully complete. Not for recurring ticks (/loop).
disable-model-invocation: true
---

# goal (Cursor)

Load and follow the full GotchiBot-adapted protocol:

**Read** [`.opencode/skills/goal/SKILL.md`](../../../.opencode/skills/goal/SKILL.md)

Arm with Cursor `CreateGoal` exactly once. Mark done only with `UpdateGoal`
after a live-tree audit. Slash: `/goal <objective>`.
