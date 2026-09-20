---
name: jev
description: >-
  Use when GotchiBot needs a fast structured decision inside a workflow:
  route/classify (Choice), yes/no gate (Noul), graded rubric (Score), or
  confidence-gated auto-act. TypeSafe Jev is System One — not chat, not
  System 2 reasoning, not text generation. Load for gotchibot jev CLI,
  graph/passoff routing, guardrails, and decomposing prompt-and-parse into
  typed questions. Anti-jobs: writing prose/PRs/skills; long reasoning;
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

- "route this ticket / passoff / graph edge"
- "should we auto-act?" / confidence gate
- "score these candidates" / pick one from a list the code already has
- Replacing fragile LLM prompt → regex parse for a judgment

## Anti-jobs

- Chat, drafting, coding, Bend LAWS/PROOF authorship
- Multi-hop reasoning that needs intermediate text
- Inventing API shapes — read docs.typesafe.ai before changing contracts

## CLI (GotchiBot)

```bash
# smoke (uses abra general → JEV_DEV_API_KEY when env empty)
./scripts/gotchibot jev smoke --json

# ask from files
./scripts/gotchibot jev ask --state "…" --questions ./tmp/q.json --json
./scripts/gotchibot jev ask --file ./tmp/req.json --json

./scripts/gotchibot jev models
```

Env: `TYPESAFE_API_KEY` | `JEV_API_KEY` | `JEV_DEV_API_KEY`  
Abra: project `general`, name `JEV_DEV_API_KEY` (never print values).

## Question types

| Need | type | Returns |
|---|---|---|
| One of a defined set | `choice` | `choice`, `probabilities`, `confidence` |
| Yes/no probability | `noul` | `noul` (0–1) |
| Degree on ordered levels | `score` | `score`, `probabilities`, `confidence` |

Ask **atomic** questions; compose in code. Batch independent questions in one
request (parallel). Use confidence to escalate low-certainty answers to a human
or a work tool (Claude → Cursor → Codex).

## GotchiBot patterns

1. **Intent / desk routing** — Choice over closed desk ids; code calls passoff/graph
2. **Confidence-gated mutation** — Noul or Choice + threshold before write/spend
3. **Composite score** — several Scores → weighted formula in code (not one mega-prompt)
4. **Graph next-edge** — Choice among legal edges from `gotchibot graph get`

## Optional upstream skill

For deep cookbooks: install TypeSafe skill (`typesafe-ai/skills`) or read
https://raw.githubusercontent.com/typesafe-ai/skills/main/skills/typesafe-ai/SKILL.md

## Hard rules

- Never print API keys or `abra get` values
- Never treat Jev as a work tool for file edits
- Pin/model: prefer `jev-latest` unless Julius pins a version
