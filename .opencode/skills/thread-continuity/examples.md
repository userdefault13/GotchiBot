# Examples — thread-continuity

## Same-thread CSS (My Paarcels detail)

| Turn | User | Agent does |
|------|------|------------|
| 1 | detail img max-width → 220px | Edit realm rule in `AssetDetail.vue`; write `.thread-anchor.json` |
| 2 | reduce max-height to 190px | Same selector; change prop only; refresh anchor |
| 3 | reduce detail-svg padding to 1rem | **Parent** `.detail-svg`; same file; no `rg padding` |
| 4 | a bit more padding | Same `.detail-svg` rule; nudge value |

Reply line after turn 3:

```
anchor: AarcadeGh-t AssetDetail.vue :: .detail-svg → padding 1rem (parent of realm img rule)
```

## Follow-up that looks like a new search (trap)

User: "where's the sell button styling?"  
If last turn was left-column `/mypaarcel` actions in `AssetDetail.vue` / `MyLand.vue` → open **those** files first. Only if absent, scoped search under `src/components/AssetDetail` and `src/views/MyLand.vue`.

## Fresh GotchiBot session, same topic

```bash
# 1) continuity artifacts
cat sessions/.thread-anchor.json
# 2) optional handoff
# sessions/HANDOFF.md
# 3) UI log
# .opencode/skills/aarcadeghst-changes/changes.json
```

Then `Read` `files[]` from the anchor. Do not start with `rg "detail-svg"`.

## Cursor bridge

```bash
./scripts/cursor-cli.mjs resume "thread-continuity: set .detail-svg padding to 1rem in AssetDetail.vue (parent of last img rule). No full-tree search."
```

After success, set `cursorChatId` in `.thread-anchor.json` from `sessions/.cursor-cli.json`.

## Topic break

Prior: My Paarcels CSS.  
User: "fix the staking APR label on /stake".  
→ New topic. Do not use the detail-svg anchor. Search `Stake.vue`; write a **new** anchor when done.

## Hand to DAI

1. Update `.thread-anchor.json`
2. Append `changes.json` entry (`consumerHero: owned-22899`)
3. `./scripts/agent-focus.mjs select owned-22899`
4. Chat: `thread-continuity + aarcadeghst-changes: sync <id>. Read anchor + entry; do not full-tree search.`
