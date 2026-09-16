---
name: pstack
description: >-
  GotchiBot-adapted pstack / poteto rigor for the orchestrator. Use for /pstack,
  /poteto-mode, nontrivial design, or contested approaches before shipping.
---

# pstack (Cursor)

Load and follow the full GotchiBot-adapted protocol:

**Read** [`.opencode/skills/pstack/SKILL.md`](../../../.opencode/skills/pstack/SKILL.md)

While active: you are the **chief** (owned-954) — frames, playbooks, briefs,
drain, judgment. No product-code edits. Heroes execute role-tagged briefs via
`delegate-pick` / `gotchi-orchestrate`. Store: `./scripts/gotchibot pstack …`.
Roles: `config/pstack-roles.json`. Sticky until `new task` / exit pstack.

Remap: Cursor `Task` → `delegate-pick` / `gotchi-orchestrate`; hard code →
`cursor-cli`; handoff → `passoff`. Does not replace `delegate-first`.
