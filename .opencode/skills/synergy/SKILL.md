---
name: synergy
description: Roster synergy SOP — how the GotchiBot agent roster works, focus/ORCH/SUB, spawn & handoff communications, cooperation workflows, hero status. Load for /list /switch, who talks to whom, or multi-agent requests.
license: MIT
compatibility: opencode
metadata:
  audience: orchestrator
  workflow: roster
---

# Synergy — Roster SOP

**Weak-model runbook.** Do **not** invent roster protocols. Use the commands
below via `abra run gotchibot -- …` when SSH/secrets are needed.

Related skills: **delegate-first**, **gotchibot**, **hub-sop**, **caavegotchi-spawn**,
**goball-teammate**, **aarcadeghst-changes**.

## What the Roster is

The roster is the live set of **cAavegotchi heroes** on the `gotchibot` cartridge
plus **dispatch sessions** (local MBP + remote iMac). It answers: who exists,
who is busy, who is focused, who Julius is talking to.

| Layer | Source of truth | Script / cache |
| --- | --- | --- |
| Cartridge heroes | Aarcade sim / lore cartridge | `identity.mjs`, onboarding, fleet sync |
| OpenClaw agents | `~/.openclaw` fleet map | `openclaw-fleet.mjs` (id ≡ hero id) |
| Focus (ORCH vs SUB) | `sessions/.focus.json` | `agent-focus.mjs` |
| List cache | `sessions/.focus-list.json` | rebuilt by `agent-focus list` / mesh `--live` |
| Hero status | sim + `sessions/.hero-agent-state.json` | `hero-agent-state.mjs` |
| Avatar pane | `sessions/.avatar-roster.json` | `avatar-roster.mjs` |

Orchestrator hero is typically **`owned-954`** (alias `gotchi`). Sub heroes are
other `owned-*` / `starter-*-h*` ids (e.g. LINK `starter-link-h1-1`, DAI `owned-22899`).

## Hero status vocabulary

| Status | Meaning |
| --- | --- |
| `available` | Not spun up; free for spawn / invite |
| `idle` | Has a role but no live session |
| `active` | Bound / present, not mid-compute |
| `working` | Live session building / computing |
| `assigned` | Standing task (cron / monitor); do not steal |
| `watching` | Monitor posture |

```bash
abra run gotchibot -- node ./scripts/hero-agent-state.mjs list
abra run gotchibot -- node ./scripts/hero-agent-state.mjs set <heroId> available
```

**Cooperation rule:** only assign work to `available` or `idle` unless Julius
explicitly reassigns. Never steal `assigned` / `watching` desks (esp. trader /
named collateral).

## Focus modes (who hears Julius)

| Mode | Meaning | How |
| --- | --- | --- |
| **ORCH** | Main gotchi / orchestrator | `/orch` or `agent-focus.mjs orch` |
| **SUB** | Direct chat with one hero | `/switch <n\|id>` or `select <id>` |

```bash
abra run gotchibot -- ./scripts/agent-focus.mjs list [--json]
abra run gotchibot -- ./scripts/agent-focus.mjs switch          # list
abra run gotchibot -- ./scripts/agent-focus.mjs switch owned-22899
abra run gotchibot -- ./scripts/agent-focus.mjs orch
abra run gotchibot -- ./scripts/agent-focus.mjs status [--json]
abra run gotchibot -- ./scripts/agent-focus.mjs chat "…"        # SUB → that hero
```

While **SUB-focused**, `chat` may **escalate to ORCH** when the prompt looks like
swarm work (`spawn`, `delegate`, `/list`, handoff, wallet, multi-part tasks).
Classifier: `scripts/focus-classify.mjs`. On `escalated: true`, continue as orch
with **delegate-first** (do not drop the prompt).

Sub desk `/switch` **excludes** the orchestrator — Tab to gotchi mode or `/orch`
to return.

## Decision table (synergy)

| Julius / situation | Do this |
| --- | --- |
| Who is on the roster? | `agent-focus.mjs list` or MCP `roster_list` |
| Talk as / to a specific gotchi | `select <id>` then `chat "…"` |
| Back to boss gotchi | `/orch` |
| New coding job, idle heroes | `delegate-pick.mjs` → `spawn` / `chat` as printed |
| Parallel independent jobs | `gotchi-multitask.mjs` / multiple spawns (one hero each) |
| Hand work to DAI (22899) | Protocol in skill **aarcadeghst-changes** |
| GoBall invite | skill **goball-teammate** — accept only if available |
| Meet / group channel | `gotchi-meet.mjs` / meet-room (chair + participants) |
| Hub / OpenClaw down | skill **hub-sop** first — roster chat needs gateway |

## Cooperation workflows

### 1) Orchestrator → worker (default)

1. `delegate-pick.mjs` (wallet gate + idle hero + host).
2. `agent-focus.mjs select <hero>` (optional pin).
3. Spawn self-contained prompt → `sessions/<id>/output.md`.
4. `wait` / `output` on correct `--host`.
5. Merge; surface `skill-requests.jsonl` to Julius.

### 2) Direct SUB chat (Julius talking to one hero)

1. `/switch <hero>` → SUB focus.
2. Messages go to that OpenClaw agent (not orch).
3. Orch keywords escalate automatically.
4. `/orch` when coordination is needed again.

### 3) Peer handoff (agent → agent)

Record intent (changes.json / meeting transcript / chat), then:

```bash
./scripts/agent-focus.mjs select <targetHero>
./scripts/agent-focus.mjs chat "<skill or task id>. Ack and continue."
```

Target acks, works, writes `output.md` or updates shared JSON. Escalate to orch
if blocked — **subs do not fan out the swarm themselves**.

### 4) Meet channel (multi-gotchi conversation)

Chair (usually orch) opens a meet; participants are roster heroes. Transcript
under `sessions/meetings/`. Use meet scripts — do not fake multi-speaker replies
in one agent.

### 5) External game roster (GoBall)

Separate API roster (`/api/goball-agent/roster`). Map seat ↔ hero; release to
`available` when the match ends.

## Agent communication norms

1. **Orch speaks to Julius**; workers speak in first person as their gotchi when
   SUB-focused or spawned.
2. **Prompts are self-contained**: context, constraints, definition of done,
   `output.md` path.
3. **No secrets in prompts** — abracadabra only.
4. **One hero per live dispatch session** unless multitask assigns distinct heroes.
5. **Skill requests**: append `sessions/<id>/skill-requests.jsonl`; orch asks
   Julius before editing `skills/registry.json`.
6. **Handoff / checkpoint**: `gotchibot handoff` / `checkpoint` across sessions.
7. **Claude tool from a sub-agent**: `node ./scripts/claudemode-ask.mjs "…"` or MCP
   `claude_ask` — **never** `abra run …` (Touch ID blocked headless). On Hub,
   bridge `:45678` must be up; Desk receiver `:45679` for wait replies.

## Exact commands (copy/paste)

```bash
# Roster
abra run gotchibot -- ./scripts/agent-focus.mjs list --json
abra run gotchibot -- ./scripts/gotchibot mesh --live

# Focus
./scripts/agent-focus.mjs select starter-link-h1-1
./scripts/agent-focus.mjs chat "status of your desk"
./scripts/agent-focus.mjs orch

# Delegate + spawn
abra run gotchibot -- ./scripts/delegate-pick.mjs
GOTCHIBOT_HERO_ID=<hero> abra run gotchibot -- \
  ./scripts/gotchi-orchestrate.mjs spawn --host auto --model sub "…"

# Gate
./scripts/wallet-gate.mjs
abra run gotchibot -- ./scripts/gotchibot identity bind
```

## MCP tools (gotchibot-synergy)

| Tool | Maps to |
| --- | --- |
| `roster_list` | `agent-focus list --json` |
| `roster_status` | `agent-focus status --json` |
| `roster_select` | `agent-focus select <id>` |
| `roster_orch` | `agent-focus orch` |
| `roster_chat` | `agent-focus chat "…"` |

Prefer MCP when loaded; otherwise Bash the commands above.

## Do not

- Spawn without a cAavegotchi / wallet gate
- Chat as orch while pretending to be a sub (or the reverse)
- Assign `assigned`/`watching` heroes without Julius
- Bypass `delegate-pick` when idle agents exist
- Install skills autonomously
- Invent Tailscale SSH when `abra run gotchibot --` exists
