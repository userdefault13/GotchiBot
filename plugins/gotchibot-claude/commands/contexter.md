---
description: Save or read a context capsule — key values and decisions that survive a compaction
argument-hint: [save | latest | list | show <id>]
allowed-tools: Bash(./scripts/gotchibot contexter:*), Bash(node scripts/contexter.mjs:*)
---

```bash
./scripts/gotchibot contexter $ARGUMENTS
```

No arguments → `latest`.

**When you run `save`, you write the narrative** — the half no script can infer.
Do not save a bare capsule; fill in what you actually know right now:

```bash
./scripts/gotchibot contexter save \
  --task "what is in flight, one line" \
  --decision "what was settled, and why it stands" \
  --value "name=value you would hate to rediscover" \
  --tried "what already failed, so it is not repeated" \
  --open "still unresolved" \
  --next "the single next step"
```

Save before `/compact`, when context runs low, after an investigation that
produced identifiers, and before a passoff or spawn.

Reading one back: continue from **Next step**, do not re-litigate **Decisions**,
do not repeat **Dead ends**, and verify anything you act on — a capsule is a
snapshot and the tree moves.

In this project both ends are automatic: a PreCompact hook saves a facts-only
capsule and a PostCompact hook injects the brief into the fresh window. That is
a safety net; your own capsule carries the reasoning.

Skill: **contexter**.
