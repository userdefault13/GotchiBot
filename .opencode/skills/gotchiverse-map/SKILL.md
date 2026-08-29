---
name: Gotchiverse map
description: Use when listing Gotchiverse / Paarcel regions, cities, or bounce-gate destinations (Daark Forest, Citadel, Aarena, etc.).
---
# Gotchiverse map

Read-only region list from Paarcel's travel cities.

## Steps
1. Read `config/gotchiverse-regions.json` (or run `node ./scripts/gotchiverse-map.mjs`).
2. List cities in `id` order. That index is the in-game city id.
3. If Julius names a place, show its id and the cities immediately before/after.
4. Do not invent extra districts. This list is the map.
5. No edits, no trades, no spawns.
