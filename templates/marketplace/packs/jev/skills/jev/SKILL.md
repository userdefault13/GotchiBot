---
name: jev
description: >-
  TypeSafe Jev (System One): fast structured decisions — Choice (closed set),
  Noul (yes/no probability), Score (ordered rubric) with confidence. Use for
  routing, guardrails, and ranking candidates the code already listed. Not chat,
  not System 2, not a work tool for file edits. Anti-jobs: prose/PRs/skills;
  printing API keys.
license: MIT
compatibility: opencode
metadata:
  audience: agents
  workflow: decisions
---

# jev (TypeSafe System One)

**Jev** returns typed answers your **code** branches on. You define the shape of
the answer (closed options / rubric / yes-no). It does not generate chat.

Live docs are source of truth: https://docs.typesafe.ai/llms.txt

## When to load

- Route / classify from a closed set
- "Should we auto-act?" confidence gate
- Score or pick among candidates the code already has
- Replace fragile prompt → regex parse for a judgment

## Anti-jobs

- Chat, drafting, coding, Bend LAWS/PROOF authorship
- Multi-hop reasoning that needs intermediate text
- Inventing API shapes — read docs.typesafe.ai before changing contracts
- File edits (use a work tool)

## Question types

| Need | type | Returns |
|---|---|---|
| One of a defined set | `choice` | `choice`, `probabilities`, `confidence` |
| Yes/no probability | `noul` | `noul` (0–1) |
| Degree on ordered levels | `score` | `score`, `probabilities`, `confidence` |

Ask **atomic** questions; compose in code. Batch independent questions in one
request. Escalate low confidence to a human or a work tool.

## Auth

Env (any one): `TYPESAFE_API_KEY` | `JEV_API_KEY` | `JEV_DEV_API_KEY`  
Never print key values. Prefer model `jev-latest` unless pinned.

### GotchiBot desk (optional)

```bash
./scripts/gotchibot jev smoke --json
./scripts/gotchibot jev ask --state "…" --questions ./tmp/q.json --json
./scripts/gotchibot jev models
```

Abra: project `general`, name `JEV_DEV_API_KEY` (names only).

## Patterns

1. **Routing** — Choice over closed ids; code dispatches
2. **Confidence-gated mutation** — Noul or Choice + threshold before write/spend
3. **Composite score** — several Scores → weighted formula in code
4. **Next step from a graph** — Choice among legal edges the code enumerated

## Optional upstream skill

https://github.com/typesafe-ai/skills · https://docs.typesafe.ai/llms.txt

## Hard rules

- Never print API keys
- Never treat Jev as a work tool for file edits
- Never auto-mint or steal standing desks when seating this pack on a cart
