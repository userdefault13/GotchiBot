#!/usr/bin/env node
/**
 * infra-schedule.mjs — YFI's 15-minute wake, made real on this host.
 *
 *   ./scripts/gotchibot infra schedule status [--json]   is the supervisor loaded? is the watcher alive? what does it say?
 *   ./scripts/gotchibot infra schedule install            LaunchAgent com.gotchibot.infra-watch every 900s (idempotent), and start the watcher now
 *   ./scripts/gotchibot infra schedule uninstall          unload + remove it (the resident watcher keeps running until its window is closed)
 *   ./scripts/gotchibot infra schedule run-now            kick the supervisor once
 *
 * How YFI checks home infra: scripts/infra-watch.mjs runs RESIDENT in tmux
 * gotchibot:infrawatch (60s ticks, reports transitions, asks the Claude CLI for
 * a second opinion every 30 ticks and on every transition). The launchd job
 * installed here runs infra-watch-ensure.sh every 15 minutes: it restarts that
 * window if it died, and is otherwise a no-op. So "YFI wakes every 15 minutes"
 * is the supervisor; the watcher itself never sleeps. Run this on the iMac.
 */
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { install, uninstall, loaded, kickstart, plistPath } from "./lib/launchd-job.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LABEL = "com.gotchibot.infra-watch";
const LEGACY_LABEL = "com.gotchibot.infra-monitor"; // 5-minute fire-and-forget report; reported, not managed here
const INTERVAL_SEC = Number(process.env.INFRA_WATCH_SUPERVISE_SEC || 900);
const LOG_DIR = join(ROOT, "sessions/infra-logs");
const STATE = join(ROOT, "var/infra-watch/state.json");
const ENSURE = `${ROOT}/scripts/infra-watch-ensure.sh`;
const SPEC = {
  label: LABEL,
  program: "/bin/bash",
  args: [ENSURE],
  cwd: ROOT,
  intervalSec: INTERVAL_SEC,
  logDir: LOG_DIR,
  env: { GOTCHIBOT_ROOT: ROOT, NODE_BIN: process.execPath },
};

function watcher() {
  try {
    const s = JSON.parse(readFileSync(STATE, "utf8"));
    const ageSec = Math.round((Date.now() - Date.parse(s.updatedAt)) / 1000);
    return {
      status: s.status,
      tick: s.tick ?? null,
      failing: s.failing || [],
      disagreement: Boolean(s.disagreement),
      updatedAt: s.updatedAt,
      ageSec,
      stale: ageSec > Math.max((s.interval || 60) * 3, 180),
    };
  } catch {
    return null;
  }
}

function status() {
  const l = loaded(LABEL);
  const w = watcher();
  const st = {
    host: hostname(),
    plistInstalled: existsSync(plistPath(LABEL)),
    loaded: Boolean(l),
    launchd: l,
    intervalSec: INTERVAL_SEC,
    watcher: w,
    legacyMonitorLoaded: Boolean(loaded(LEGACY_LABEL)),
  };
  st.scheduled = st.plistInstalled && st.loaded;
  st.watcherAlive = Boolean(w) && !w.stale;
  return st;
}

function printStatus(st) {
  console.log(`${st.scheduled ? "ok   " : "MISSING"} YFI supervisor on ${st.host}: ${st.scheduled ? `every ${st.intervalSec}s via launchd (${LABEL})` : "NOT scheduled — run: ./scripts/gotchibot infra schedule install (on the iMac)"}`);
  console.log(`${st.loaded ? "ok   " : "MISSING"} launchd job loaded${st.launchd ? ` (runs=${st.launchd.runs ?? "?"}, last exit=${st.launchd.lastExit ?? "?"})` : ""}`);
  if (st.watcher) {
    const w = st.watcher;
    const flag = w.stale ? "STALE" : w.status === "OK" && !w.disagreement ? "ok   " : "ALERT";
    console.log(`${flag} watcher ${w.status} tick=${w.tick} failing=[${w.failing.join(",") || "none"}]${w.disagreement ? " CLAUDE DISAGREES WITH PROBES" : ""} heartbeat ${w.ageSec}s ago`);
  } else {
    console.log(`MISSING watcher has never written ${STATE} on this host (tmux gotchibot:infrawatch not running)`);
  }
  console.log(`info  ${LEGACY_LABEL} (5-min report): ${st.legacyMonitorLoaded ? "loaded" : "not loaded"}`);
}

const [cmd = "status", ...rest] = process.argv.slice(2);
try {
  if (cmd === "status") {
    const st = status();
    if (rest.includes("--json")) console.log(JSON.stringify(st, null, 2));
    else printStatus(st);
    process.exit(st.scheduled && st.watcherAlive ? 0 : 1);
  } else if (cmd === "install") {
    const r = install(SPEC);
    console.log(`${r.changed ? "wrote" : "kept"} ${r.path} (node ${r.node})`);
    console.log(`loaded ${LABEL}: every ${INTERVAL_SEC}s`);
    const e = spawnSync("/bin/bash", [ENSURE], { encoding: "utf8", env: { ...process.env, GOTCHIBOT_ROOT: ROOT, NODE_BIN: process.execPath } });
    process.stdout.write(e.stdout || "");
    if (e.status !== 0) console.error((e.stderr || "").trim() || "infra-watch-ensure failed");
  } else if (cmd === "uninstall") {
    uninstall(LABEL);
    console.log(`removed ${LABEL}`);
  } else if (cmd === "run-now") {
    kickstart(LABEL);
    console.log(`kicked ${LABEL}`);
  } else {
    console.error("usage: infra-schedule.mjs status [--json] | install | uninstall | run-now");
    process.exit(2);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
