-- Export every frame of an .aseprite to numbered SVG files.
-- Env: SVG_EXPORTER_ROOT, SVG_INPUT, SVG_OUTPUT (base path without frame suffix)

local ROOT = os.getenv("SVG_EXPORTER_ROOT") or ""
if ROOT == "" or not app.fs.isFile(ROOT .. "/svg-generator.lua") then
  error("SVG_EXPORTER_ROOT must point to Aseprite-SVGexporter")
end

local inputPath = os.getenv("SVG_INPUT") or (app.params and app.params.input)
local outputBase = os.getenv("SVG_OUTPUT") or (app.params and app.params.output)
local optimized = (os.getenv("SVG_OPTIMIZED") or "1") ~= "0"
local useCss = (os.getenv("SVG_CSS") or "1") ~= "0"

if not inputPath or not app.fs.isFile(inputPath) then
  error("SVG_INPUT missing or not found")
end
if not outputBase or outputBase == "" then
  outputBase = inputPath:gsub("%.aseprite$", "")
end

local svgGenerator = dofile(ROOT .. "/svg-generator.lua")
local sprite = app.open(inputPath)
if not sprite then error("Failed to open: " .. inputPath) end

app.activeSprite = sprite
local count = #sprite.frames
for frame = 1, count do
  local out = outputBase .. frame .. ".svg"
  local combined = svgGenerator.exportSpriteToSVG(sprite, frame, optimized, true, useCss, nil)
  local f = io.open(out, "w")
  if not f then error("Cannot write: " .. out) end
  f:write(combined)
  f:close()
  print("OK: " .. out)
end

pcall(function()
  app.activeSprite = sprite
  app.command.CloseFile()
end)

print("SVG_EXPORT_ALL_OK " .. count)
