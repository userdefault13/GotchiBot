---
name: pstack
description: >-
  GotchiBot-adapted pstack / poteto rigor for the orchestrator. Use for /pstack,
  /poteto-mode, nontrivial design, contested approaches, "are we sure?", or when
  Julius wants deeper parallel exploration before shipping. Remaps Cursor Task
  primitives to delegate-pick / gotchi-orchestrate / passoff / cursor-cli.
  Chief (owned-954) frames and judges; heroes execute role-tagged briefs.
license: MIT
compatibility: opencode
metadata:
  audience: orchestrator
  workflow: rigor
  upstream: cursor-public/pstack
---

# pstack (GotchiBot)

pstack's rigor for **owned-954 / gotchi**. You are the **chief** (Orchestrate
coordinator): frame, match a playbook, author briefs, drain, judge. Heroes do
the deep work. This skill does **not** replace `delegate-first`.

Role map: [`config/pstack-roles.json`](../../../config/pstack-roles.json).
Program store: `./scripts/pstack-orch.mjs` → `sessions/pstack/<slug>/`.

## When to load

- Julius says `/pstack`, `/poteto-mode`, "go deep", or "poteto this"
- Nontrivial design, architecture fork, contested approach, or "are we sure?"
- Multi-phase work that needs a named playbook before spawning
- Parallel exploration (2+ competing approaches) before committing

Skip for one-line status, roster, hub recovery, trader/infra/comms desk
ownership, or work already covered by a standing desk hero.

## Sticky mode

Once loaded, stay in pstack for follow-ups (`continue`, `do it`, `keep going`)
on the **same playbook** and program slug.

Exit or rematch when Julius says `new task`, `exit pstack`, or clearly changes
subject. Then match a fresh playbook (and `pstack-orch init` a new slug if the
program is multi-unit).

## Chief non-negotiable

While pstack is active, **owned-954 does not author or edit product code**.

Allowed chief writes only:

- `sessions/pstack/<slug>/` via `./scripts/pstack-orch.mjs`
- passoff packets / focus / spawn prompts
- skill or orch bookkeeping Julius asked for in this mode

Everything else → role-tagged hero spawn. Hard patches inside a unit → worker
runs `./scripts/cursor-cli.mjs run "…"` (do not DIY on Hy3).

## Non-negotiables (GotchiBot remap)

| pstack / Cursor idea | GotchiBot action |
|---|---|
| `Task` / `poteto-agent` | `./scripts/delegate-pick.mjs --json "…"` then `chat` / `spawn` / `blocked` |
| Coordinator | always `owned-954` — briefs, drain, merge, human report |
| Worker / verifier / explorer | available hero per `config/pstack-roles.json` (prefer spare DAI) |
| Parallel fan-out / swarm / arena | multiple `gotchi-orchestrate.mjs spawn` (one unit or approach per hero) |
| Hard coding / all work | worker runs `cursor-cli` (mandatory) |
| Contested second opinion | second hero same brief, or MCP `claude_ask` |
| Mid-work handoff | `gotchibot passoff send …` (hero↔hero); program state stays in pstack store |
| Prove it works | real artifact + ledger row; "it compiles" is not done |
| Standing desks | never LINK / YFI / WBTC as generic pstack workers unless Julius routes desk work |

Still obey the Charter: no autonomous installs, no secrets in chat, no chain /
post / delete without Julius saying yes.

## Principles (orchestrator checklist)

Read this index at the start of multi-step pstack work. Name each principle that
shaped a spawn or judgment, and the choice it changed. For a full leaf, open the
matching `principle-*` skill under the Cursor pstack plugin (or cite the name
and apply the short form below).

**Core.** Smallest change (`laziness`). Types and data shape first
(`foundational-thinking`, `model-the-domain`). Prefer redesign over bolted-on
patches when requirements shifted (`redesign-from-first-principles`). Subtract
dead weight before adding (`subtract-before-you-add`). Attack a shared failed
premise instead of another fix on it (`attack-the-premise`).

**Verification.** Reproduce before fixing (`fix-root-causes`). Verify the real
artifact (`prove-it-works`). Sequence into checkable units
(`sequence-verifiable-units`). Tests assert user-visible behavior
(`test-behavior-not-implementation`).

**Delegation.** Bulk reads and fan-out go to workers (`guard-the-context-window`).
Reversible work proceeds without blocking Julius (`never-block-on-the-human`).
You review diffs and summarize; do not pass worker prose through unchanged.
Parallel writers get separate worktrees/branches
(`separate-before-serializing-shared-state`).

## Playbook match

Before spawning, pick **one** label and keep it sticky until `new task`:

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
| Autonomous run | One long task driven to a checkable predicate |
| Orchestrate | Multi-day / multi-unit program; chief owns queue + store |

If one hero can finish inside a session budget, use Autonomous run — not
Orchestrate.

## Brief template (Orchestrate shape)

Author briefs with `./scripts/pstack-orch.mjs brief …` (writes
`sessions/pstack/<slug>/briefs/<unit>.md` and prints spawn-ready text). Collapse
tiny units to a short paragraph that still names goal, scope, verify, report.

```text
GOAL         one sentence outcome a stranger can execute
SCOPE        paths this unit may write; paths it may not
CONTEXT      file/PR pointers; paste upstream reports workers cannot see
ACCEPTANCE   checkable criteria, one per line
VERIFY       exact command or surface + known gotchas
TIMEBOX      rough cap; on expiry return partial findings
FORBIDDEN    Charter + unit bans (no installs, no secrets, …)
REPORT       status, paths touched, evidence, deviations, follow-ups
STANDING     preferences.md verbatim (or path for local heroes)
ROLE         worker | verifier | how-explorer | why-investigator | arena-runner
PLAYBOOK     <label>
```

Then:

```bash
./scripts/delegate-pick.mjs --json "<brief summary>"
# or explicit:
GOTCHIBOT_HERO_ID=<hero> ./scripts/gotchi-orchestrate.mjs spawn --host auto --model <hint> "$(cat sessions/pstack/<slug>/briefs/<unit>.md)"
```

Record the unit: `./scripts/pstack-orch.mjs unit add …` then `unit set` when the
session id / state is known. After verify: `ledger record`.

## Roles → heroes

See [`config/pstack-roles.json`](../../../config/pstack-roles.json).

| Role | Who | Model hint |
|---|---|---|
| coordinator | always `owned-954` | orch chat (big-pickle) |
| worker | next available spare (prefer idle DAI) | `sub` / nim |
| verifier | different available hero than worker | stronger / `cursor-cli` when judgment-heavy |
| how-explorer / why-investigator | available spare, **read-only** brief | `sub` |
| arena-runner | one available hero per candidate A/B/C | `sub` or cursor-cli per arm |

**Protected (never generic pstack workers):** `starter-link-h1-1`,
`starter-yfi-h1-1`, `owned-22899` (LINK / YFI / WBTC desks).

## Arena / swarm / verifier

- **Arena** (competing designs): spawn N available heroes, same GOAL, one
  approach letter each (A/B/C). Chief compares outputs, picks a base, folds
  useful ideas, reports one recommendation. Agreement across arms is evidence;
  wild divergence means underspecified brief — clarify and re-run.
- **Swarm** (coverage): partition independent slices; one hero per slice; one
  merged report (`PASS` / `ISSUES` / `BLOCKED` + evidence).
- **Verifier**: different hero and preferably different model family from the
  worker. Cheap single-command VERIFY may be worker self-report + chief
  spot-check; expensive / high-blast-radius VERIFY gets a dedicated verifier
  unit and a ledger row.

## Program store

Multi-unit / overnight / contested work:

```bash
./scripts/gotchibot pstack init <slug>
./scripts/gotchibot pstack status <slug>
./scripts/gotchibot pstack brief <slug> --role worker --playbook Feature --goal "…" --verify "…"
```

Files under `sessions/pstack/<slug>/`: `preferences.md`, `units.tsv`,
`ledger.tsv`, `decisions.tsv`, `status.md`, `briefs/`. Workers write only their
`sessions/<id>/output.md`. Passoff remains hero↔hero handoff; this store is
program-level.

## Lessons learned

- **Remote spawn ghosts (2026-09-15).** `--host imac` once returned a session id
  (`s20260915-230158-20052`) whose `sessions/<id>/` never existed on MBP or iMac;
  the same program succeeded with `--host local`. `remote-spawn.mjs` now verifies
  `sessions/<id>/` exists on the remote before reporting success and exits 20 on a
  ghost. If you see a ghost id: retry with `--fallback-local` (spawn on MBP) or
  `--host local` — the same program usually works locally.

## Reply style

Short declarative sentences. Evidence or label (measured / inferred / guess) in
the same sentence. No secret values. Relay Claude pane blocks verbatim when that
row applies. Merge worker outputs yourself — do not paste them unchanged.

## When not pstack

| Situation | Use instead |
|---|---|
| One-line status / roster / hub recovery | answer directly |
| Standing trader / infra / comms cycle | that desk’s playbook + hero |
| Simple delegate with no contested fork | plain `delegate-first` |
| Mid-hero handoff only | `passoff` |

## Related skills

- `delegate-first` — always before DIY
- `cursor-cli` — hard logic path for workers
- `passoff` — mid-task hero handoff
- `synergy` — roster / focus / meetings
- `gotchibot` — swarm + sandbox rules
