#!/usr/bin/env node
/**
 * GotchiBot PyMuPDF wrapper — runs scripts/pdf_tool.py via project .venv-pdf.
 *
 *   node scripts/pdf-tool.mjs check|info|search|read-pages|tables|chunks|render …
 *   ./scripts/gotchibot pdf check
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PY_SCRIPT = join(ROOT, "scripts/pdf_tool.py");
const CFG = join(ROOT, "config/pymupdf.json");

function loadCfg() {
  try {
    return JSON.parse(readFileSync(CFG, "utf8"));
  } catch {
    return { venv: ".venv-pdf" };
  }
}

function resolvePython() {
  const cfg = loadCfg();
  const envPy = process.env.GOTCHIBOT_PDF_PYTHON?.trim();
  if (envPy && existsSync(envPy)) return envPy;
  if (cfg.python && !String(cfg.python).includes("${")) {
    const p = String(cfg.python).replace(/^~/, homedir());
    if (existsSync(p)) return p;
  }
  const venv = join(ROOT, cfg.venv || ".venv-pdf");
  for (const rel of ["bin/python3", "bin/python", "Scripts/python.exe"]) {
    const c = join(venv, rel);
    if (existsSync(c)) return c;
  }
  return process.env.PYTHON || "python3";
}

function usage() {
  console.error(`usage (pages are 1-indexed):
  pdf-tool.mjs check
  pdf-tool.mjs info <file.pdf>
  pdf-tool.mjs search <file.pdf> <query> [--max-hits N]
  pdf-tool.mjs read-pages <file.pdf> --pages 3-7 [--format markdown|text] [--max-tokens N]
  pdf-tool.mjs tables <file.pdf> --page 4
  pdf-tool.mjs chunks <file.pdf> [--pages 1-10]
  pdf-tool.mjs render <file.pdf> --out <out.png> [--page 1] [--dpi 144]

Prefer: ./scripts/gotchibot pdf <cmd> …
Setup:  python3 -m venv .venv-pdf && .venv-pdf/bin/pip install -r requirements/pymupdf.txt`);
  process.exit(2);
}

const args = process.argv.slice(2);
if (!args.length || args[0] === "-h" || args[0] === "--help") usage();

const py = resolvePython();
const r = spawnSync(py, [PY_SCRIPT, ...args], {
  cwd: ROOT,
  encoding: "utf8",
  env: process.env,
  maxBuffer: 20 * 1024 * 1024,
});

if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
if (r.error) {
  console.error(r.error.message);
  process.exit(1);
}
process.exit(r.status ?? 1);
