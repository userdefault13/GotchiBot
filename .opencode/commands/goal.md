---
description: Start a durable goal Cursor pursues until fully complete
argument-hint: [objective]
---

Load skill **goal** (`.opencode/skills/goal/SKILL.md`).

- Empty `$ARGUMENTS` → `Usage: /goal <objective>`
- Else: restate objective → Cursor `CreateGoal` once → first concrete work this turn
- Complete only via `UpdateGoal` after evidence audit
- Not for recurring ticks (`/loop`), contested forks (`/pstack`), or same-prompt loops (`/ralph`)

Arguments: `$ARGUMENTS`
