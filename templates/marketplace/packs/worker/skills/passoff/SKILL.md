---
name: passoff
description: >-
  Hand live work from one cAavegotchi to another. Julius starts a job with one
  gotchi, walks away, comes back on a different gotchi — the outgoing agent
  packages what it already knows and messages the incoming agent, which picks
  up mid-stride. Load for /passoff, "pass this to LINK", "hand off to WBTC",
  "who was working on this", and at the start of any session that inherits work.
license: MIT
compatibility: opencode
metadata:
  audience: agents
  workflow: continuity
---

# Passoff

**Agent → agent.** `handoff` writes a file for the next *session*; passoff
messages the next *gotchi* and leaves a packet it can accept.

```bash
./scripts/gotchibot passoff send LINK --note "what's done" --next "what's left"
./scripts/gotchibot passoff resume            # incoming side: newest packet for me
```

## When to load

- Julius says: pass this to X · hand off to X · X takes it from here · switch
  this job to X · continue what DAI was doing
- You are starting work and the tree already has changes you did not make
- You are about to go idle / be replaced mid-job
- **Every fresh sub-agent session**: run `passoff resume` before you plan. If a
  packet is waiting, that is your job — do not re-derive it.

## Outgoing side (the agent handing off)

```bash
# 1. dry run — see exactly what the other gotchi will receive, send nothing
./scripts/gotchibot passoff send LINK --note "…" --next "…" --dry-run

# 2. send it (default delivery: OpenClaw chat to that hero)
./scripts/gotchibot passoff send LINK \
  --note "Copy button renders; click path fixed" \
  --next "Wire the CLI, then register the skill"
```

| Flag | Use |
|------|-----|
| `--from <n\|id\|name>` | Who is handing off (default: focused hero / orch) |
| `--note "…"` | **What is already done.** The one thing the packet cannot read off disk |
| `--next "…"` | The next concrete step |
| `--task "…"` | Override the task line (default: derived from note/anchor/warm session) |
| `--via openclaw` | Default — message the hero through the OpenClaw gateway |
| `--via spawn` | Gateway down: spawn that hero on the brief instead |
| `--via meet` | Post it into the open meeting as a mention |
| `--via none` | Write the packet only; the other gotchi collects it with `resume` |
| `--dry-run` | Print the brief, deliver nothing, save nothing |

Targets resolve through the same roster as `/switch` and `/meet invite`
(`n`, hero id, name, collateral). **Never invent an agent** — an unknown name is
an error, not a guess.

## Incoming side (the agent picking it up)

```bash
./scripts/gotchibot passoff resume                 # newest packet addressed to me
./scripts/gotchibot passoff resume --as WBTC       # explicitly as that hero
./scripts/gotchibot passoff accept p20260904-…     # a specific packet
./scripts/gotchibot passoff list [--all] [--json]  # what is waiting
./scripts/gotchibot passoff show [<id>]            # read without accepting
```

`accept` / `resume` print the full packet and mark it accepted. Then:

1. **Verify before you build.** A packet is a snapshot; the branch may have moved.
   Re-check the files it names.
2. **Do not restart the job.** Continue from `Next step`.
3. **Do not redo finished work** listed under `Done so far`.
4. Reply to Julius with what you inherited in one line, then keep working.

## What a packet carries

Captured, never invented — all of it read off disk at send time:

- repo, branch, HEAD, uncommitted files, `diff --stat` vs HEAD, last 5 commits
- the outgoing hero's newest session (id/model/status; prompt + output tail only
  while that session is still warm — under 12h or running)
- `sessions/.thread-anchor.json` when it is under 48h old (older is reported as
  stale and dropped, so nobody is sent to last week's file)
- the open meeting's topic + last 6 turns, the current project, `HANDOFF.md`
- `--note` / `--next` — the human part the disk cannot know

Stored as `sessions/passoff/<id>.json`; the latest renders to `sessions/PASSOFF.md`.
Status goes `pending` → `accepted` (or `dropped`).

## Delivery failures

If the OpenClaw gateway is down, `send` says so and **keeps the packet pending** —
nothing is lost. Either retry `--via spawn`, or let the other gotchi run
`passoff resume --as <hero>` when it comes up.

## Related

- `thread-continuity` — same idea *inside* one thread (files, selectors, parents)
- `gotchibot handoff` — session → session (`sessions/HANDOFF.md`), not agent → agent
- `delegate-first` — picking who gets the work; passoff is how the work travels

## Never

- Invent progress, blockers, or next steps that are not in the packet or the tree
- Pass to a hero that is not on the roster
- Restart a job that a packet says is half done
- Put secrets in `--note` / `--next` — packets are plain files in `sessions/`
