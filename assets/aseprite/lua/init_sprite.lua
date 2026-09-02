-- Create a blank sprite canvas from env vars for CLI batch runs.
local width = tonumber(os.getenv("WIDTH") or "32")
local height = tonumber(os.getenv("HEIGHT") or "32")
local out = os.getenv("OUT") or "sprite.aseprite"

local sprite = Sprite(width, height, ColorMode.RGB)
app.activeSprite = sprite

sprite:saveAs(out)
print("Wrote " .. out)
