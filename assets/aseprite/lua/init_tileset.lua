-- Create a blank tileset document from env vars for CLI batch runs.
local tileW = tonumber(os.getenv("TILE_W") or "16")
local tileH = tonumber(os.getenv("TILE_H") or "16")
local cols = tonumber(os.getenv("COLS") or "8")
local rows = tonumber(os.getenv("ROWS") or "8")
local out = os.getenv("OUT") or "tileset.aseprite"

local sprite = Sprite(tileW * cols, tileH * rows, ColorMode.RGB)
app.activeSprite = sprite

sprite:saveAs(out)
print("Wrote " .. out)
