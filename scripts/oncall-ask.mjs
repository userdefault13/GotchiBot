#!/usr/bin/env node
/**
 * On-call advisor — a bounded question to GLM 5.3 (OpenCode Go), reply on stdout.
 *
 *   node scripts/oncall-ask.mjs [--reports-to <hero>] "question"
 *   node scripts/oncall-ask.mjs status [--json]
 *
 * Model: config/models.auto.json `advisor`, then `advisorFallback` on quota/limit
 * errors. Runs the read-only `ask` agent (no edits, no spawns). Needs
 * OPENCODE_API_KEY in env (desk started under abra). Never prints keys.
 * Ledger: sessions/.oncall-ledger.jsonl (read by the Factory Tree sidebar).
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isModelLimitError } from "./model-fallback.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER = join(ROOT, "sessions", ".oncall-ledger.jsonl");
const DEFAULT_ADVISOR = "opencode-go/glm-5.3";

export function advisorModels() {
  try {
    const cfg = JSON.parse(readFileSync(join(ROOT, "config", "models.auto.json"), "utf8"));
    const list = [cfg.advisor || DEFAULT_ADVISOR, ...(cfg.advisorFallback || [])];
    return [...new Set(list.map((m) => String(m).trim()).filter(Boolean))];
  } catch {
    return [DEFAULT_ADVISOR];
  }
}

function log(entry) {
  try {
    mkdirSync(dirname(LEDGER), { recursive: true });
    appendFileSync(LEDGER, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch {
    /* ledger is best-effort */
  }
}

function ask(model, prompt) {
  const r = spawnSync(
    "opencode",
    ["run", "-m", model, "--agent", "ask", "--title", "gotchibot:oncall", prompt],
    { cwd: ROOT, encoding: "utf8", env: process.env, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 },
  );
  const out = (r.stdout || "").trim();
  if (r.status === 0 && out) return { ok: true, text: out };
  return { ok: false, text: (r.stderr || out || `exit ${r.status}`).trim().slice(0, 400) };
}

function status(json) {
  let rows = [];
  try {
    rows = readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    /* no calls yet */
  }
  const day = Date.now() - 86_400_000;
  const out = {
    models: advisorModels(),
    goKey: Boolean(process.env.OPENCODE_API_KEY?.trim()),
    calls: rows.length,
    day: rows.filter((r) => Date.parse(r.at) > day).length,
    last: rows.at(-1) || null,
  };
  if (json) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`on call  ${out.models.join(" → ")}  (go key ${out.goKey ? "set" : "missing"})`);
    console.log(`calls    ${out.calls} · last 24h ${out.day}`);
    if (out.last) console.log(`last     ${out.last.at} ${out.last.ok ? "ok" : "fail"} · ${out.last.model}`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "status") return status(argv.includes("--json"));

  let reportsTo = process.env.GOTCHIBOT_HERO_ID || "orchestrator";
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--reports-to") reportsTo = argv[++i] || reportsTo;
    else rest.push(argv[i]);
  }
  const question = rest.join(" ").trim();
  if (!question) {
    console.error('usage: oncall-ask.mjs [--reports-to <hero>] "question" | status [--json]');
    process.exit(2);
  }
  if (!process.env.OPENCODE_API_KEY?.trim()) {
    console.error("oncall: OPENCODE_API_KEY not in env — start the desk under abra (abra run gotchibot -- …)");
    process.exit(1);
  }

  const prompt = [
    `You are the GotchiBot on-call advisor (reports_to=${reportsTo}).`,
    "Answer the bounded question below. Lead with the answer, keep it short, do not edit files or spawn agents.",
    "",
    question,
  ].join("\n");

  for (const model of advisorModels()) {
    const r = ask(model, prompt);
    log({ model, ok: r.ok, reportsTo, q: question.slice(0, 200), a: r.text.slice(0, 400) });
    if (r.ok) {
      console.log(r.text);
      return;
    }
    if (!isModelLimitError(r.text) && !/provider not found|model not found/i.test(r.text)) {
      console.error(`oncall (${model}) failed: ${r.text}`);
      process.exit(1);
    }
  }
  console.error("oncall: every advisor model is rate-limited or unavailable");
  process.exit(1);
}

if (process.argv[1]?.endsWith("oncall-ask.mjs")) main();
