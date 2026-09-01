#!/usr/bin/env node
/**
 * Thin wrapper → AarcadeGh-t infra usage report (operator / Julius).
 *
 * Prefer:
 *   abra run aarcadeghst -- node ../AarcadeGh-t/scripts/infra-usage-report.mjs
 * Or from this repo (sibling checkout):
 *   ./scripts/gotchibot infra-usage
 *
 * Needs MONGODB_URI or MONGO_PROXY_URL (via abra project that holds Aarcade Mongo).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SIBLING = resolve(ROOT, "../AarcadeGh-t/scripts/infra-usage-report.mjs");
const ENV_PATH = process.env.AARCADE_REPO
  ? resolve(process.env.AARCADE_REPO, "scripts/infra-usage-report.mjs")
  : SIBLING;

const target = existsSync(ENV_PATH) ? ENV_PATH : null;
if (!target) {
  console.error("AarcadeGh-t scripts/infra-usage-report.mjs not found.");
  console.error("Clone AarcadeGh-t next to GotchiBot, or set AARCADE_REPO=/path/to/AarcadeGh-t");
  process.exit(1);
}

const args = process.argv.slice(2);
const hasMongo = Boolean(
  String(process.env.MONGODB_URI || process.env.MONGO_PROXY_URL || "").trim(),
);

function run(cmd, cmdArgs) {
  return spawnSync(cmd, cmdArgs, { stdio: "inherit", cwd: dirname(dirname(target)) });
}

let r;
if (hasMongo) {
  r = run(process.execPath, [target, ...args]);
} else {
  // Try aarcadeghst project first (Mongo), then gotchibot
  r = run("abra", ["run", "aarcadeghst", "--", "node", target, ...args]);
  if (r.error || r.status === 127) {
    r = run("abra", ["run", "gotchibot", "--", "node", target, ...args]);
  }
}

process.exit(r.status ?? 1);
