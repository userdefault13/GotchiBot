---
name: thread-continuity
description: >-
  Before broad codebase search, reuse this thread's prior turns: last files,
  selectors, values, and parent/sibling targets. Use on follow-ups (parent,
  tighter, same component, also/now/reduce) and when handing work across
  Cursor CLI, OpenClaw, or GotchiBot sessions via HANDOFF / changes.json /
  .thread-anchor.json.
license: MIT
compatibility: opencode
metadata:
  audience: agents
  workflow: continuity
---

# thread-continuity

**Do not rediscover from scratch** when Julius continues the last edit.

Load this skill on follow-ups, same-surface tweaks, and any handoff that
continues My Paarcels / AarcadeGh-t UI work.

## When to load

- Phrasing: also, now, parent, same, tighter, reduce, that element, the padding,
  sibling, wrapper, container, again, more, less, undo-ish "back a bit"
- Same route/surface as last turn (e.g. `/mypaarcel` after a detail CSS tweak)
- Spawn/chat/`cursor-cli` after a turn on the same topic
- User names **thread-continuity** or "past chats" / "previous response"

## Continuity stack (read in this order)

| Priority | Source | Use when |
|----------|--------|----------|
| 1 | **This thread** — last 1–3 assistant turns | Always first |
| 2 | `sessions/.thread-anchor.json` | Fresh session / hero switch, same topic |
| 3 | `sessions/HANDOFF.md` | After `./scripts/gotchibot handoff` |
| 4 | `.opencode/skills/aarcadeghst-changes/changes.json` | My Paarcels UI entries pending/acked/in_progress |
| 5 | `sessions/.cursor-cli.json` | Hard logic → `cursor-cli.mjs resume` |

Stop reading once you have a solid **anchor** (file + selector + last values).

## Build the anchor (mental or written)

From the latest continuity source, extract:

```
repo:     e.g. /Users/juliuswong/Dev/AarcadeGh-t
file:     e.g. src/components/AssetDetail/AssetDetail.vue
selector: e.g. .asset-detail--realm .svg-display img
parent:   e.g. .detail-svg
sibling:  optional
props:    e.g. max-height: 190px; max-width: 220px
route:    e.g. /mypaarcel
intent:   one line of what the last turn did
```

If `sessions/.thread-anchor.json` exists and `updatedAt` is recent / `topic` matches,
**prefer it** over re-deriving from chat alone.

### Anchor file schema

Path: `sessions/.thread-anchor.json` (GotchiBot workspace)

```json
{
  "updatedAt": "ISO-8601",
  "hero": "owned-22899",
  "topic": "mypaarcel-detail-css",
  "repo": "/Users/juliuswong/Dev/AarcadeGh-t",
  "files": ["src/components/AssetDetail/AssetDetail.vue"],
  "selector": ".asset-detail--realm .svg-display img",
  "parent": ".detail-svg",
  "props": { "max-height": "190px", "max-width": "220px" },
  "route": "/mypaarcel",
  "lastIntent": "Set realm detail img max-height to 190px",
  "cursorChatId": null
}
```

Update this file **after every successful edit** in a continuity chain (overwrite;
keep one active anchor). Do not invent secrets. Paths relative to `repo` when possible.

## Order of operations (required)

1. **Detect continuity** — Is this a follow-up or a new topic? (see Topic change)
2. **Load anchor** — thread → `.thread-anchor.json` → HANDOFF → changes.json → cursor-cli state
3. **Resolve target**
   - Same property / "tighter" / "reduce" → same selector, new value
   - "parent" / "wrapper" / "container" → `parent` or climb one CSS/DOM level in the same file
   - "sibling" → adjacent rule/block in the same `<style>` or template section
   - "also …" on another element in the same view → same file first; only then same folder
4. **Edit** — `Read` the file (focused range) + `StrReplace`. No repo-wide `Grep`/`Glob` yet.
5. **Scoped search budget** (only if blocked) — see below
6. **Write back** — refresh `.thread-anchor.json`; for My Paarcels UI, append/update
   `aarcadeghst-changes` entry when the change is handoff-worthy
7. **Reply anchor line** — so the next turn stays warm (format below)

## Scoped search budget

If the selector is missing from the file:

1. Search **inside that file only**
2. Then **same directory** (`Glob` / `Grep` path-limited)
3. Then route/view name from anchor (`MyLand`, `ParcelRealmPanel`, …)
4. **Full-tree search last** — and say why you broke continuity

Never start at step 4.

## Topic change (break continuity)

Treat as a **new** thread when:

- User names a different route/product ("stake", "baazaar", "hackathon")
- No shared file/selector with the last turn and no matching anchor topic
- User says "new task", "ignore previous", "from scratch"

Then: clear or ignore stale `.thread-anchor.json` for targeting; search normally.
Optionally set a new anchor after the first edit of the new topic.

## Cursor CLI

Same topic → **resume**, never `--new-chat`:

```bash
./scripts/cursor-cli.mjs resume "thread-continuity: <goal>. Anchor file=<path> selector=<css>. Parent/sibling as needed. No full-tree search."
```

New hard-logic topic → `run` is fine; then write `.thread-anchor.json` + store chat id.

```bash
./scripts/cursor-cli.mjs status   # see active chat id
```

Put `cursorChatId` into the anchor when known.

## Cross-session / hero handoff

| Situation | Action |
|-----------|--------|
| New OpenClaw session, same UI work | Read `.thread-anchor.json` + `HANDOFF.md` before tools |
| Passing to DAI (`owned-22899`) | Update `changes.json` + chat with entry id; DAI loads this skill first |
| After major context dump | `./scripts/gotchibot handoff` then continue from `HANDOFF.md` |
| iMac vs MBP | Same repo paths; resume cursor chat on the host that owns the chat id |

## Reply format (keep the chain warm)

End continuity edits with one compact line:

```
anchor: <repo-short> <file> :: <selector> → <what changed> (parent: <parent>)
```

Example:

```
anchor: AarcadeGh-t AssetDetail.vue :: .detail-svg → padding 1rem (parent of realm img rule)
```

Do not dump the whole CSS block unless asked.

## Anti-patterns

- Grepping the monorepo for a class you just edited
- Re-listing `skills/` or routes when the last turn already named the path
- `cursor-cli run --new-chat` for "make the padding smaller"
- Ignoring `.thread-anchor.json` / HANDOFF / changes.json on a fresh session of the same topic
- Overwriting `.thread-anchor.json` with a different topic without checking Topic change
- Inventing installs — this skill is approved in `skills/registry.json`

## Related skills

- `aarcadeghst-changes` — durable My Paarcels UI handoff log
- `cursor-cli` — hard logic; use `resume` under this skill
- `aarcadeghst` — AarcadeGh-t map (only if topic is new or anchor missing)

## See also

- [examples.md](examples.md)
- [reference.md](reference.md)
