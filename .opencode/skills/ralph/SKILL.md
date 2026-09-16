---
name: ralph
description: >-
  GotchiBot-adapted ralph-loop (Ralph Wiggum technique) for the orchestrator.
  Use for /ralph, iterative self-referential loops, "keep going until done",
  or repeated autonomous iteration on one prompt with a completion promise.
  Chief (owned-954) frames; worker hero iterates; never LINK/YFI/WBTC as
  workers; VERIFY the real artifact; remap stop/followup to gotchibot ralph;
  store sessions/ralph. When-to-use vs /loop vs /pstack below.
license: MIT
compatibility: opencode
metadata:
  audience: orchestrator
  workflow: iteration
  upstream: cursor-public/ralph-loop
---

# ralph (GotchiBot)

ralph-loop implements the [Ralph Wiggum technique](https://ghuntley.com/ralph/)
— the **same prompt** is fed back after every turn until the agent outputs a
matching `<promise>TEXT</promise>` tag or the iteration cap is hit. The
"self-referential" part: each iteration sees its own previous work in the tree
and git history. The prompt never changes. The code does.

Upstream plugin (vendored at `plugins/ralph-loop-upstream/`, cache copy under
`~/.cursor/plugins/cache/cursor-public/ralph-loop/<sha>/`) drives the loop with
two hooks. GotchiBot remaps those hooks to `.cursor/hooks/ralph-capture.mjs` +
`ralph-stop.mjs` and the state store to `sessions/ralph/` via
`./scripts/ralph-orch.mjs` (bookkeeping only — never spawns).

## When to load

- Julius says `/ralph`, "loop this", "keep going until done", or wants the same
  prompt iterated until a completion promise fires
- Well-defined tasks with clear, verifiable success criteria (tests passing,
  migration done, feature built from a spec)
- Self-correction cycles: agent sees failures, fixes them, repeats

**Not a fit** for human-judgment tasks, ambiguous goals, one-shot operations,
or work already covered by a standing desk hero.

## When to use ralph vs /loop vs /pstack

| Mechanism | Use when | Shape |
|---|---|---|
| **ralph** (`/ralph`) | One prompt, iterative self-correction, promise-gated, capped | Stateful: `sessions/ralph/<slug>/` + ACTIVE; hooks re-feed the prompt |
| **/loop** (plain re-invoke) | "Try again" a couple of times, no state, no promise | Manual; you re-send the prompt yourself |
| **pstack** (`/pstack`) | Multi-unit rigor, parallel exploration, contested design, playbooks + ledger | Chief frames playbook; role-tagged hero units; `sessions/pstack/<slug>/` |

ralph is one goal looped to done; pstack is many units explored in parallel.
Do not reach for ralph when the task needs a named playbook or competing
approaches — that is pstack's job.

## Sticky mode

Once loaded, stay in ralph for follow-ups (`continue`, `do it`, `keep going`)
on the **same loop slug** until the done flag, the max-iterations cap, or
Julius says `new task` / `exit ralph` / `cancel`.

## Chief non-negotiable

While ralph is active, **owned-954 does not author or edit product code**.
Allowed chief writes only:

- `sessions/ralph/<slug>/` via `./scripts/ralph-orch.mjs`
- spawn prompts / passoff packets / skill or orch bookkeeping Julius asked for

Everything else → worker hero spawn. Hard patches inside an iteration → worker
runs `./scripts/cursor-cli.mjs run "…"` (do not DIY on big-pickle).

## Protocol

1. **Frame** — chief turns Julius's goal into: the loop prompt (self-contained,
   with explicit done criteria), a completion promise text, and a max-iterations
   cap. **max-iterations is never unlimited on GotchiBot** (default 20; `0` is
   refused by the CLI).
2. **Start** — write the loop state:

   ```bash
   ./scripts/gotchibot ralph start --slug <s> --prompt "…" --max-iterations 20 --completion-promise "DONE"
   ```

   Writes `sessions/ralph/<slug>/scratchpad.md` (upstream frontmatter shape:
   iteration / max_iterations / completion_promise + prompt body), `status.md`,
   touches the `active` marker, and points `sessions/ralph/ACTIVE` at the slug.
   One active loop at a time — another active loop refuses unless `--force`.
3. **Iterate** — delegate the prompt to a worker hero (prefer spare DAI; never
   LINK/YFI/WBTC as generic workers):

   ```bash
   ./scripts/delegate-pick.mjs --json "<prompt>"
   # or explicit:
   GOTCHIBOT_HERO_ID=<hero> ./scripts/gotchi-orchestrate.mjs spawn --host auto --model sub "<prompt>"
   ```

   The worker's edits land in the shared tree. On the chief's next stop, the
   hook re-feeds the same prompt (`[Ralph loop iteration N…]`) — delegate again.
4. **Promise** — the worker outputs `<promise>DONE</promise>` **only when
   genuinely true**. `ralph-capture.mjs` writes the done flag; `ralph-stop.mjs`
   clears the loop and the session ends.
5. **VERIFY** — before telling Julius it is done, verify the **real artifact**
   named in the prompt (run the tests / command / inspect the output). "The
   promise fired" is not done; the artifact must actually satisfy the goal. If
   it does not, restart with a fresh slug (or `--force`) and a tighter prompt.
6. **Cancel / status** — `./scripts/gotchibot ralph cancel [slug]` (reports the
   iteration it stopped at); `./scripts/gotchibot ralph status [slug] [--json]`;
   `./scripts/gotchibot ralph list [--json]`.

## Non-negotiables (GotchiBot remap)

| ralph-loop / Cursor idea | GotchiBot action |
|---|---|
| `.cursor/ralph/scratchpad.md` state | `sessions/ralph/<slug>/` + `sessions/ralph/ACTIVE` via `ralph-orch.mjs` |
| `afterAgentResponse` capture hook | `.cursor/hooks/ralph-capture.mjs` (writes `<slug>/done`) |
| `stop` hook re-feed | `.cursor/hooks/ralph-stop.mjs` (bump + followup; runs before contexter-restore) |
| `/add-plugin ralph-loop` (upstream) | vendored `plugins/ralph-loop-upstream/`; GotchiBot-native = `/ralph` |
| The agent doing the work | worker hero per iteration (prefer spare DAI; never LINK/YFI/WBTC) |
| Hard coding inside an iteration | worker runs `cursor-cli` |
| Prove it works | real artifact + `status.md`; "it compiles" is not done |
| Stop early | `gotchibot ralph cancel` (or Julius says cancel) |

Still obey the Charter: no autonomous installs, no secrets in chat, no chain /
post / delete without Julius saying yes.

## Program store

```bash
./scripts/gotchibot ralph start --slug <s> --prompt "…" --max-iterations 20 --completion-promise "DONE"
./scripts/gotchibot ralph status <s>
./scripts/gotchibot ralph cancel <s>
./scripts/gotchibot ralph list
```

Files under `sessions/ralph/<slug>/`: `scratchpad.md` (frontmatter + prompt),
`done` (flag, touched by the capture hook), `status.md`, `active` (marker).
`ACTIVE` at `sessions/ralph/` points at the current slug for the hooks.
Workers write only their `sessions/<id>/output.md`.

## Reply style

Short declarative sentences. Report which iteration is running, what the worker
changed, and the verification evidence. No secret values. Merge worker outputs
yourself — do not paste them unchanged.

## When not ralph

| Situation | Use instead |
|---|---|
| One-line status / roster / hub recovery | answer directly |
| Standing trader / infra / comms cycle | that desk's playbook + hero |
| Simple delegate with no loop | plain `delegate-first` |
| Multi-unit rigor / contested fork | `pstack` |
| Mid-hero handoff only | `passoff` |

## Related skills

- `delegate-first` — always before DIY
- `cursor-cli` — hard logic path for workers
- `pstack` — when the task needs playbooks / parallel exploration instead
- `passoff` — mid-task hero handoff
- `synergy` — roster / focus / meetings
- `gotchibot` — swarm + sandbox rules