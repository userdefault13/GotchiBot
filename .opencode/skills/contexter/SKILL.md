---
name: contexter
description: >-
  Carry a session's working knowledge across a context window. Save a capsule of
  key values, decisions and dead ends before the window compacts, and read it
  back after. Load when context is running low, before /compact or a handoff,
  when a long investigation has accumulated identifiers worth keeping, or at the
  start of a session that continues earlier work.
license: MIT
compatibility: opencode
metadata:
  audience: agents
  workflow: continuity
---

# Contexter

A compaction summary keeps the **story** and drops the **specifics**. What gets
lost is exactly what was expensive to obtain: the session id an agent runs
under, the container that answers, the port that works, the approach you already
proved wrong at 2am. Contexter writes those down while they are still in reach.

```bash
./scripts/gotchibot contexter save --task "…" --next "…"    # before the window turns
./scripts/gotchibot contexter latest --brief                # what the next window reads
```

## When to save

- Context is running low, or you are about to `/compact`
- You just finished an investigation that produced identifiers or ruled things out
- Before a `passoff`, a spawn, or ending a working block
- After any decision you would be annoyed to re-litigate

Cheap and local — no SSH, no gateway, no cartridge. A capsule must never fail to
save because a service is down; that is precisely when you need it.

## A capsule is two halves

**Facts** are read off the desk automatically: branch, HEAD, recent commits,
uncommitted files, running sessions, focus hero, open meeting, pending passoffs.

**Narrative** is yours, and it is the half no script can infer:

| Flag | What belongs there |
|---|---|
| `--task` | What is actually in flight, in one line |
| `--decision` | A decision **with its reason** — the reason is what stops it being re-argued |
| `--value name=value` | An identifier expensive to rediscover: session id, container, port, hash, path |
| `--tried` | A dead end. This is the highest-value field: it stops the next window repeating a failure |
| `--open` | A thread still unresolved, so it is not mistaken for done |
| `--next` | The single next step |

Write them as facts a stranger could act on. `--value "gateway=http://100.68.95.90:18789 (healthy after cold start)"`
beats `--value "gateway=fixed"`.

## Reading one back

```bash
./scripts/gotchibot contexter latest          # full capsule
./scripts/gotchibot contexter latest --brief  # the compact form
./scripts/gotchibot contexter list            # the chain
./scripts/gotchibot contexter show <id>
```

Capsules chain — each records its predecessor, so a long session leaves a trail
rather than one overwritten file. `sessions/CONTEXT.md` is always the newest;
`sessions/context/<id>.md` is the archive. `prune --keep N` trims it.

**A capsule is a snapshot, not truth.** The tree moves. Verify anything you are
about to act on, continue from **Next step**, and do not redo what **Decisions**
and **Dead ends** already settled.

## In Claude Code this is automatic

The `.claude/` layer wires both ends: a **PreCompact** hook saves a facts capsule
before the window is summarised, and a **PostCompact** hook injects the brief
back into the fresh window. The hook can only capture facts, so still save your
own capsule with the narrative at real checkpoints — the automatic one is a
safety net, not a substitute.

## In Cursor this is automatic too

Cursor has no PostCompact inject. The `.cursor/` layer saves on **preCompact**,
drops `sessions/.cursor-capsule-pending`, and the next **stop** hands the brief
back once (`loop_limit: 1`). `sessionStart` also surfaces the latest capsule in
the desk brief. Same rule: write a narrative capsule yourself at checkpoints.

## Related, and different

| Tool | Boundary it crosses |
|---|---|
| **contexter** | one worker, across its own context window |
| `thread-continuity` | one thread, across follow-up turns (files, selectors) |
| `passoff` | agent → agent, across desks |
| `gotchibot handoff` | session → session (`sessions/HANDOFF.md`) |

## Never

- Invent a value you did not verify — a wrong identifier is worse than none
- Save a capsule with no `--task` and no `--next` and call it a handoff; that is facts only
- Treat a capsule as current state without checking
