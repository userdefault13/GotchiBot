#!/usr/bin/env node
/**
 * Classify a natural-language task into model tier (nim | pro | local).
 * Uses opencode one-shot when available; falls back to heuristics offline.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const HARD =
  /\b(architect|design|refactor|debug|root cause|security|performance|migrate|reasoning|trade-?off|gnarly)\b/i;
const LOCAL = /\b(private|offline|local only|on.?device|airgap)\b/i;

function heuristic(text) {
  if (LOCAL.test(text)) return "local";
  if (HARD.test(text) || text.length > 400) return "pro";
  return "nim";
}

function viaOpencode(text) {
  const system = `You route GotchiBot tasks. Reply with ONLY one word: nim, pro, or local.
nim = routine coding; pro = hard reasoning/architecture/bugs; local = private/offline.`;
  const r = spawnSync(
    "opencode",
    ["run", "-m", "opencode/nemotron-3.5-lightning-free", "--title", "gotchibot:route", `${system}\n\nTask: ${text}`],
    { cwd: ROOT, encoding: "utf8", timeout: 25_000 },
  );
  if (r.status !== 0) return null;
  const word = (r.stdout || "").trim().split(/\s+/).pop()?.toLowerCase();
  return ["nim", "pro", "local"].includes(word) ? word : null;
}

const text = process.argv.slice(2).join(" ").trim();
if (!text) process.exit(2);

let tier = process.env.GOTCHIBOT_ROUTE_OFFLINE === "1" ? null : viaOpencode(text);
if (!tier) tier = heuristic(text);
process.stdout.write(tier);
