#!/usr/bin/env node
/**
 * Append one skill-request JSONL line for a worker session.
 *   node scripts/worker-skill-request.mjs --session <id> --skill <name> --reason "…"
 *   node scripts/worker-skill-request.mjs --session <id> --list
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.GOTCHIBOT_ROOT?.trim() || join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const val = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : "";
};
const session = val("--session") || val("-s");
const skill = val("--skill");
const reason = val("--reason") || "";
const list = args.includes("--list");

if (!session) {
  console.error("usage: worker-skill-request.mjs --session <id> --skill <name> --reason \"…\"\n       worker-skill-request.mjs --session <id> --list");
  process.exit(2);
}

const dir = join(ROOT, "sessions", session);
const file = join(dir, "skill-requests.jsonl");

if (list) {
  if (!existsSync(file)) {
    console.log("(no skill-requests.jsonl)");
    process.exit(0);
  }
  process.stdout.write(readFileSync(file, "utf8"));
  process.exit(0);
}

if (!skill || !reason) {
  console.error("need --skill and --reason");
  process.exit(2);
}
if (!existsSync(dir)) {
  console.error(`session dir missing: ${dir}`);
  process.exit(1);
}

const row = {
  skill: String(skill).trim(),
  reason: String(reason).trim(),
  requestedAt: new Date().toISOString(),
};
appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
console.log(`appended → ${file}`);
console.log(JSON.stringify(row));
