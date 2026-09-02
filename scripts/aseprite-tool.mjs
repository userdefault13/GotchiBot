#!/usr/bin/env node
/**
 * GotchiBot Aseprite CLI wrapper — batch export, init templates, Lua scripts.
 * JSON on stdout; errors on stderr. Paths confined to repo + config/aseprite.json roots.
 */
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CFG_PATH = `${ROOT}/config/aseprite.json`;
const CFG = JSON.parse(readFileSync(CFG_PATH, "utf8"));
const LUA = `${ROOT}/assets/aseprite/lua`;

function ok(type, data = {}) {
  console.log(JSON.stringify({ type, status: "ok", ...data }));
}

function fail(type, message, extra = {}) {
  console.error(message);
  console.log(JSON.stringify({ type, status: "error", message, ...extra }));
  process.exit(1);
}

function expandEnvDefault(raw) {
  const m = String(raw).match(/^\$\{([A-Z0-9_]+):-([^}]*)\}$/);
  if (!m) return raw;
  return process.env[m[1]] || m[2];
}

function expandPath(p) {
  const raw = expandEnvDefault(p);
  if (raw.startsWith("~/")) return resolve(process.env.HOME || "", raw.slice(2));
  if (isAbsolute(raw)) return resolve(raw);
  return resolve(ROOT, raw);
}

function asepriteBin() {
  const raw = expandEnvDefault(process.env.ASEPRITE_BIN || CFG.bin || "aseprite");
  return String(raw).trim() || "aseprite";
}

function extensionDir(key) {
  const ext = CFG.extensions?.[key];
  if (!ext) return null;
  return expandPath(ext);
}

function expandRoots(keys) {
  const roots = (CFG[keys] || []).map((r) => expandPath(r));
  roots.push(ROOT);
  return [...new Set(roots)];
}

function pathAllowed(target, write = false) {
  const abs = resolve(target);
  const roots = expandRoots(write ? "allowWriteRoots" : "allowReadRoots");
  for (const root of roots) {
    const rel = relative(root, abs);
    if (!rel.startsWith("..") && !isAbsolute(rel)) return abs;
  }
  return null;
}

function requireAsepriteExt(p) {
  if (extname(p).toLowerCase() !== ".aseprite") {
    fail("path", `Expected .aseprite file: ${p}`);
  }
}

function runAseprite(args, env = {}, cwd = ROOT) {
  const bin = asepriteBin();
  const r = spawnSync(bin, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { bin, ...r };
}

function parseArgs(argv = process.argv) {
  const out = { _: [], set: {} };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      out.help = true;
    } else if (a === "--sheet-type" && argv[i + 1]) {
      out.sheetType = argv[++i];
    } else if (a === "--out" && argv[i + 1]) {
      out.out = argv[++i];
    } else if (a === "--tile-w" && argv[i + 1]) {
      out.tileW = argv[++i];
    } else if (a === "--tile-h" && argv[i + 1]) {
      out.tileH = argv[++i];
    } else if (a === "--cols" && argv[i + 1]) {
      out.cols = argv[++i];
    } else if (a === "--rows" && argv[i + 1]) {
      out.rows = argv[++i];
    } else if (a === "--width" && argv[i + 1]) {
      out.width = argv[++i];
    } else if (a === "--height" && argv[i + 1]) {
      out.height = argv[++i];
    } else if (a === "--frame" && argv[i + 1]) {
      out.frame = argv[++i];
    } else if (a === "--format" && argv[i + 1]) {
      out.format = argv[++i];
    } else if (a === "--all-frames") {
      out.allFrames = true;
    } else if (a === "--optimized" && argv[i + 1]) {
      out.optimized = argv[++i];
    } else if (a === "--css" && argv[i + 1]) {
      out.css = argv[++i];
    } else if (a.startsWith("--set") && argv[i + 1]?.includes("=")) {
      const [k, ...rest] = argv[++i].split("=");
      out.set[k] = rest.join("=");
    } else if (!a.startsWith("-")) {
      out._.push(a);
    }
  }
  return out;
}

function cmdCheck() {
  const bin = asepriteBin();
  const which = spawnSync("bash", ["-c", `command -v ${JSON.stringify(bin)}`], { encoding: "utf8" });
  if (which.status !== 0) {
    fail("check", `Aseprite CLI not found (${bin}). Install Aseprite or set ASEPRITE_BIN.`);
  }
  const ver = spawnSync(bin, ["--version"], { encoding: "utf8" });
  const importer = extensionDir("svgImporter");
  const exporter = extensionDir("svgExporter");
  const extensions = {
    svgImporter: importer && existsSync(`${importer}/svg-importer-cli.lua`) ? importer : null,
    svgExporter: exporter && existsSync(`${exporter}/svg-generator.lua`) ? exporter : null,
  };
  ok("check", {
    bin: which.stdout.trim() || bin,
    version: (ver.stdout || ver.stderr || "").trim(),
    extensions,
  });
}

function cmdExport(args) {
  const src = args._[1];
  const outDir = args._[2] || CFG.defaultExportDir || "build/aseprite";
  const sheetType = args.sheetType || "rows";
  if (!src) fail("export", "Usage: export <source.aseprite> [out-dir] [--sheet-type rows|columns|...]");
  if (!(CFG.sheetTypes || []).includes(sheetType)) {
    fail("export", `Invalid --sheet-type ${sheetType}`);
  }

  const srcAbs = pathAllowed(src, false);
  if (!srcAbs || !existsSync(srcAbs)) fail("export", `Source not found or not allowed: ${src}`);
  requireAsepriteExt(srcAbs);

  const outAbs = pathAllowed(outDir, true);
  if (!outAbs) fail("export", `Output dir not allowed: ${outDir}`);
  mkdirSync(outAbs, { recursive: true });

  const name = basename(srcAbs, ".aseprite");
  const sheet = resolve(outAbs, `${name}.png`);
  const data = resolve(outAbs, `${name}.json`);

  const r = runAseprite([
    "-b",
    srcAbs,
    "--sheet",
    sheet,
    "--data",
    data,
    "--sheet-type",
    sheetType,
    "--format",
    "json-array",
    "--list-tags",
    "--list-layers",
  ]);

  if (r.status !== 0) {
    fail("export", (r.stderr || r.stdout || "aseprite export failed").trim(), { exitCode: r.status });
  }

  ok("export", {
    source: relative(ROOT, srcAbs),
    sheet: relative(ROOT, sheet),
    data: relative(ROOT, data),
    sheetType,
    log: (r.stdout || "").trim() || undefined,
  });
}

function cmdInitTileset(args) {
  const out = args.out || args._[1];
  if (!out) fail("init-tileset", "Usage: init-tileset --out <path.aseprite> [--tile-w N] [--tile-h N] [--cols N] [--rows N]");
  const outAbs = pathAllowed(out, true);
  if (!outAbs) fail("init-tileset", `Output path not allowed: ${out}`);
  if (extname(outAbs).toLowerCase() !== ".aseprite") fail("init-tileset", "Output must end with .aseprite");
  mkdirSync(dirname(outAbs), { recursive: true });

  const script = resolve(LUA, "init_tileset.lua");
  const r = runAseprite(["-b", "--script", script], {
    TILE_W: String(args.tileW || "16"),
    TILE_H: String(args.tileH || "16"),
    COLS: String(args.cols || "8"),
    ROWS: String(args.rows || "8"),
    OUT: outAbs,
  });
  if (r.status !== 0) fail("init-tileset", (r.stderr || r.stdout || "init failed").trim());
  ok("init-tileset", {
    file: relative(ROOT, outAbs),
    tileW: Number(args.tileW || 16),
    tileH: Number(args.tileH || 16),
    cols: Number(args.cols || 8),
    rows: Number(args.rows || 8),
  });
}

function cmdInitSprite(args) {
  const out = args.out || args._[1];
  if (!out) fail("init-sprite", "Usage: init-sprite --out <path.aseprite> [--width N] [--height N]");
  const outAbs = pathAllowed(out, true);
  if (!outAbs) fail("init-sprite", `Output path not allowed: ${out}`);
  if (extname(outAbs).toLowerCase() !== ".aseprite") fail("init-sprite", "Output must end with .aseprite");
  mkdirSync(dirname(outAbs), { recursive: true });

  const script = resolve(LUA, "init_sprite.lua");
  const r = runAseprite(["-b", "--script", script], {
    WIDTH: String(args.width || "32"),
    HEIGHT: String(args.height || "32"),
    OUT: outAbs,
  });
  if (r.status !== 0) fail("init-sprite", (r.stderr || r.stdout || "init failed").trim());
  ok("init-sprite", {
    file: relative(ROOT, outAbs),
    width: Number(args.width || 32),
    height: Number(args.height || 32),
  });
}

function cmdScript(args) {
  const scriptPath = args._[1];
  if (!scriptPath) fail("script", "Usage: script <file.lua> [--set KEY=val ...]");
  const scriptAbs = pathAllowed(scriptPath, false);
  if (!scriptAbs || !existsSync(scriptAbs)) fail("script", `Script not found or not allowed: ${scriptPath}`);

  const extra = [];
  for (const [k, v] of Object.entries(args.set)) extra.push(`${k}=${v}`);
  const r = runAseprite(["-b", "--script", scriptAbs], Object.fromEntries(Object.entries(args.set)));
  if (r.status !== 0) fail("script", (r.stderr || r.stdout || "script failed").trim());
  ok("script", {
    script: relative(ROOT, scriptAbs),
    log: (r.stdout || "").trim() || undefined,
    env: args.set,
  });
}

function requireExtension(key, marker) {
  const dir = extensionDir(key);
  if (!dir || !existsSync(`${dir}/${marker}`)) {
    const envKey = key === "svgImporter" ? "GOTCHIBOT_SVG_IMPORTER" : "GOTCHIBOT_SVG_EXPORTER";
    fail(key, `Extension not found (${dir || "unset"}). Set ${envKey} or config/aseprite.json extensions.${key}`);
  }
  return dir;
}

function cmdSvgImport(args) {
  const src = args._[1];
  if (!src) fail("svg-import", "Usage: svg-import <file.svg> [--out file.aseprite] [--width N] [--height N]");
  const srcAbs = pathAllowed(src, false);
  if (!srcAbs || !existsSync(srcAbs)) fail("svg-import", `Source not found or not allowed: ${src}`);
  if (extname(srcAbs).toLowerCase() !== ".svg") fail("svg-import", `Expected .svg file: ${src}`);

  const outRaw = args.out || srcAbs.replace(/\.svg$/i, ".aseprite");
  const outAbs = pathAllowed(outRaw, true);
  if (!outAbs) fail("svg-import", `Output path not allowed: ${outRaw}`);
  mkdirSync(dirname(outAbs), { recursive: true });

  const importerDir = requireExtension("svgImporter", "svg-importer-cli.lua");
  const script = resolve(importerDir, "svg-importer-cli.lua");
  const env = {
    SVG_FILE: srcAbs,
    SVG_OUTPUT: outAbs,
  };
  if (args.width) env.SVG_WIDTH = String(args.width);
  if (args.height) env.SVG_HEIGHT = String(args.height);

  const r = runAseprite(["-b", "--script", script], env, importerDir);
  if (r.status !== 0 || !existsSync(outAbs)) {
    fail("svg-import", (r.stderr || r.stdout || "svg import failed").trim(), { exitCode: r.status });
  }
  ok("svg-import", {
    source: relative(ROOT, srcAbs),
    file: relative(ROOT, outAbs),
    width: args.width ? Number(args.width) : undefined,
    height: args.height ? Number(args.height) : undefined,
    log: (r.stdout || "").trim() || undefined,
  });
}

function cmdSvgExport(args) {
  const src = args._[1];
  if (!src) {
    fail(
      "svg-export",
      "Usage: svg-export <file.aseprite> [--out file.svg] [--frame N] [--all-frames] [--format svg|json] [--optimized 0|1] [--css 0|1]",
    );
  }
  const srcAbs = pathAllowed(src, false);
  if (!srcAbs || !existsSync(srcAbs)) fail("svg-export", `Source not found or not allowed: ${src}`);
  requireAsepriteExt(srcAbs);

  const exporterDir = requireExtension("svgExporter", "svg-generator.lua");
  const optimized = args.optimized !== undefined ? String(args.optimized) : "1";
  const css = args.css !== undefined ? String(args.css) : "1";
  const format = String(args.format || "svg").toLowerCase();

  if (args.allFrames) {
    const baseRaw = args.out || srcAbs.replace(/\.aseprite$/i, "");
    const baseAbs = pathAllowed(`${baseRaw}1.svg`, true);
    if (!baseAbs) fail("svg-export", `Output base path not allowed: ${baseRaw}`);
    const outputBase = baseAbs.replace(/\d+\.svg$/i, "");
    mkdirSync(dirname(outputBase), { recursive: true });

    const script = resolve(LUA, "svg-export-all-cli.lua");
    const r = runAseprite(["-b", "--script", script], {
      SVG_EXPORTER_ROOT: exporterDir,
      SVG_INPUT: srcAbs,
      SVG_OUTPUT: outputBase,
      SVG_OPTIMIZED: optimized,
      SVG_CSS: css,
    });
    if (r.status !== 0) fail("svg-export", (r.stderr || r.stdout || "svg export failed").trim());
    const files = (r.stdout || "")
      .split("\n")
      .filter((line) => line.startsWith("OK: "))
      .map((line) => line.slice(4).trim());
    ok("svg-export", {
      source: relative(ROOT, srcAbs),
      allFrames: true,
      files: files.map((f) => relative(ROOT, f)),
      log: (r.stdout || "").trim() || undefined,
    });
    return;
  }

  const outRaw =
    args.out ||
    (format === "json"
      ? srcAbs.replace(/\.aseprite$/i, ".svg.json")
      : srcAbs.replace(/\.aseprite$/i, ".svg"));
  const outAbs = pathAllowed(outRaw, true);
  if (!outAbs) fail("svg-export", `Output path not allowed: ${outRaw}`);
  mkdirSync(dirname(outAbs), { recursive: true });

  const script = resolve(LUA, "svg-export-cli.lua");
  const r = runAseprite(
    [
      "-b",
      "--script-param",
      `input=${srcAbs}`,
      "--script-param",
      `output=${outAbs}`,
      "--script-param",
      `frame=${args.frame || "1"}`,
      "--script-param",
      `optimized=${optimized}`,
      "--script-param",
      `css=${css}`,
      "--script-param",
      `format=${format}`,
      "--script",
      script,
    ],
    { SVG_EXPORTER_ROOT: exporterDir },
  );
  if (r.status !== 0 || !existsSync(outAbs)) {
    fail("svg-export", (r.stderr || r.stdout || "svg export failed").trim(), { exitCode: r.status });
  }
  ok("svg-export", {
    source: relative(ROOT, srcAbs),
    file: relative(ROOT, outAbs),
    frame: Number(args.frame || 1),
    format,
    log: (r.stdout || "").trim() || undefined,
  });
}

function cmdInfo(args) {
  const src = args._[1];
  if (!src) fail("info", "Usage: info <file.aseprite>");
  const srcAbs = pathAllowed(src, false);
  if (!srcAbs || !existsSync(srcAbs)) fail("info", `Source not found or not allowed: ${src}`);
  requireAsepriteExt(srcAbs);

  const r = runAseprite(["-b", srcAbs, "--list-layers", "--list-tags"]);
  if (r.status !== 0) fail("info", (r.stderr || r.stdout || "info failed").trim());
  ok("info", {
    source: relative(ROOT, srcAbs),
    log: (r.stdout || "").trim(),
  });
}

function showHelp() {
  console.log(`GotchiBot Aseprite CLI (aseprite-tool.mjs)

Subcommands:
  check                              Verify aseprite in PATH
  export <src.aseprite> [out-dir]    Export PNG + json-array metadata
  init-tileset --out <file>          Blank tileset via bundled Lua
  init-sprite --out <file>           Blank sprite via bundled Lua
  script <file.lua> [--set K=V]      Run Lua in batch mode (-b)
  info <file.aseprite>               List layers and tags
  svg-import <file.svg>              Import SVG → .aseprite (aesprite-svgimporter)
  svg-export <file.aseprite>           Export .aseprite → .svg or .svg.json (Aseprite-SVGexporter)

Flags:
  --sheet-type rows|columns|horizontal|vertical|packed   (export, default rows)
  --tile-w --tile-h --cols --rows                        (init-tileset)
  --width --height                                       (init-sprite / svg-import)
  --out <path>                                           (output path)
  --frame N --all-frames --format svg|json               (svg-export)
  --optimized 0|1 --css 0|1                                (svg-export, default 1)

Env:
  ASEPRITE_BIN              Path to aseprite binary (default: aseprite)
  GOTCHIBOT_SVG_IMPORTER    Path to aesprite-svgimporter checkout
  GOTCHIBOT_SVG_EXPORTER    Path to Aseprite-SVGexporter checkout

Examples:
  ./scripts/gotchibot aseprite check
  ./scripts/gotchibot aseprite init-tileset --out build/forest.aseprite --tile-w 32 --cols 8 --rows 8
  ./scripts/gotchibot aseprite export build/forest.aseprite build/sprites
  ./scripts/gotchibot aseprite svg-import logo.svg --out build/logo.aseprite --width 64 --height 64
  ./scripts/gotchibot aseprite svg-export build/logo.aseprite --out build/logo.svg
  ./scripts/gotchibot aseprite svg-export sprite.aseprite --all-frames --out build/sprite
`);
}

function main() {
  const args = parseArgs();
  const sub = args._[0];
  if (args.help || !sub || sub === "--help") {
    showHelp();
    process.exit(0);
  }
  switch (sub) {
    case "check":
      return cmdCheck();
    case "export":
      return cmdExport(args);
    case "init-tileset":
      return cmdInitTileset(args);
    case "init-sprite":
      return cmdInitSprite(args);
    case "script":
      return cmdScript(args);
    case "info":
      return cmdInfo(args);
    case "svg-import":
      return cmdSvgImport(args);
    case "svg-export":
      return cmdSvgExport(args);
    default:
      fail("unknown", `Unknown subcommand: ${sub}. Use --help.`);
  }
}

main();
