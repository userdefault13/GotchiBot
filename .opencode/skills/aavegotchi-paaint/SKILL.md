---
name: aavegotchi-paaint
description: >
  Compose Aavegotchi sprites from raw trait values (haunt, collateral, eyeShape,
  eyeColor) and generate body/goball spritesheets, via the Aseprite-AavegotchiPaaint
  CLI. Use whenever asked to render, compose or preview a gotchi, or to rebuild a
  spritesheet for Unity (Paarcel, goball).
license: MIT
compatibility: opencode
metadata:
  audience: orchestrator
  workflow: aavegotchi-paaint
---

# Aavegotchi Paaint (aavegotchi-paaint)

Renders gotchi sprites from the JSON trait databases. Distinct from the generic
`aseprite-tool` skill: that one is a thin Aseprite CLI wrapper, this one knows
Aavegotchi trait semantics and resolves art from trait values on its own.

**Repo:** `~/Dev/Aseprite-AavegotchiPaaint` — run all commands from that directory.

## Prerequisites

- `aseprite` on PATH (`aseprite --version`), or set `ASEPRITE=/path/to/aseprite`.
- The `aesprite-svgimporter` checkout at `~/Dev/aesprite-svgimporter` — the
  rasterizer loads `svg-parser.lua` and `svg-renderer-professional.lua` from it.

No autonomous installs. If either is missing, say so and stop.

## Composing a gotchi — the main entry point

Pass trait values. The script resolves every asset itself; never hand-pick an
asset directory or rarity file.

```bash
./aavegotchi-cli.sh compose --haunt 2 --collateral DAI --eyeShape 99 --eyeColor 38
```

```
haunt 2  amDAI
  eye shape 99 -> haunt2 id17 (DAI Collateral) [eye-shape database]
  eye color 38 -> common band #ff7d00
Saved: Output/gotchis/gotchi-h2-amdai-es99-ec38-front.png
```

| Flag | Values | Default |
|------|--------|---------|
| `--haunt` | `1` or `2` | `2` |
| `--collateral` | bare symbol (`DAI`) or full (`amDAI`) | prompts |
| `--eyeShape` | `0`–`99` | prompts |
| `--eyeColor` | `0`–`99` | prompts |
| `--view` | `front` `left` `right` `back` `all` | `front` |
| `--hand` | `down_open` `down_closed` `up` | `down_open` |
| `--mouth` | `neutral` `happy` `sad` `surprised` | `neutral` |
| `--scale` | integer, also writes `name@Nx.png` | none |
| `--out` | explicit output path | `Output/gotchis/` |

Output is a PNG, one 64 px cell per view, laid out left to right.

## Trait semantics

**Haunt picks the collateral family.** Haunt 1 uses the Aave v1 `ma*` tokens,
haunt 2 the v2 `am*` tokens, so a bare `DAI` resolves to `maDAI` under haunt 1
and `amDAI` under haunt 2. Haunt 1 has 9 collaterals, haunt 2 has 7.

**Rarity bands** apply to both eyeShape and eyeColor:

| Range | Band | Eye colour |
|-------|------|-----------|
| 0–1 | mythical low | `#ff00ff` |
| 2–9 | rare low | `#0064ff` |
| 10–24 | uncommon low | `#5d24bf` |
| 25–74 | common | the collateral's own primary |
| 75–89 | uncommon high | `#36818e` |
| 90–97 | rare high | `#ea8c27` |
| 98–99 | mythical high | `#51ffa8` |

**eyeShape 98–99 is the collateral-branded shape** — the DAI logo as eyes, and so
on. It is selected by the collateral's own `eyeShapeSvgId`, not by range.

## Other commands

| Command | Purpose |
|---------|---------|
| `body-sheet <collateral>` | Body spritesheet → `Output/aavegotchi-body-sprites-<c>.aseprite` |
| `goball-sheet <collateral> <id>` | 64 px / 11-row sheet for goball + Paarcel |
| `build [collateral] [view] [hand] [mouth]` | Compose from the `.aseprite` library instead of JSON |
| `generate-bodies` | PNG body sheets, all 16 collaterals |
| `list [collateral]` | Collaterals and available eye directories |
| `smoke [collateral]` | End-to-end check; prints `SMOKE_PASSED` |

`build` also accepts `--script-param haunt/eyeShape/eyeColor` when driven directly.

## Body spritesheet layout

**1024 × 384 px, 16 columns × 6 rows of 64 px, single frame.** Index as
`row * 16 + column`.

```
      c1  c2  c3  c4  c5  c6  c7  c8  c9  c10 c11 c12 c13 c14 c15 c16
row1  ##  ##  ##  ##  ..  ..  ..  ..  ..  ##  ##  ##  ##  ##  ##  ##
row2  ##  ##  ##  ##  ..  ..  ..  ..  ..  ..  ..  ..  ..  ..  ..  ..
row3  ##  ##  ..  ..  ..  ##  ##  ##  ..  ..  ..  ..  ..  ..  ..  ..
row4  ##  ##  ##  ##  ..  ##  ##  ##  ..  ..  ..  ..  ..  ..  ..  ..
row5  ##  ##  ##  ##  ..  ##  ##  ##  ..  ..  ..  ..  ..  ..  ..  ..
row6  ##  ##  ##  ##  ..  ##  ##  ##  ..  ..  ..  ..  ..  ..  ..  ..
```

Rows are front, front, front, left, right, back. Columns 6–8 are take-damage;
columns 10–16 on row 1 are the 7-frame death sequence. 55 of 96 cells are blank —
skip empties at import, do not assume a dense grid. Columns 5 and 9 are blank by
design (9 is reserved for the take-damage animation).

## Agent notes

- **`--script-param` must come before `--script`**, or `app.params` is empty. The
  shell wrapper already orders this correctly; only matters when calling
  `aseprite -b` directly.
- **Prefer `compose` over `build`.** `compose` reads the JSON databases and
  handles every trait value. `build` reads the `.aseprite` library, which has no
  haunt-1 collateral eye shapes (its ids stop at 16 while haunt 1 needs 17–25);
  it will say so rather than substitute silently.
- **Never hand-pick an eye directory.** Directory range labels are not a reliable
  index — resolution goes through the haunt database by id. Pass trait values and
  let the script resolve.
- Composition is data-driven: new buckets or collaterals in `JSONs/` are picked
  up without code changes.
- The `iso*` keys in `JSONs/Base/` are the diagonal facings of the 3/4
  Zelda-style view system. This project has two view systems, 3/4 and
  side-scroll; it is not isometric.

## Source of truth

| Path | Holds |
|------|-------|
| `JSONs/Base/` | Per-collateral body, hands, mouth, eyes, shadow, take-damage, death |
| `JSONs/aavegotchi_db_eye_shapes_haunt{1,2}.json` | Eye shapes, by haunt and id |
| `JSONs/aavegotchi_db_collaterals_haunt{1,2}.json` | Collateral colours and `eyeShapeSvgId` |
| `JSONs/aavegotchi_db_rarity.json` | Rarity band colours |
| `Aseprites/Collaterals/` | The `.aseprite` library used by `build` |

`Output/`, `SVGs/` and `PNGs/` are generated and gitignored. Regenerate rather
than edit. Sync `JSONs/` from AavegotchiQuerey; see `GOTCHI_COMPOSITION.md` there.

To regenerate the haunt-2 eye library after a database change:

```bash
aseprite -b --script-param apply=1 --script generate-haunt2-eye-library.lua
```

Runs dry without `apply=1`. Covers the 7 `am*` collaterals only, since haunt 2
does not use the `ma*` tokens.
