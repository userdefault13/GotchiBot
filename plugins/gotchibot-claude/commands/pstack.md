---
description: Load GotchiBot pstack — chief (owned-954) frames; heroes execute role-tagged briefs
argument-hint: [new task | <goal>]
allowed-tools: Bash(./scripts/gotchibot pstack:*), Bash(node scripts/pstack-orch.mjs:*), Bash(./scripts/delegate-pick.mjs:*), Read, Grep
---

Load and follow **pstack** now:

1. Read `.opencode/skills/pstack/SKILL.md` in full (Cursor pointer: `.cursor/skills/pstack`).
2. You are the **chief** — no product-code edits while sticky. Sticky until Julius says `new task` or exits pstack.
3. Match one playbook label. For multi-unit work:
   ```bash
   ./scripts/gotchibot pstack init <slug> --goal "…"
   ```
4. Author a brief, then delegate-pick / spawn (never steal LINK/YFI/WBTC desks):
   ```bash
   ./scripts/gotchibot pstack brief <slug> --role worker --playbook <label> --goal "…" --verify "…"
   ./scripts/delegate-pick.mjs --json "…"
   ```
5. Record units / ledger via `gotchibot pstack unit|ledger|status`.

Arguments (if any): `$ARGUMENTS`

- Empty → ask Julius for the goal / done predicate (one short question), or continue the sticky playbook if already in mode.
- `new task …` → rematch playbook; new slug if multi-unit.
- Otherwise treat `$ARGUMENTS` as the goal and proceed (playbook match → brief → spawn).

Roles: `config/pstack-roles.json`. Skill: **pstack**.
