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
 * "I wake every 30 minutes". The plist is rendered at install time with THIS
 * host's node path (the committed one hard-codes /usr/local/bin/node, which is
 * not where node lives on every desk). Run it on the iMac: the desk API, the
 * tmux verify window and the desktop Terminal all live there.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LABEL = "com.gotchibot.trader-cycle";
const INTERVAL_SEC = Number(process.env.TRADER_CYCLE_INTERVAL_SEC || 1800);
const AGENTS_DIR = join(homedir(), "Library", "LaunchAgents");
const PLIST = join(AGENTS_DIR, `${LABEL}.plist`);
const LOG_DIR = process.env.TRADER_LOG_DIR || join(ROOT, "sessions/trader-logs");
const VERIFY_WS = process.env.TRADER_VERIFY_WORKSPACE || join(homedir(), "Dev/gotchibot-trader-verify");
const WEBHOOK_PORT = 8792;

const sh = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" });
const uid = () => userInfo().uid;

function renderPlist() {
  const node = process.execPath;
  const path = `${dirname(node)}:/usr/local/bin:/opt/homebrew/bin:${homedir()}/.local/bin:/usr/bin:/bin`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${ROOT}/scripts/trader-cycle.mjs</string>
    <string>--json</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>StartInterval</key><integer>${INTERVAL_SEC}</integer>
  <key>RunAtLoad</key><false/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>${LOG_DIR}/cycle.out.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/cycle.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${path}</string>
    <key>HOME</key><string>${homedir()}</string>
  </dict>
</dict>
</plist>
`;
}

function loaded() {
  const r = sh("launchctl", ["print", `gui/${uid()}/${LABEL}`]);
  if (r.status !== 0) return null;
  const last = r.stdout.match(/last exit code = (\S+)/)?.[1] ?? null;
  const runs = r.stdout.match(/runs = (\d+)/)?.[1] ?? null;
  return { lastExit: last, runs: runs === null ? null : Number(runs) };
}

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
  const r = sh("lsof", ["-nP", `-iTCP:${WEBHOOK_PORT}`, "-sTCP:LISTEN"]);
  return r.status === 0 && /LISTEN/.test(r.stdout);
}

function status() {
  const l = loaded();
  const cyc = lastCycle();
  const st = {
    host: hostname(),
    plistInstalled: existsSync(PLIST),
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
  const tick = (b) => (b ? "ok   " : "MISSING");
  console.log(`${tick(st.scheduled)} cycle scheduled on ${st.host}: ${st.scheduled ? `every ${st.intervalSec}s via launchd (${LABEL})` : "NOT scheduled — run: ./scripts/gotchibot trader schedule install (on the iMac)"}`);
  console.log(`${st.plistInstalled ? "ok   " : "MISSING"} plist ${PLIST}`);
  console.log(`${st.loaded ? "ok   " : "MISSING"} launchd job loaded${st.launchd ? ` (runs=${st.launchd.runs ?? "?"}, last exit=${st.launchd.lastExit ?? "?"})` : ""}`);
  if (st.lastCycle) {
    console.log(`${st.stale ? "STALE" : "ok   "} last cycle ${st.lastCycle.file} ${st.lastCycle.ageMin} min ago, verdict ${st.lastCycle.verdict || "?"}`);
  } else {
    console.log("MISSING no cycle has ever written a log here (sessions/trader-logs)");
  }
  console.log(`${st.verifyWorkspace ? "ok   " : "MISSING"} verify workspace ${VERIFY_WS}`);
  console.log(`${st.webhookListening ? "ok   " : "off  "} trader webhook :${WEBHOOK_PORT} (only needed for cron402)`);
  console.log(`info  cron402: ${st.cron402}`);
}

function install() {
  mkdirSync(AGENTS_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
  const body = renderPlist();
  const changed = !existsSync(PLIST) || readFileSync(PLIST, "utf8") !== body;
  if (changed) writeFileSync(PLIST, body);
  if (loaded()) sh("launchctl", ["bootout", `gui/${uid()}/${LABEL}`]);
  let r = sh("launchctl", ["bootstrap", `gui/${uid()}`, PLIST]);
  if (r.status !== 0) r = sh("launchctl", ["load", "-w", PLIST]);
  if (r.status !== 0) {
    console.error(`launchctl failed: ${(r.stderr || r.stdout).trim()}`);
    process.exit(1);
  }
  console.log(`${changed ? "wrote" : "kept"} ${PLIST} (node ${process.execPath})`);
  console.log(`loaded ${LABEL}: every ${INTERVAL_SEC}s, first run in ≤${INTERVAL_SEC}s (use run-now to start one immediately)`);
}

function uninstall() {
  if (loaded()) sh("launchctl", ["bootout", `gui/${uid()}/${LABEL}`]);
  if (existsSync(PLIST)) unlinkSync(PLIST);
  console.log(`removed ${LABEL}`);
}

function runNow() {
  if (!loaded()) {
    console.error("not loaded — run install first");
    process.exit(1);
  }
  const r = sh("launchctl", ["kickstart", `gui/${uid()}/${LABEL}`]);
  if (r.status !== 0) {
    console.error(`kickstart failed: ${(r.stderr || r.stdout).trim()}`);
    process.exit(1);
  }
  console.log(`kicked ${LABEL}; watch sessions/trader-logs/cycle.out.log`);
}

const [cmd = "status", ...rest] = process.argv.slice(2);
const json = rest.includes("--json");
if (cmd === "status") {
  const st = status();
  if (json) console.log(JSON.stringify(st, null, 2));
  else printStatus(st);
  process.exit(st.scheduled ? 0 : 1);
} else if (cmd === "install") install();
else if (cmd === "uninstall") uninstall();
else if (cmd === "run-now") runNow();
else {
  console.error("usage: trader-schedule.mjs status [--json] | install | uninstall | run-now");
  process.exit(2);
}
