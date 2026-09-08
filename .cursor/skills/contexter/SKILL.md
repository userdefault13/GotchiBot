---
name: contexter
description: >-
  Carry working knowledge across a context window. Use before compaction, before
  passoff/spawn, when context is low, or when a session continues earlier work —
  save key values, decisions, and dead ends; read them back after.
---

# Contexter (Cursor)

Load and follow the full protocol:

**Read** [`.opencode/skills/contexter/SKILL.md`](../../../.opencode/skills/contexter/SKILL.md)

Quick path:

```bash
./scripts/gotchibot contexter save \
  --task "…" --decision "… · why" --value "name=value" \
  --tried "…" --open "…" --next "…"
./scripts/gotchibot contexter latest --brief
```

## Automatic in Cursor

- `preCompact` saves a facts capsule and sets a pending marker
- next `stop` injects the brief once (`loop_limit: 1`)
- `sessionStart` also surfaces the latest capsule in the desk brief

Still write a narrative capsule yourself at real checkpoints — the automatic
save is a safety net.
