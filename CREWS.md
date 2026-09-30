# CREWS.md — GotchiBot crew index

Thin roster. **Playbooks stay in skills / packs** — this file only answers who
owns what and where to route. Mirror of the Grok Bot fleet skill `crews`, kept
in-repo so desk agents (OpenCode / Cursor / Claude) learn the same map.

When a specialty is needed, check here before DIY.

## How to read

| Column | Meaning |
|---|---|
| Chief | Routes / merges; does not steal worker one-jobs |
| Workers | One-job agents (GotchiBot heroes and/or Grok Bots) |
| Desk | How to staff on this machine |

## bend

| | |
|---|---|
| **Chief** | Grok Bot `bend-chief` — intake, route, merge Bend work |
| **Workers** | `bend-laws` → `LAWS.bend` · `bend-proofs` → `PROOF.bend` / `bend PROOF.bend` green |
| **Playbook** | Fleet skill `bend-2`; install Bend via `curl -fsSL https://bend-lang.com/install.sh | sh` |
| **Desk** | Marketplace suite `bend-crew` (starter): `gotchibot templates install bend-crew --yes` then `apply bend-crew --heroes bend-chief=<h>,bend-laws=<h>,bend-proofs=<h> --yes`. Grok bend crew remains fine for LAWS/PROOF authorship. |

Route laws → laws worker. Route proofs / checker fails → proofs worker. Do not
have laws write proofs or proofs rewrite laws.

## makers (skills · rules · policies · tools · MCP)

| | |
|---|---|
| **Chief (desk)** | `central-bot` pack — manages maker fleet for the current project; seats via Prof. Link-Cube |
| **Chief (Grok)** | `makers-chief` — same routing for fleet Grok workers |
| **Workers** | `skill-maker` · `rule-maker` · `policy-maker` · `tool-maker` · `mcp-maker` |
| **Desk packs** | `templates/marketplace/packs/{skill,rule,policy,tool,mcp}-maker` — `gotchibot templates apply <id> --hero <available> --yes` |
| **Playbook** | Pack `playbook.json` / AGENTS.md per maker; fleet skill `makers` |

### Routing map

| Need | Maker |
|---|---|
| SKILL.md / when-to-use / anti-jobs | `skill-maker` |
| lint / hooks / CI / checklist + verify | `rule-maker` |
| allow/deny / approve-gates / escalation docs | `policy-maker` |
| deterministic CLI (no LLM inside the tool) | `tool-maker` |
| MCP schema / stub / connector config | `mcp-maker` |
| repeated session roadblocks (known working cite) | `roadblock-reviewer` (via central / Prof) |
| side notes / novel flakiness / "worth looking at" | fleet **Issue Reviewer** (skill `issue-reviewer`) → Home Infra CoS / architect / makers |

Human approves installs. Secrets via abracadabra only. Never auto-mint; never
steal LINK/YFI/WBTC standing desks.

## gotchibot (orchestrator desk)

| | |
|---|---|
| **Chief** | the gotchi / orch (`orchestrator`) — see `ORCHESTRATOR.md`, `AGENTS.md`, pack `orchestrator` |
| **Workers** | Specialist heroes and Grok coding bots (dossier-*, prof-modal, gotchi-omarchy, standing desks LINK/YFI/WBTC, …) |
| **Work tools** | Cursor (cursor-cli) → Codex → Claude — see `ORCHESTRATOR.md` |

CoS: `gotchibot graph` (sessions/graph state) + fleet skill `agent-graph`.
Orch owns product routing. Central owns makers. Bend crew owns LAWS/PROOF.
Do not cross-steal lanes without Julius saying so.

## architect

| | |
|---|---|
| **Grok Bot** | `architect` — general systems/software architecture for any Julius project |
| **Desk pack** | `templates/marketplace/packs/architect` — `gotchibot templates apply architect --hero <available> --yes` |
| **Playbook** | Pack skill `architect` (mirrors fleet skill `architect`) |
| **Anti-jobs** | No silent build; no one-option plans; hand off to CoS/crews |

Route architecture asks here **before** locking a plan or spawning headcount.
After the matrix, CoS routes build work — architect does not DIY.
CoS opinion round: `gotchibot meet colabo --ring design "…"` (not all-hands).

## Adding a crew

1. Define chief + workers with one-jobs and anti-jobs.
2. Prefer a marketplace pack and/or Grok Bot pair so desk + fleet match.
3. Append a section here and keep the fleet `crews` skill in sync.
4. Point `AGENTS.md` / orch briefs at this file — do not paste full playbooks.

## jev (TypeSafe System One)

| | |
|---|---|
| **Fleet** | Common skill on every hero (`COMMON_SKILLS` → fleet sync). Desk pack `jev` remains for a dedicated Jev seat if wanted. |
| **CLI** | `./scripts/gotchibot jev ask|smoke|models` (or TypeSafe API via env `TYPESAFE_API_KEY`) |
| **Secret** | `TYPESAFE_API_KEY` / `JEV_API_KEY` / `JEV_DEV_API_KEY` (names only); abra `general` / `JEV_DEV_API_KEY` on GotchiBot desks |
| **Playbook** | Pack skill `jev`; live docs https://docs.typesafe.ai/llms.txt |
| **Anti-jobs** | Not chat / not System 2 / not a work tool for edits |

Use for closed-set routing, guardrails, and ranking. Compose atomic answers in
code; escalate low confidence to a human or a work tool.
