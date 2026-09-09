#!/usr/bin/env node
/**
 * trader-schedule.mjs — make LINK's 30-minute cycle REAL on this host, and say
 * honestly whether it is.
 *
 *   ./scripts/gotchibot trader schedule status [--json]   is the cycle scheduled here? when did it last run?
 *   ./scripts/gotchibot trader schedule install            install + load the LaunchAgent (idempotent)
 *   ./scripts/gotchibot trader schedule uninstall          unload + remove it
 *   ./scripts/gotchibot trader schedule run-now            kick one cycle through launchd
 *
 * Until 2026-09-08 nothing scheduled the cycle anywhere: the plist sat in
 * config/launchagents/, cron402 had no job and no ingress, and LINK still said
 * "I wake every 30 minutes". Run this on the iMac: the desk API, the tmux
 * verify window and the desktop Terminal all live there.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { install, uninstall, loaded, kickstart, plistPath } from "./lib/launchd-job.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LABEL = "com.gotchibot.trader-cycle";
const INTERVAL_SEC = Number(process.env.TRADER_CYCLE_INTERVAL_SEC || 1800);
const LOG_DIR = process.env.TRADER_LOG_DIR || join(ROOT, "sessions/trader-logs");
const VERIFY_WS = process.env.TRADER_VERIFY_WORKSPACE || join(homedir(), "Dev/gotchibot-trader-verify");
const WEBHOOK_PORT = 8792;
const SPEC = { label: LABEL, args: [`${ROOT}/scripts/trader-cycle.mjs`, "--json"], cwd: ROOT, intervalSec: INTERVAL_SEC, logDir: LOG_DIR };

function lastCycle() {
  if (!existsSync(LOG_DIR)) return null;
  const files = readdirSync(LOG_DIR).filter((f) => /^cycle-.*\.md$/.test(f)).sort();
  if (!files.length) return null;
  const f = files[files.length - 1];
  const ageMin = Math.round((Date.now() - statSync(join(LOG_DIR, f)).mtimeMs) / 60000);
  const verdict = readFileSync(join(LOG_DIR, f), "utf8").match(/VERDICT\s*\[[^\]]*\]:\s*(PASS|CONCERN|FAIL)/)?.[1] ?? null;
  return { file: f, ageMin, verdict };
}

function webhookListening() {
  const r = spawnSync("lsof", ["-nP", `-iTCP:${WEBHOOK_PORT}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  return r.status === 0 && /LISTEN/.test(r.stdout);
}

function status() {
  const l = loaded(LABEL);
  const cyc = lastCycle();
  const st = {
    host: hostname(),
    plistInstalled: existsSync(plistPath(LABEL)),
    loaded: Boolean(l),
    launchd: l,
    intervalSec: INTERVAL_SEC,
    lastCycle: cyc,
    webhookListening: webhookListening(),
    verifyWorkspace: existsSync(VERIFY_WS),
    cron402: "not wired: no ingress route, no job (intended future waker)",
  };
  st.scheduled = st.plistInstalled && st.loaded;
  st.stale = Boolean(cyc) && cyc.ageMin > (INTERVAL_SEC / 60) * 2;
  return st;
}

function printStatus(st) {
  console.log(`${st.scheduled ? "ok   " : "MISSING"} cycle scheduled on ${st.host}: ${st.scheduled ? `every ${st.intervalSec}s via launchd (${LABEL})` : "NOT scheduled — run: ./scripts/gotchibot trader schedule install (on the iMac)"}`);
  console.log(`${st.plistInstalled ? "ok   " : "MISSING"} plist ${plistPath(LABEL)}`);
  console.log(`${st.loaded ? "ok   " : "MISSING"} launchd job loaded${st.launchd ? ` (runs=${st.launchd.runs ?? "?"}, last exit=${st.launchd.lastExit ?? "?"})` : ""}`);
  if (st.lastCycle) console.log(`${st.stale ? "STALE" : "ok   "} last cycle ${st.lastCycle.file} ${st.lastCycle.ageMin} min ago, verdict ${st.lastCycle.verdict || "?"}`);
  else console.log("MISSING no cycle has ever written a log here (sessions/trader-logs)");
  console.log(`${st.verifyWorkspace ? "ok   " : "MISSING"} verify workspace ${VERIFY_WS}`);
  console.log(`${st.webhookListening ? "ok   " : "off  "} trader webhook :${WEBHOOK_PORT} (only needed for cron402)`);
  console.log(`info  cron402: ${st.cron402}`);
}

const [cmd = "status", ...rest] = process.argv.slice(2);
try {
  if (cmd === "status") {
    const st = status();
    if (rest.includes("--json")) console.log(JSON.stringify(st, null, 2));
    else printStatus(st);
    process.exit(st.scheduled ? 0 : 1);
  } else if (cmd === "install") {
    const r = install(SPEC);
    console.log(`${r.changed ? "wrote" : "kept"} ${r.path} (node ${r.node})`);
    console.log(`loaded ${LABEL}: every ${INTERVAL_SEC}s, first run in ≤${INTERVAL_SEC}s (use run-now to start one immediately)`);
  } else if (cmd === "uninstall") {
    uninstall(LABEL);
    console.log(`removed ${LABEL}`);
  } else if (cmd === "run-now") {
    kickstart(LABEL);
    console.log(`kicked ${LABEL}; watch ${LOG_DIR}/${LABEL}.out.log`);
  } else {
    console.error("usage: trader-schedule.mjs status [--json] | install | uninstall | run-now");
    process.exit(2);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
