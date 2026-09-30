#!/usr/bin/env node
/**
 * Boot timing — where did startup time go?
 *
 * Shell marks come from scripts/boot-trace.sh (boot_mark); node marks from bootMark().
 * `gotchibot tmux` resets the trace, so `show` covers the latest launch.
 *
 *   node scripts/boot-trace.mjs show [--json]
 */
import { appendFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TRACE = join(ROOT, "sessions", ".boot-trace.log");

export function bootMark(label) {
  try {
    mkdirSync(dirname(TRACE), { recursive: true });
    appendFileSync(TRACE, `${Date.now()}\t${label}\n`);
  } catch {
    /* tracing never blocks boot */
  }
}

export function readTrace() {
  let text = "";
  try {
    text = readFileSync(TRACE, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(([ms, label]) => /^\d+$/.test(ms || "") && label)
    .map(([ms, label]) => ({ ms: Number(ms), label }));
}

function main() {
  const [cmd = "show", ...rest] = process.argv.slice(2);
  if (cmd !== "show") {
    console.error("usage: boot-trace show [--json]");
    process.exit(2);
  }
  const marks = readTrace();
  if (!marks.length) {
    console.log("no boot trace yet — launch with ./scripts/gotchibot tmux");
    return;
  }
  const t0 = marks[0].ms;
  const rows = marks.map((m, i) => ({
    label: m.label,
    at: (m.ms - t0) / 1000,
    step: i ? (m.ms - marks[i - 1].ms) / 1000 : 0,
  }));
  if (rest.includes("--json")) return console.log(JSON.stringify(rows, null, 2));
  console.log("   total    step  mark");
  for (const r of rows) {
    console.log(`${r.at.toFixed(1).padStart(7)}s ${`+${r.step.toFixed(1)}`.padStart(6)}s  ${r.label}`);
  }
}

if (isMainModule(import.meta.url)) main();
