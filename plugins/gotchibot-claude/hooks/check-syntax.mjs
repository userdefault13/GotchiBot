#!/usr/bin/env node
/**
 * PostToolUse(Write|Edit) — syntax gate for the files this repo actually ships.
 *
 *   .mjs / .js / .cjs  → node --check
 *   .sh / .bash        → bash -n
 *   .json              → JSON.parse   (skills/registry.json, config/*.json)
 *
 * A broken script here is invisible until someone runs it: main-module guards
 * and long-lived tmux panes swallow the error. Blocking on the failed check
 * hands the error straight back to Claude in the same turn.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { extname } from "node:path";

function block(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
}

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  process.exit(0);
}

const file = payload?.tool_response?.filePath || payload?.tool_input?.file_path || "";
if (!file) process.exit(0);

let ext = extname(file).toLowerCase();
if (!ext) {
  // Extensionless CLIs (scripts/gotchibot) — trust the shebang.
  try {
    const shebang = readFileSync(file, "utf8").split("\n", 1)[0];
    if (/^#!.*\b(bash|sh|zsh)\b/.test(shebang)) ext = ".sh";
    else if (/^#!.*\bnode\b/.test(shebang)) ext = ".mjs";
  } catch {
    /* unreadable — nothing to check */
  }
}

if (ext === ".mjs" || ext === ".js" || ext === ".cjs") {
  const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8", timeout: 15000 });
  if (r.status !== 0) {
    block(`node --check failed on ${file}:\n${(r.stderr || "").trim().slice(0, 1500)}\nFix the syntax before continuing.`);
  }
} else if (ext === ".sh" || ext === ".bash") {
  const r = spawnSync("bash", ["-n", file], { encoding: "utf8", timeout: 15000 });
  if (r.status !== 0) {
    block(`bash -n failed on ${file}:\n${(r.stderr || "").trim().slice(0, 1500)}\nFix the syntax before continuing.`);
  }
} else if (ext === ".json") {
  try {
    JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    block(
      `${file} is not valid JSON: ${e?.message || e}\n` +
        `A malformed settings/registry file fails silently — fix it before continuing.`,
    );
  }
}
process.exit(0);
