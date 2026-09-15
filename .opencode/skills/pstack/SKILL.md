---
name: pstack
description: >-
  GotchiBot-adapted pstack / poteto rigor for the orchestrator. Use for /pstack,
  /poteto-mode, nontrivial design, contested approaches, "are we sure?", or when
  Julius wants deeper parallel exploration before shipping. Remaps Cursor Task
  primitives to delegate-pick / gotchi-orchestrate / passoff / cursor-cli.
license: MIT
compatibility: opencode
metadata:
  audience: orchestrator
  workflow: rigor
  upstream: cursor-public/pstack
---

# pstack (GotchiBot)

pstack's rigor for **owned-954 / gotchi**. You stay the orchestrator. Workers do the deep work. This skill does **not** replace `delegate-first`.

## When to load

- Julius says `/pstack`, `/poteto-mode`, "go deep", or "poteto this"
- Nontrivial design, architecture fork, contested approach, or "are we sure?"
- Multi-phase work that needs a named playbook before spawning
- Parallel exploration (2+ competing approaches) before committing

Skip for one-line status, roster, hub recovery, trader/infra desk ownership, or work already covered by a standing desk hero.

## Non-negotiables (GotchiBot remap)

| pstack / Cursor idea | GotchiBot action |
|---|---|
| `Task` / `poteto-agent` subagent | `./scripts/delegate-pick.mjs --json "…"` then follow `chat` / `spawn` / `blocked` |
| Parallel fan-out / swarm / arena | Multiple `./scripts/gotchi-orchestrate.mjs spawn --model auto "…"` (one approach per hero). Never steal LINK / YFI / WBTC desks. Prefer available heroes; new project boxes use `--sandbox`. |
| Hard coding / patches / investigation | Worker runs `./scripts/cursor-cli.mjs run "…"` (skill `cursor-cli`). Do not DIY on Hy3. |
| Contested design / second opinion | Spawn a second hero with the same prompt, or MCP `claude_submit` / `claude_ask` for an independent Claude pane read. |
| Hand off mid-work | `./scripts/gotchibot passoff send <hero> --note "…" --next "…"` / `passoff resume` |
| Prove it works | Worker must verify against the real artifact (test, CLI, live surface). "It compiles" is not done. |
| Ask Julius a reversible fork | Prefer a cheap prototype / observation first. Ask only for product preference or irreversible risk. |

Still obey the Charter: no autonomous installs, no secrets in chat, no chain / post / delete without Julius saying yes.

## Principles (orchestrator checklist)

Name the ones that shaped the spawn prompt. Keep prompts short; put detail in the worker brief.

**Core.** Smallest change (`laziness`). Types and data shape first (`foundational-thinking`, `model-the-domain`). Prefer redesign over bolted-on patches when requirements shifted (`redesign-from-first-principles`). Subtract dead weight before adding (`subtract-before-you-add`). Attack a shared failed premise instead of another fix on it (`attack-the-premise`).

**Verification.** Reproduce before fixing (`fix-root-causes`). Verify the real artifact (`prove-it-works`). Sequence into checkable units (`sequence-verifiable-units`). Tests assert user-visible behavior (`test-behavior-not-implementation`).

**Delegation.** Bulk reads and fan-out go to workers (`guard-the-context-window`). Reversible work proceeds without blocking Julius (`never-block-on-the-human`). You review diffs and summarize; do not pass worker prose through unchanged.

## Playbook match → spawn brief

Before spawning, pick one playbook label and put it in the worker prompt:

| Label | Use when |
|---|---|
| Investigation | Read-only: how / why / are we sure |
| Bug fix | Defect with reproduce → root cause → fix + evidence |
| Perf issue | Measured slowness vs baseline |
| Feature | New or changed behavior from a named data shape |
| Refactoring | Behavior-preserving structure change |
| Prototype | Cheap sketch to settle an empirical fork |
| Multi-phase plan | Work that spans phases or stacked PRs |
| Babysit | Drive a PR / stack to merge-ready |
| Autonomous run | Long task Julius wants driven until done |

Worker prompt shape:

```text
Playbook: <label>
Goal: …
Constraints: GotchiBot Charter; no installs; no secrets; stay in <repo>
Data shape / domain model: …
Done when: <observable proof>
Verify: <exact command or surface>
```

Then:

```bash
./scripts/delegate-pick.mjs --json "<Julius's words + playbook brief>"
# or, when you already know spawn is right:
./scripts/gotchi-orchestrate.mjs spawn --model auto "<playbook brief>"
```

For competing approaches (arena-style): spawn N available heroes, each with one approach lettered A/B/C, then compare outputs yourself and report a recommendation.

## Reply style

Short declarative sentences. Evidence or label (measured / inferred / guess) in the same sentence. No secret values. Relay Claude pane blocks verbatim when that row applies.

## Related skills

- `delegate-first` — always before DIY
- `cursor-cli` — hard logic path for workers
- `passoff` — mid-task hero handoff
- `synergy` — roster / focus / meetings
- `gotchibot` — swarm + sandbox rules
