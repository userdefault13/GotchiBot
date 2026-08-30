# AarcadeGh-t UI reference (My Paarcels)

Repo root: `/Users/juliuswong/Dev/AarcadeGh-t`

Sibling skill in that repo: `.cursor/skills/aarcadeghst/SKILL.md` (routes, stack,
hackathon — general). This GotchiBot skill is narrower: **parcel detail UI
handoffs to owned-22899**.

## Stack reminder

- Vue 3 + Vite + Vue Router
- Realm / Base: `src/config/realmBase.ts`, Diamond + Realm contracts
- Parcel detail composable: `src/composables/useParcelRealmDetail.ts`
- Install thumbs: `src/helpers/installationThumbs.ts`, `src/components/MyLand/InstallationThumb.vue`

## Layout

Route: `/mypaarcel` (My Paarcels) — `src/views/MyLand.vue`

When a parcel is selected (`activeTab === 'parcels'`):

```
.parcel-detail-split
├── .parcel-split-left          ← LEFT COLUMN
│   └── parcel cycle + AssetDetail (preview, sell/auction/transfer actions)
└── .parcel-split-right
    └── ParcelRealmPanel        ← RIGHT PANEL (tabs)
```

### Left column (`left-column`)

| Piece | File |
|-------|------|
| Split layout / cycle buttons | `src/views/MyLand.vue` |
| Asset preview / actions | `src/components/AssetDetail/AssetDetail.vue` (+ related modals) |

### Right panel tabs (`ParcelRealmPanel.vue`)

| Tab id | Area tag | Behavior |
|--------|----------|----------|
| `overview` | `other-mypaarcel` | Meta grid (name, code, size, district, coords) |
| `alchemica` | `alchemica` | Available / remaining / claimed table |
| `surveys` | `surveys` | Status, round, surveyed totals, per-round table (read-only) |
| `installations` | `installations-drawers` + `bounce-gate` | Grouped `<details>` drawers |
| `rights` | `rights` | Access modes; on-chain save |

### Installations drawers

Group order in `ParcelRealmPanel.vue` (`INSTALL_GROUP_ORDER`):

1. Altars (`altar`)
2. Harvesters (`harvester`)
3. Reservoirs (`reservoir`)
4. **Bounce Gates** (`bounceGate`) ← area tag `bounce-gate`
5. Other (`other`)

Bounce Gate art notes live in `installationThumbs.ts` (item 145 GIF; do not
confuse decorative north/south gate tiles with Bounce Gate).

## Related docs / plans (AarcadeGh-t)

Prefer these when an entry sets `planRef`:

| Doc | Path |
|-----|------|
| Parcel revoke / rights | `docs/CPARCEL_REVOKE.md` |
| Platform scope | `docs/AARCADE_PLATFORM_SCOPE.md` |
| Cartridge platform | `docs/CARTRIDGE_PLATFORM_PLAN.md` |
| Gotchiverse player ops (external skill) | Claude skill `aavegotchi-gotchiverse` |

GotchiBot plans under `.opencode/plans/` are orchestration/comms oriented; My
Paarcels UI work is primarily sourced from the AarcadeGh-t tree above.

## Out of scope for this skill

- Twitter / newsfeed (`aarcade-comms`)
- Hackathon hub / Juicebox / Lens
- Baazaar / GBM listing flows (unless they appear in left-column AssetDetail
  actions for a parcel — then tag `left-column`)
