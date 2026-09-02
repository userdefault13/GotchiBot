-- Batch recolor active sprite to cool silver (preserves value structure).
-- Usage:
--   IN=src.aseprite OUT=dst.aseprite aseprite -b "$IN" --script recolor_silver.lua

local spr = app.activeSprite
if not spr then
  local inPath = os.getenv("IN")
  if inPath and inPath ~= "" then spr = app.open(inPath) end
end
if not spr then error("No sprite open — pass file: aseprite -b file.aseprite --script recolor_silver.lua") end

local outPath = os.getenv("OUT")
if not outPath or outPath == "" then
  error("Set OUT=path.aseprite for the silver recolor output")
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

local function hslToRgb(h, s, l)
  h = h % 360
  local c = (1 - math.abs(2 * l - 1)) * s
  local x = c * (1 - math.abs((h / 60) % 2 - 1))
  local m = l - c / 2
  local rp, gp, bp = 0, 0, 0
  if h < 60 then rp, gp, bp = c, x, 0
  elseif h < 120 then rp, gp, bp = x, c, 0
  elseif h < 180 then rp, gp, bp = 0, c, x
  elseif h < 240 then rp, gp, bp = 0, x, c
  elseif h < 300 then rp, gp, bp = x, 0, c
  else rp, gp, bp = c, 0, x end
  return math.floor((rp + m) * 255 + 0.5), math.floor((gp + m) * 255 + 0.5), math.floor((bp + m) * 255 + 0.5)
end

local function coolSilver(r, g, b, a)
  if a == 0 then return r, g, b, a end
  local h, s, l = rgbToHsl(r, g, b)
  if l < 0.06 and s < 0.45 then return 20, 22, 28, a end
  if l > 0.94 and s < 0.12 then return 245, 248, 252, a end

  local nh, ns, nl = 215, math.min(0.35, s * 0.4 + 0.08), l
  if h >= 150 and h <= 220 then
    nh, ns, nl = 210, math.min(0.45, ns + 0.1), math.min(0.92, nl + 0.03)
  elseif h >= 240 and h <= 330 then
    nh, ns, nl = 225, math.min(0.3, ns * 0.7), nl * 0.88
  elseif h >= 40 and h < 80 then
    nh, ns, nl = 212, math.min(0.2, ns * 0.5), nl
  elseif h >= 300 or h < 30 then
    nh = 218
  end

  local nr, ng, nb = hslToRgb(nh, math.max(0.04, ns), nl)
  local avg = math.floor((nr + ng + nb) / 3)
  nr = math.floor(nr * 0.35 + avg * 0.65)
  ng = math.floor(ng * 0.35 + avg * 0.65)
  nb = math.min(255, math.floor(nb * 0.45 + avg * 0.55) + 2)
  return nr, ng, nb, a
end

local function recolorImage(img)
  for y = 0, img.height - 1 do
    for x = 0, img.width - 1 do
      local p = img:getPixel(x, y)
      local a = pc.rgbaA(p)
      if a > 0 then
        local r, g, b = pc.rgbaR(p), pc.rgbaG(p), pc.rgbaB(p)
        r, g, b, a = coolSilver(r, g, b, a)
        img:putPixel(x, y, pc.rgba(r, g, b, a))
      end
    end
  end
end

if spr.colorMode == ColorMode.INDEXED and spr.palettes[1] then
  local pal = spr.palettes[1]
  for i = 0, pal.size - 1 do
    local c = pal:getColor(i)
    local r, g, b, a = coolSilver(c.red, c.green, c.blue, c.alpha)
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
