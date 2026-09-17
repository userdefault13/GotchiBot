---
name: aseprite-tool
description: >
  GotchiBot wrapper for the Aseprite CLI: batch export spritesheets, init blank
  tilesets/sprites via Lua, run custom scripts, inspect layers/tags. Paths confined
  to the repo and config/aseprite.json write roots.
license: MIT
compatibility: opencode
metadata:
  audience: orchestrator
  workflow: aseprite-tool
---

# Aseprite Tool (aseprite-tool)

## Prerequisites

- **Aseprite** installed with CLI on PATH (`aseprite --version`), or set `ASEPRITE_BIN`.
- Verify: `./scripts/gotchibot aseprite check`

No autonomous installs — if missing, ask Julius to install Aseprite or add the binary to PATH.

## Subcommands

| Command | Purpose |
|---------|---------|
| `check` | Verify CLI availability |
| `export <src.aseprite> [out-dir]` | PNG spritesheet + `json-array` metadata |
| `init-tileset --out <file>` | Blank tileset (bundled Lua) |
| `init-sprite --out <file>` | Blank sprite canvas |
| `script <file.lua> [--set KEY=val]` | Batch Lua (`-b --script`) |
| `info <file.aseprite>` | List layers and animation tags |
| `svg-import <file.svg>` | Import SVG → `.aseprite` via **aesprite-svgimporter** |
| `svg-export <file.aseprite>` | Export frame(s) to `.svg` or `.svg.json` via **Aseprite-SVGexporter** |

All subcommands emit **JSON on stdout**; errors on stderr.

## Typical workflow

```bash
# 1. Check CLI
./scripts/gotchibot aseprite check

# 2. Create blank tileset (32×32, 8×8 grid)
./scripts/gotchibot aseprite init-tileset \
  --out build/forest.aseprite --tile-w 32 --tile-h 32 --cols 8 --rows 8

# 3. (Human or agent edits in Aseprite GUI — optional)

# 4. Export for the game engine
./scripts/gotchibot aseprite export build/forest.aseprite build/sprites --sheet-type rows

# 5. Inspect tags/layers
./scripts/gotchibot aseprite info build/forest.aseprite

# 6. SVG round-trip (sibling repos — paths in config/aseprite.json)
./scripts/gotchibot aseprite svg-import logo.svg --out build/logo.aseprite --width 64 --height 64
./scripts/gotchibot aseprite svg-export build/logo.aseprite --out build/logo.svg
./scripts/gotchibot aseprite svg-export sprite.aseprite --all-frames --out build/sprite
```

## SVG extensions

Configured in `config/aseprite.json` → `extensions`:

| Key | Repo | Env override |
|-----|------|--------------|
| `svgImporter` | `aesprite-svgimporter` | `GOTCHIBOT_SVG_IMPORTER` |
| `svgExporter` | `Aseprite-SVGexporter` | `GOTCHIBOT_SVG_EXPORTER` |

- **Import** runs `svg-importer-cli.lua` with cwd set to the importer checkout (relative `dofile` deps).
- **Export** uses GotchiBot wrappers in `assets/aseprite/lua/svg-export-cli.lua` that load `svg-generator.lua` from the exporter checkout.
- Use **flat SVG fills** (no CSS classes) for reliable importer colors.
- `--all-frames` writes numbered files: `base1.svg`, `base2.svg`, …

## Path safety

Reads/writes must stay under roots listed in `config/aseprite.json`:

- Read: `.`, `~/Downloads`, `~/Dev`
- Write: `.`, `build/`, `assets/`, `output/`, `sessions/`, `~/Downloads`, `~/Dev`

Default export dir: `build/aseprite/`.

## Bundled Lua templates

- `assets/aseprite/lua/init_tileset.lua` — env: `TILE_W`, `TILE_H`, `COLS`, `ROWS`, `OUT`
- `assets/aseprite/lua/init_sprite.lua` — env: `WIDTH`, `HEIGHT`, `OUT`

Custom scripts: `./scripts/gotchibot aseprite script path/to/script.lua --set OUT=build/foo.aseprite`

## Agent notes

- Always use **batch mode** (`-b`) — the wrapper enforces this.
- Name animation tags in Aseprite (`idle`, `walk`, …) before export for stable JSON.
- Keep tile size and palette consistent within one tileset.
- For rich art briefs / ASCII→tilemap pipelines, see the external `aseprite-pixel-art` skill; this tool is the GotchiBot-native CLI surface.

## Export output

`export` writes:

- `<name>.png` — spritesheet
- `<name>.json` — frame metadata (`json-array` format)

Example stdout:

```json
{"type":"export","status":"ok","source":"build/forest.aseprite","sheet":"build/sprites/forest.png","data":"build/sprites/forest.json","sheetType":"rows"}
```
