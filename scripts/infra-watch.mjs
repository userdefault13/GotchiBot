#!/usr/bin/env node
/**
 * infra-watch.mjs — YFI's always-on watch over the iMac home stack.
 *
 * The 5-minute LaunchAgent (com.gotchibot.infra-monitor) fires and forgets: it
 * writes a markdown file and exits, so nobody notices when it reports DEGRADED
 * 501 times in a row for reasons that have nothing to do with the stack. This
 * watcher stays resident instead, and does three things the cron tick cannot:
 *
 *   1. Holds state between ticks, so it reports TRANSITIONS (up→down, down→up)
 *      rather than restating the same status forever.
 *   2. Writes a heartbeat, so "is the watcher itself alive?" is answerable.
 *   3. Periodically asks the Claude CLI, in a terminal, to look at the machine
 *      and independently say whether the stack is running — and flags it loudly
 *      when Claude disagrees with the probes. That disagreement check is the
 *      part that would have caught the false alarm on day one.
 *
 *   node scripts/infra-watch.mjs run    [--interval 60] [--verify-every 30]
 *   node scripts/infra-watch.mjs once   [--json] [--verify]
 *   node scripts/infra-watch.mjs status [--json]
 *   node scripts/infra-watch.mjs pane   [--interval 5]
 *
 * Env:
 *   INFRA_WATCH_INTERVAL      seconds between probe ticks (default 60)
 *   INFRA_WATCH_VERIFY_EVERY  run a Claude verification every N ticks (default 30)
 *   INFRA_WATCH_VERIFY_MIN_GAP
 *                             never run Claude more often than this many
 *                             seconds, even while flapping (default 300)
 *   INFRA_WATCH_DIR           state/event dir (default <repo>/var/infra-watch)
 */

import { writeFileSync, readFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { runChecks, summarize } from "./infra-monitor-cron.mjs";
import { verifyWithClaude } from "./infra-claude-verify.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WATCH_DIR = process.env.INFRA_WATCH_DIR || join(ROOT, "var/infra-watch");
const STATE_FILE = join(WATCH_DIR, "state.json");
const EVENTS_FILE = join(WATCH_DIR, "events.jsonl");

const argv = process.argv.slice(2);
const cmd = argv[0] || "status";
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const INTERVAL = Number(flag("interval", process.env.INFRA_WATCH_INTERVAL || 60));
const VERIFY_EVERY = Number(flag("verify-every", process.env.INFRA_WATCH_VERIFY_EVERY || 30));
const VERIFY_MIN_GAP = Number(process.env.INFRA_WATCH_VERIFY_MIN_GAP || 300);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureDir() {
  if (!existsSync(WATCH_DIR)) mkdirSync(WATCH_DIR, { recursive: true });
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeState(state) {
  ensureDir();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function logEvent(event) {
  ensureDir();
  appendFileSync(EVENTS_FILE, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, "utf8");
}

function failingChecks(result) {
  return ["docker", "subgraph", "tunnel"].filter((k) => !result[k].ok);
}

// One-line reason a check is failing, for the transition event and the pane.
function reasons(result) {
  const out = [];
  if (!result.docker.ok) {
    if (!result.docker.available) out.push(`docker: ${result.docker.error}`);
    else if (result.docker.missing?.length) out.push(`docker: missing ${result.docker.missing.join(", ")}`);
    else {
      const bad = result.docker.containers.filter((c) => c.watched && !c.healthy).map((c) => c.name);
      out.push(`docker: unhealthy ${bad.join(", ") || "(unknown)"}`);
    }
  }
  if (!result.subgraph.ok) out.push(`subgraph: ${result.subgraph.error || "failed"}`);
  if (!result.tunnel.ok) out.push(`tunnel: exit ${result.tunnel.exit}`);
  return out;
}

async function tick(prev, { forceVerify = false } = {}) {
  const result = runChecks();
  const now = new Date().toISOString();
  const overall = result.overall;
  const prevOverall = prev?.overall ?? null;
  const changed = prevOverall !== null && prevOverall !== overall;
  const tickNo = (prev?.tick ?? 0) + 1;

  // Decide whether to spend a Claude call this tick.
  const lastVerifyAt = prev?.claude?.at ? Date.parse(prev.claude.at) : 0;
  const gapOk = Date.now() - lastVerifyAt >= VERIFY_MIN_GAP * 1000;
  const dueByCount = VERIFY_EVERY > 0 && tickNo % VERIFY_EVERY === 0;
  const shouldVerify = forceVerify || ((changed || dueByCount || !prev?.claude) && gapOk);

  let claude = prev?.claude ?? null;
  let disagreement = false;

  if (shouldVerify) {
    const context = `overall=${overall ? "OK" : "DEGRADED"}; failing=[${failingChecks(result).join(", ") || "none"}]${reasons(result).length ? `; ${reasons(result).join("; ")}` : ""}`;
    const v = verifyWithClaude({ context });
    claude = {
      at: now,
      verdict: v.verdict,
      summary: v.summary || null,
      available: v.available !== false,
      error: v.error || null,
      costUsd: v.costUsd ?? null,
    };
    // The whole point: probes and a real agent looking at the same machine
    // should agree. When they do not, one of them is lying — say so.
    if (v.verdict) {
      const claudeSaysUp = v.verdict === "UP";
      disagreement = claudeSaysUp !== overall;
      claude.disagreesWithProbes = disagreement;
    }
    logEvent({
      kind: "claude-verify",
      verdict: v.verdict,
      summary: v.summary,
      probesOverall: overall ? "OK" : "DEGRADED",
      disagreement,
      error: v.error || null,
    });
  }

  const state = {
    updatedAt: now,
    startedAt: prev?.startedAt ?? now,
    pid: process.pid,
    tick: tickNo,
    interval: INTERVAL,
    overall,
    status: overall ? "OK" : "DEGRADED",
    failing: failingChecks(result),
    reasons: reasons(result),
    streak: changed || prevOverall === null ? 1 : (prev?.streak ?? 0) + 1,
    lastChange: changed ? now : (prev?.lastChange ?? now),
    checks: summarize(result).docker
      ? {
          docker: { ok: result.docker.ok, missing: result.docker.missing || [] },
          subgraph: { ok: result.subgraph.ok, block: result.subgraph.block, keyed: result.subgraph.keyed, error: result.subgraph.error || null },
          tunnel: { ok: result.tunnel.ok },
        }
      : null,
    claude,
    disagreement,
  };

  if (changed) {
    logEvent({
      kind: "transition",
      from: prevOverall ? "OK" : "DEGRADED",
      to: overall ? "OK" : "DEGRADED",
      failing: state.failing,
      reasons: state.reasons,
    });
  }

  writeState(state);
  return state;
}

function renderPane(state) {
  if (!state) return "infra-watch: no state yet — is the watcher running?\n";
  const age = Math.round((Date.now() - Date.parse(state.updatedAt)) / 1000);
  const stale = age > Math.max(state.interval * 3, 180);
  const lines = [];
  lines.push(`INFRA WATCH — ${state.status}${stale ? "  ⚠ STALE" : ""}`);
  lines.push(`tick ${state.tick} · ${age}s ago · pid ${state.pid}`);
  lines.push("");
  const c = state.checks || {};
  lines.push(`  docker    ${c.docker?.ok ? "✅" : "❌"}${c.docker?.missing?.length ? ` missing ${c.docker.missing.join(",")}` : ""}`);
  lines.push(`  subgraph  ${c.subgraph?.ok ? "✅" : "❌"}${c.subgraph?.block != null ? ` block ${c.subgraph.block}` : ""}${c.subgraph?.keyed ? "" : " (no key!)"}`);
  lines.push(`  tunnel    ${c.tunnel?.ok ? "✅" : "❌"}`);
  lines.push("");
  if (state.claude) {
    const cage = Math.round((Date.now() - Date.parse(state.claude.at)) / 1000);
    lines.push(`  claude    ${state.claude.verdict || "—"} (${cage}s ago)`);
    if (state.claude.summary) lines.push(`            ${state.claude.summary.slice(0, 60)}`);
    if (state.claude.error) lines.push(`            err: ${String(state.claude.error).slice(0, 60)}`);
  } else {
    lines.push("  claude    (not yet run)");
  }
  if (state.disagreement) {
    lines.push("");
    lines.push("  ⚠ CLAUDE DISAGREES WITH PROBES — trust neither until checked");
  }
  if (state.reasons?.length) {
    lines.push("");
    for (const r of state.reasons) lines.push(`  ! ${r}`);
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  if (cmd === "run") {
    ensureDir();
    logEvent({ kind: "watcher-start", pid: process.pid, interval: INTERVAL, verifyEvery: VERIFY_EVERY });
    console.error(`[infra-watch] started pid=${process.pid} interval=${INTERVAL}s verify-every=${VERIFY_EVERY} ticks`);
    let prev = readState();
    // A fresh process should not inherit a stale "already verified" clock.
    if (prev) prev = { ...prev, tick: prev.tick ?? 0 };
    for (;;) {
      try {
        const state = await tick(prev);
        prev = state;
        const line = `[infra-watch] ${state.status}${state.disagreement ? " (CLAUDE DISAGREES)" : ""} tick=${state.tick} failing=[${state.failing.join(",") || "none"}]`;
        console.error(line);
      } catch (err) {
        console.error(`[infra-watch] tick failed: ${err?.message || err}`);
        logEvent({ kind: "tick-error", error: String(err?.message || err) });
      }
      await sleep(INTERVAL * 1000);
    }
  }

  if (cmd === "once") {
    const state = await tick(readState(), { forceVerify: has("verify") });
    if (has("json")) console.log(JSON.stringify(state, null, 2));
    else process.stdout.write(renderPane(state));
    process.exit(state.overall ? 0 : 1);
  }

  if (cmd === "status") {
    const state = readState();
    if (has("json")) console.log(JSON.stringify(state, null, 2));
    else process.stdout.write(renderPane(state));
    process.exit(state?.overall ? 0 : 1);
  }

  if (cmd === "pane") {
    const every = Number(flag("interval", 5)) * 1000;
    for (;;) {
      const state = readState();
      spawnSync("clear", [], { stdio: "inherit" });
      process.stdout.write(renderPane(state));
      await sleep(every);
    }
  }

  console.error(`usage:
  infra-watch.mjs run    [--interval SEC] [--verify-every N]
  infra-watch.mjs once   [--json] [--verify]
  infra-watch.mjs status [--json]
  infra-watch.mjs pane   [--interval SEC]`);
  process.exit(2);
}

main();
