-- Batch recolor active sprite to bright arcade gold (preserves value structure).
-- Reference: saturated #FFDE00 panels, #FFF7B2 highlights, #9D722C bronze, #493111 shadow.
-- Usage:
--   IN=src.aseprite OUT=dst.aseprite aseprite -b "$IN" --script recolor_gold.lua

local spr = app.activeSprite
if not spr then
  local inPath = os.getenv("IN")
  if inPath and inPath ~= "" then spr = app.open(inPath) end
end
if not spr then error("No sprite open — pass file: aseprite -b file.aseprite --script recolor_gold.lua") end

local outPath = os.getenv("OUT")
if not outPath or outPath == "" then
  error("Set OUT=path.aseprite for the gold recolor output")
end

local pc = app.pixelColor

local function rgbToHsl(r, g, b)
  r, g, b = r / 255, g / 255, b / 255
  local max = math.max(r, g, b)
  local min = math.min(r, g, b)
  local h, s, l = 0, 0, (max + min) / 2
  if max ~= min then
    local d = max - min
    s = l > 0.5 and d / (2 - max - min) or d / (max + min)
    if max == r then
      h = (g - b) / d + (g < b and 6 or 0)
    elseif max == g then
      h = (b - r) / d + 2
    else
      h = (r - g) / d + 4
    end
    h = h / 6
  end
  return h * 360, s, l
end

local function lerp(a, b, t)
  return a + (b - a) * t
end

local function lerpColor(c1, c2, t)
  return {
    math.floor(lerp(c1[1], c2[1], t) + 0.5),
    math.floor(lerp(c1[2], c2[2], t) + 0.5),
    math.floor(lerp(c1[3], c2[3], t) + 0.5),
  }
end

-- Bright gold ramp (dark → highlight)
local RAMP = {
  { 0,   0,   0 },       -- outline
  { 26,  18,  6 },       -- warm ink
  { 73,  49,  17 },      -- #493111 deep shadow
  { 139, 69,  19 },      -- #8B4513 bronze shadow
  { 157, 114, 44 },      -- #9D722C metallic mid
  { 205, 163, 91 },      -- #CDA35B edge highlight
  { 255, 222, 0 },       -- #FFDE00 primary bright gold
  { 255, 234, 0 },       -- #FFEA00 saturated panel
  { 255, 242, 0 },       -- #FFF200 shine
  { 255, 247, 178 },     -- #FFF7B2 pale metallic streak
}

local function sampleRamp(t)
  t = math.max(0, math.min(1, t))
  local n = #RAMP
  local f = t * (n - 1)
  local i = math.floor(f) + 1
  local j = math.min(n, i + 1)
  local localT = f - (i - 1)
  local c = lerpColor(RAMP[i], RAMP[j], localT)
  return c[1], c[2], c[3]
end

local function brightGold(r, g, b, a)
  if a == 0 then return r, g, b, a end
  local h, s, l = rgbToHsl(r, g, b)

  -- Keep true blacks / screen void
  if l < 0.04 or (l < 0.07 and s < 0.2) then return 0, 0, 0, a end

  -- Lift + saturate: bright source hues become vivid yellow-gold
  local boost = 1.0
  if h >= 140 and h <= 230 then boost = 1.18 end  -- cyan/teal → bright panel gold
  if h >= 280 or h < 25 then boost = 1.08 end     -- magenta/pink → rose-gold mid

  local nl = (l ^ 0.72) * boost
  nl = math.min(0.99, nl + (s * 0.12))

  -- Desaturated mids still read metallic, not muddy
  if s < 0.12 and l > 0.2 and l < 0.85 then nl = nl + 0.08 end

  local nr, ng, nb = sampleRamp(nl)
  -- enforce warm gold: red leads, blue trails
  ng = math.min(ng, nr)
  nb = math.min(nb, math.floor(ng * 0.82))
  return nr, ng, nb, a
end

local function recolorImage(img)
  for y = 0, img.height - 1 do
    for x = 0, img.width - 1 do
      local p = img:getPixel(x, y)
      local a = pc.rgbaA(p)
      if a > 0 then
        local r, g, b = pc.rgbaR(p), pc.rgbaG(p), pc.rgbaB(p)
        r, g, b, a = brightGold(r, g, b, a)
        img:putPixel(x, y, pc.rgba(r, g, b, a))
      end
    end
  end
end

if spr.colorMode == ColorMode.INDEXED and spr.palettes[1] then
  local pal = spr.palettes[1]
  for i = 0, pal.size - 1 do
    local c = pal:getColor(i)
    local r, g, b, a = brightGold(c.red, c.green, c.blue, c.alpha)
    pal:setColor(i, Color{ red = r, green = g, blue = b, alpha = a })
  end
end

for _, layer in ipairs(spr.layers) do
  if layer.isImage then
    for _, cel in ipairs(layer.cels) do
      if cel.image then recolorImage(cel.image) end
    end
  end
end

spr:saveAs(outPath)
print("Wrote " .. outPath)
