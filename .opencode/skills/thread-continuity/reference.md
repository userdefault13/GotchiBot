# thread-continuity — reference

## Decision tree

```
prompt arrives
    │
    ├─ clear new topic? ──yes──► normal search; new anchor after first edit
    │
    └─ no / ambiguous follow-up
            │
            ├─ read last turns
            ├─ read sessions/.thread-anchor.json (if topic matches)
            ├─ else HANDOFF.md / changes.json / cursor-cli.json
            │
            ├─ have file+selector?
            │     ├─ yes → resolve parent/sibling/value → edit → write anchor → reply line
            │     └─ no  → scoped search budget (file → dir → named views → tree)
            └─ still blocked → ask Julius one question OR full search with reason
```

## Parent / sibling resolution (CSS / Vue)

| User says | Resolve |
|-----------|---------|
| tighter / reduce / bump | Same selector; adjust numeric/token |
| parent / wrapper / container | One level up in selector chain, or the wrapping class in the same SFC |
| that padding / that gap | Property on current or parent rule — prefer rule you last touched |
| sibling | Next/prev rule in the same `<style scoped>` block |
| the button under it | Template sibling near the last-edited block in the same file |

Vue SFC tip: last edit in `<style>` → stay in style; last edit in `<template>` → stay in template unless they name a class that only exists in style.

## When to write `changes.json` vs only `.thread-anchor.json`

| Change | `.thread-anchor.json` | `aarcadeghst-changes` |
|--------|----------------------|------------------------|
| Tiny CSS tweak in an ongoing chat | Always | Optional |
| Multi-file My Paarcels feature | Always | Yes — new/updated entry |
| Hand to DAI / new session | Always | Yes if UI surface |

## Anchor freshness

- Prefer anchor if `topic` matches and `updatedAt` within the current work stream
- If anchor `repo`/`files` disagree with disk, **trust disk**, fix the anchor
- One active anchor only — do not keep an array of history here (HANDOFF/changes.json own history)

## cursorChatId

From `sessions/.cursor-cli.json` → `activeChatId`. Resume that id for hard-logic follow-ups on the same host.
