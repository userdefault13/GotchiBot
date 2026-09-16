#!/usr/bin/env node
/**
 * moltbook-schedule.mjs — local LaunchAgent fallback for the Moltbook watch.
 *
 * Primary waker is cron402 (ai-cron-site) → POST
 * https://aagent.userdefault.dev/cron/moltbook-watch every 15 minutes (UTC).
 * This LaunchAgent is the home-machine fallback when cron402 is exhausted/down.
 *
 *   ./scripts/gotchibot moltbook schedule status [--json]
 *   ./scripts/gotchibot moltbook schedule install
 *   ./scripts/gotchibot moltbook schedule uninstall
 *   ./scripts/gotchibot moltbook schedule run-now
 *
 * Key resolution (priority):
 *   1. --env-file <path>  passed at install time → written into ProgramArguments
 *   2. MOLTBOOK_ENV_FILE  env var at install time → defaults to ~/.config/moltbook/credentials.json
 *   3. MOLTBOOK_API_KEY   in the process env (launchd plist environment)
 *
 * The credentials file can be JSON {"api_key":"…"} or a line MOLTBOOK_API_KEY=….
 * The file path is safe to put in a plist; the key itself never appears.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { install, uninstall, loaded, kickstart, plistPath } from "./lib/launchd-job.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LABEL = "com.gotchibot.moltbook-watch";
const INTERVAL_SEC = 900; // 15 minutes
const LOG_DIR = join(ROOT, "sessions", "moltbook-logs");
const DEFAULT_ENV_FILE = join(homedir(), ".config", "moltbook", "credentials.json");

// Resolve --env-file at install time (safe: only the path goes into the plist).
const argv = process.argv.slice(2);
const envFileArg = (() => {
  const i = argv.indexOf("--env-file");
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
})();
const envFile = envFileArg || process.env.MOLTBOOK_ENV_FILE || DEFAULT_ENV_FILE;

// Build the args array: always pass --env-file so the watch script can find the key
// even when launchedd has no process.env.MOLTBOOK_API_KEY.
const watchArgs = [`${ROOT}/scripts/moltbook-watch.mjs`, "--json"];
if (envFile) watchArgs.push("--env-file", envFile);

const SPEC = {
  label: LABEL,
  args: watchArgs,
  cwd: ROOT,
  intervalSec: INTERVAL_SEC,
  logDir: LOG_DIR,
};

function lastCycle() {
  const outLog = join(LOG_DIR, `${LABEL}.out.log`);
  if (!existsSync(outLog)) return null;
  try {
    const raw = readFileSync(outLog, "utf8").trim();
    const lines = raw.split("\n").filter(Boolean);
    if (!lines.length) return null;
    // Find the last JSON line (the watch script outputs JSON per cycle).
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.type === "moltbook-watch") {
          const ageMin = Math.round((Date.now() - new Date(obj.at).getTime()) / 60000);
          return { at: obj.at, status: obj.status, ageMin, newReplies: obj.newReplies, newIssues: obj.newIssues, queued: obj.queued };
        }
      } catch { /* not JSON, keep looking */ }
    }
    return null;
  } catch {
    return null;
  }
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
    envFile,
    envFileExists: existsSync(envFile),
  };
  st.scheduled = st.plistInstalled && st.loaded;
  st.stale = Boolean(cyc) && cyc.ageMin > (INTERVAL_SEC / 60) * 2;
  return st;
}

function printStatus(st) {
  console.log(`${st.scheduled ? "ok   " : "MISSING"} watch scheduled on ${st.host}: ${st.scheduled ? `every ${st.intervalSec}s via launchd (${LABEL})` : "NOT scheduled — run: ./scripts/gotchibot moltbook schedule install"}`);
  console.log(`${st.plistInstalled ? "ok   " : "MISSING"} plist ${plistPath(LABEL)}`);
  console.log(`${st.loaded ? "ok   " : "MISSING"} launchd job loaded${st.launchd ? ` (runs=${st.launchd.runs ?? "?"}, last exit=${st.launchd.lastExit ?? "?"})` : ""}`);
  if (st.lastCycle) {
    const s = st.lastCycle;
    console.log(`${st.stale ? "STALE" : "ok   "} last cycle ${s.at} (${s.ageMin} min ago) — ${s.status}, ${s.newReplies ?? 0} replies, ${s.newIssues ?? 0} issues, ${s.queued ?? 0} queued`);
  } else {
    console.log("MISSING no cycle has ever run (sessions/moltbook-logs)");
  }
  console.log(`${st.envFileExists ? "ok   " : "WARN "} env-file ${st.envFile}${st.envFileExists ? "" : " (missing — create it with MOLTBOOK_API_KEY=… or {\"api_key\":\"…\"})"}`);
}

const [cmd = "status", ...rest] = argv;
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
    if (!existsSync(envFile)) {
      console.warn(`WARN  env-file not found: ${envFile}`);
      console.warn(`      create it with: echo "MOLTBOOK_API_KEY=your-key" > ${envFile}`);
    }
  } else if (cmd === "uninstall") {
    uninstall(LABEL);
    console.log(`removed ${LABEL}`);
  } else if (cmd === "run-now") {
    kickstart(LABEL);
    console.log(`kicked ${LABEL}; watch ${LOG_DIR}/${LABEL}.out.log`);
  } else {
    console.error("usage: moltbook-schedule.mjs status [--json] | install | uninstall | run-now");
    process.exit(2);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
