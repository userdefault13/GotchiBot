# aarcade-cartridge-schema — write target

Existing OpenCode MCP. Schema-only (rules/checkpoint lint). **Not** a mint server. Do not invent another MCP.

## Writes vs reads

- **Writes** (`mint-sub`, `bind-owned`, `bind-starter`, hero status): `http://127.0.0.1:8791` — Docker `aarcade-cartridge-sim` (hosts cartridge.aarcadeghst.com / aarcadeghst.com). Needs `gotchiOwnership.cjs` beside `cartridgeSim.cjs`. Always `abra run gotchibot --`.
- **Lore / main API** `:3010` (`gotchi-lore-api`): Cartridge SIM is **DISABLED**. Health/lore/reads only. Never mint/bind against `:3010`.
- Mint **401** → sim key is wrong. Do **not** fall back to `:3010`.

cAavegotchi spawn rules: skill **cartridge-mint**. Spawn UI: `/spawn` or `sessions/.spawn-request.json`.
