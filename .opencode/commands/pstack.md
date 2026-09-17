---
description: pstack chief mode — playbook + role-tagged hero briefs (no product edits by orch)
agent: gotchi
---

Load skill **pstack** (`.opencode/skills/pstack/SKILL.md`) and stay sticky until
Julius says `new task` or exits pstack. You are the **chief** (owned-954): frames,
briefs, drain, judgment — **no product-code edits**. Heroes run role-tagged briefs.

`$ARGUMENTS` is the goal / subcommand.

| Julius types | What to do |
| --- | --- |
| `/pstack` | Ask one short question for the goal / done predicate if none yet; or continue sticky playbook |
| `/pstack <goal>` | Match a playbook → `gotchibot pstack init` (if multi-unit) → `brief` → `delegate-pick` / spawn |
| `/pstack new task <goal>` | Rematch playbook; new slug if multi-unit |
| `/pstack status [slug]` | `./scripts/gotchibot pstack status $ARGUMENTS` |
| `/pstack roles` | `./scripts/gotchibot pstack roles` |
| `/pstack list` | `./scripts/gotchibot pstack list` |
| `/pstack dossier` | `./scripts/orchestrator-layout.sh enter-pstack-dossier` — details/grid window (work.2) |
| `/pstack dossier leave` | `./scripts/orchestrator-layout.sh leave-pstack-dossier` — restore avatar |

Bookkeeping (never spawns):

```bash
./scripts/gotchibot pstack $ARGUMENTS
```

For a real goal (not status/roles/list):

1. Read `.opencode/skills/pstack/SKILL.md` in full.
2. Match one playbook label (Investigation / Bug fix / Feature / … / Orchestrate).
3. Multi-unit → `./scripts/gotchibot pstack init <slug> --goal "…"`.
4. Author brief → spawn via delegate-pick (prefer spare DAI; **never** steal LINK/YFI/WBTC):
   ```bash
   ./scripts/gotchibot pstack brief <slug> --role worker --playbook <label> --goal "…" --verify "…"
   ./scripts/delegate-pick.mjs --json "…"
   ```
5. Record units / ledger with `gotchibot pstack unit|ledger|status`.

**Dossier window** — chief SoT per program slug (Details top + gotchi grid bottom):

```bash
./scripts/orchestrator-layout.sh enter-pstack-dossier   # details/grid window replaces avatar (work.2)
./scripts/gotchibot pstack dossier new <slug> --goal "…"  # seed sessions/pstack/<slug>/dossier.json
./scripts/gotchibot pstack dossier set <slug> <field> <value>  # edit fields via CLI
./scripts/gotchibot pstack dossier ready <slug>          # exit 0 when required fields complete
./scripts/orchestrator-layout.sh leave-pstack-dossier   # restore avatar
```

Window = `scripts/pstack-window.mjs watch` (dossier fields + selected unit top,
2xN collateral-colored gotchi grid bottom; roster refresh 15s; wheel scrolls).
`scripts/pstack-pane.sh` is retired as the primary UI.

SoT: `sessions/pstack/<slug>/dossier.json` · policy `config/pstack-dossier-policy.json`.
Separate from sandbox project-intake.

Roles: `config/pstack-roles.json`. Store: `sessions/pstack/<slug>/`.
Does not replace `delegate-first`.
