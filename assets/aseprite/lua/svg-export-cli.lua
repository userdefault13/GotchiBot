-- GotchiBot wrapper for Aseprite-SVGexporter (headless).
-- Env: SVG_EXPORTER_ROOT=/path/to/Aseprite-SVGexporter
-- Params: input, output, frame, optimized, css, format (svg|json)

local ROOT = os.getenv("SVG_EXPORTER_ROOT") or ""
if ROOT == "" or not app.fs.isFile(ROOT .. "/svg-generator.lua") then
  error("SVG_EXPORTER_ROOT must point to Aseprite-SVGexporter (svg-generator.lua missing)")
end

local function param(name, default)
  if app.params and app.params[name] ~= nil and app.params[name] ~= "" then
    return app.params[name]
  end
  local env = os.getenv("SVG_" .. string.upper(name))
  if env and env ~= "" then return env end
  return default
end

local function jsonEscape(s)
  s = tostring(s or "")
  s = s:gsub("\\", "\\\\")
  s = s:gsub('"', '\\"')
  s = s:gsub("\n", "\\n")
  s = s:gsub("\r", "\\r")
  s = s:gsub("\t", "\\t")
  return s
end

local svgGenerator = dofile(ROOT .. "/svg-generator.lua")

local inputPath = param("input")
local outputPath = param("output")
local optimized = param("optimized", "1") ~= "0"
local useCss = param("css", "1") ~= "0"
local format = string.lower(param("format", "svg"))
local frameIndex = tonumber(param("frame", "1")) or 1

if not inputPath or inputPath == "" then
  error("Missing input= path to .aseprite")
end
if not app.fs.isFile(inputPath) then
  error("Input not found: " .. inputPath)
end

if not outputPath or outputPath == "" then
  if format == "json" then
    outputPath = inputPath:gsub("%.aseprite$", "") .. ".svg.json"
  else
    outputPath = inputPath:gsub("%.aseprite$", "") .. ".svg"
  end
end

local sprite = app.open(inputPath)
if not sprite then error("Failed to open: " .. inputPath) end

app.activeSprite = sprite
if frameIndex < 1 then frameIndex = 1 end
if frameIndex > #sprite.frames then frameIndex = 1 end

local function writeSvg(path, frame)
  local combined = svgGenerator.exportSpriteToSVG(sprite, frame, optimized, true, useCss, nil)
  if not combined then error("SVG export returned empty for frame " .. frame) end
  local f = io.open(path, "w")
  if not f then error("Cannot write: " .. path) end
  f:write(combined)
  f:close()
  print("OK: " .. path)
end

local function writeJson(path, frame)
  local layers = svgGenerator.getLayersAsSVGArray(sprite, frame, optimized, useCss, nil)
  local combined = svgGenerator.exportSpriteToSVG(sprite, frame, optimized, true, useCss, nil)
  local parts = {}
  table.insert(parts, "{")
  table.insert(parts, string.format('  "source": "%s",', jsonEscape(inputPath)))
  table.insert(parts, string.format('  "width": %d,', sprite.width))
  table.insert(parts, string.format('  "height": %d,', sprite.height))
  table.insert(parts, string.format('  "frame": %d,', frame))
  table.insert(parts, string.format('  "svg": %s,', combined and ('"' .. jsonEscape(combined) .. '"') or "null"))
  table.insert(parts, '  "layers": [')
  for i, layer in ipairs(layers) do
    local comma = (i < #layers) and "," or ""
    table.insert(parts, string.format(
      '    {"name": "%s", "svg": "%s"}%s',
      jsonEscape(layer.name),
      jsonEscape(layer.svg),
      comma
    ))
  end
  table.insert(parts, "  ]")
  table.insert(parts, "}")
  local f = io.open(path, "w")
  if not f then error("Cannot write: " .. path) end
  f:write(table.concat(parts, "\n"))
  f:close()
  print("OK: " .. path)
end

if format == "json" then
  writeJson(outputPath, frameIndex)
else
  writeSvg(outputPath, frameIndex)
end

pcall(function()
  app.activeSprite = sprite
  app.command.CloseFile()
end)

print("SVG_EXPORT_OK")
