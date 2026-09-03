#!/usr/bin/env node
/**
 * Ensure Hub GotchiBot workspace has Claude pane proxy identity files + init prompt.
 *
 *   node scripts/claude-pane-init.mjs [--json] [--check] [--prompt-only] [--reports-to <heroId>]
 *   abra run gotchibot -- ./scripts/gotchibot claude-pane-init
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TPL = join(ROOT, "config/claude-pane-proxy");
const TPL_CLAUDE = join(TPL, "CLAUDE.md");
const TPL_AGENT = join(TPL, "agents/gotchibot-proxy.md");

function buildInitPrompt(hero, jobId) {
  const job = jobId ? ` | job=${jobId}` : "";
  return `[GotchiBot Hub proxy init]
You are the VS Code Claude proxy for this GotchiBot session (not the orchestrator).
Report to: ${hero}${job}
Load project CLAUDE.md. Prefer @gotchibot-proxy for hard-logic sub-tasks when available.
Reply for Desk collect; do not become orch or invent architecture.
---
`;
}

export function resolveReportsTo(explicit = "") {
  return (
    String(explicit || "").trim() ||
    process.env.GOTCHIBOT_HERO_ID?.trim() ||
    process.env.GOTCHIBOT_ORCH_ID?.trim() ||
    process.env.GOTCHIBOT_OPENCLAW_ORCH_ID?.trim() ||
    "owned-954"
  );
}

/** Prefix every bridge prompt with proxy identity (reports_to + optional job). */
export function prefixProxyPrompt(userPrompt, { reportsTo, jobId, includeInit = false } = {}) {
  const hero = resolveReportsTo(reportsTo);
  const job = jobId || process.env.GOTCHIBOT_CLAUDE_JOB_ID?.trim() || "";
  const header = `[GotchiBot Hub proxy | reports_to=${hero}${job ? ` | job=${job}` : ""}]\n`;
  const init = includeInit ? buildInitPrompt(hero, job) : "";
  return `${init}${header}${String(userPrompt || "").trim()}`;
}

function resolveRootWith(rootOverride) {
  if (rootOverride && existsSync(rootOverride)) return rootOverride;
  if (process.env.GOTCHIBOT_ROOT && existsSync(process.env.GOTCHIBOT_ROOT)) {
    return process.env.GOTCHIBOT_ROOT;
  }
  if (existsSync(join(ROOT, "scripts/gotchibot"))) return ROOT;
  const home = process.env.HOME || "";
  for (const c of [join(home, "Dev/GotchiBot"), join(home, "dev/GotchiBot")]) {
    if (existsSync(join(c, "scripts/gotchibot"))) return c;
  }
  return ROOT;
}

function sha(s) {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

function ensureFile(src, dest) {
  if (!existsSync(src)) throw new Error(`missing template: ${src}`);
  const body = readFileSync(src, "utf8");
  mkdirSync(dirname(dest), { recursive: true });
  let wrote = false;
  let same = false;
  if (existsSync(dest)) {
    const cur = readFileSync(dest, "utf8");
    same = sha(cur) === sha(body);
    if (!same) {
      writeFileSync(dest, body);
      wrote = true;
    }
  } else {
    copyFileSync(src, dest);
    wrote = true;
  }
  return { path: dest, wrote, same: same && !wrote, hash: sha(body) };
}

export function runPaneInit({ root, checkOnly = false, reportsTo } = {}) {
  const r = resolveRootWith(root);
  const hero = resolveReportsTo(reportsTo);
  const destClaude = join(r, "CLAUDE.md");
  const destAgent = join(r, ".claude/agents/gotchibot-proxy.md");
  if (checkOnly) {
    return {
      ok: existsSync(destClaude) && existsSync(destAgent),
      root: r,
      reportsTo: hero,
      files: {
        claude: { path: destClaude, present: existsSync(destClaude) },
        agent: { path: destAgent, present: existsSync(destAgent) },
      },
      initPrompt: buildInitPrompt(hero, process.env.GOTCHIBOT_CLAUDE_JOB_ID?.trim() || ""),
    };
  }
  if (!existsSync(TPL_CLAUDE) || !existsSync(TPL_AGENT)) {
    throw new Error("claude-pane-init: templates missing under config/claude-pane-proxy/");
  }
  const fClaude = ensureFile(TPL_CLAUDE, destClaude);
  const fAgent = ensureFile(TPL_AGENT, destAgent);
  return {
    ok: true,
    root: r,
    reportsTo: hero,
    files: { claude: fClaude, agent: fAgent },
    initPrompt: buildInitPrompt(hero, process.env.GOTCHIBOT_CLAUDE_JOB_ID?.trim() || ""),
  };
}

function usage() {
  console.error(`usage: claude-pane-init.mjs [--json] [--check] [--prompt-only] [--reports-to <heroId>] [--root <path>]
  Copies proxy CLAUDE.md + .claude/agents/gotchibot-proxy.md into the GotchiBot workspace.
  Prefer: abra run gotchibot -- ./scripts/gotchibot claude-pane-init`);
  process.exit(2);
}

function main() {
  const args = process.argv.slice(2);
  let jsonOut = false;
  let checkOnly = false;
  let promptOnly = false;
  let reportsTo = "";
  let rootOverride = "";

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") jsonOut = true;
    else if (a === "--check") checkOnly = true;
    else if (a === "--prompt-only") promptOnly = true;
    else if (a === "--reports-to") reportsTo = args[++i] || "";
    else if (a === "--root") rootOverride = args[++i] || "";
    else if (a === "-h" || a === "--help") usage();
    else {
      console.error(`unknown arg: ${a}`);
      usage();
    }
  }

  const hero = resolveReportsTo(reportsTo);
  const jobId = process.env.GOTCHIBOT_CLAUDE_JOB_ID?.trim() || "";
  const initPrompt = buildInitPrompt(hero, jobId);

  if (promptOnly) {
    if (jsonOut) {
      console.log(JSON.stringify({ ok: true, reportsTo: hero, initPrompt }, null, 2));
    } else {
      process.stdout.write(initPrompt);
    }
    return;
  }

  try {
    const out = runPaneInit({ root: rootOverride || undefined, checkOnly, reportsTo });
    console.log(JSON.stringify(out, null, jsonOut ? 0 : 2));
    if (checkOnly && !out.ok) process.exit(1);
  } catch (e) {
    console.error(e?.message || e);
    process.exit(1);
  }
}

const isMain =
  Boolean(process.argv[1]) && /claude-pane-init\.mjs$/.test(process.argv[1] || "");
if (isMain) main();
