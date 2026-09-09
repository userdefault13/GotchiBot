#!/usr/bin/env node
/**
 * comms-agent-cron-deploy.mjs
 *
 * Installs the daily Aarcade comms cron on the iMac for WBTC (owned-22899).
 * Runs scripts/comms-claude-cycle.mjs — the Claude terminal path, never
 * Commsies / Cloudflare AI — once per day at 23:50 in the iMac's local time
 * (America/Los_Angeles), i.e. `50 23 * * *`. Override with COMMS_CRON_SCHEDULE.
 *
 *   node scripts/comms-agent-cron-deploy.mjs --status
 *     no secret needed: is the crontab line there, is the wrapper + env file in
 *     place, when did the last run log. Over SSH from the Desk (abra), or locally
 *     on the iMac / inside the gateway container (files only; crontab if visible).
 *
 * Requires abra-injected secrets (never logged):
 *   abra run gotchibot -- node scripts/comms-agent-cron-deploy.mjs
 *
 * Env:
 *   COMM_AUTOMATION_SECRET  required — forwarded to iMac as 0600 sessions/.comms-cron.env
 *   AARCADE_API_BASE        optional (default https://aarcadeghst.com)
 *   COMMS_CRON_SCHEDULE     optional crontab expr (default `50 23 * * *`, iMac local time)
 *   REMOTE_HOST / REMOTE_USER / SSH_PRIVATE_KEY — via abra (remote-lib)
 */

import { writeFileSync, unlinkSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { assertRemoteReady, materializeKey, runSsh } from "./remote-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEDULE = process.env.COMMS_CRON_SCHEDULE || "50 23 * * *";
const API_BASE = (process.env.AARCADE_API_BASE || "https://aarcadeghst.com").replace(/\/+$/, "");

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

const STATUS_SCRIPT = `
cd "$DIR" 2>/dev/null || { echo "root-MISSING $DIR"; exit 0; }
line=$(crontab -l 2>/dev/null | grep comms-agent-cron-run || true)
if [ -n "$line" ]; then echo "cron: $line"; else echo "cron: NONE"; fi
[ -x scripts/comms-agent-cron-run.sh ] && echo "wrapper: ok" || echo "wrapper: MISSING"
[ -f sessions/.comms-cron.env ] && echo "env: ok" || echo "env: MISSING (sessions/.comms-cron.env)"
last=$(ls -t sessions/comms-logs 2>/dev/null | grep -v '^cron.log$' | head -1)
if [ -n "$last" ]; then echo "last-run: $last ($(( ( $(date +%s) - $(stat -f %m "sessions/comms-logs/$last") ) / 3600 ))h ago)"; else echo "last-run: never"; fi
echo "cron.log tail:"; tail -n 3 sessions/comms-logs/cron.log 2>/dev/null || echo "  (no cron.log)"
`;

function printStatus(out, where) {
  const cron = out.match(/^cron: (.*)$/m)?.[1] || "?";
  const scheduled = cron !== "NONE" && cron !== "?";
  const expr = scheduled ? cron.trim().split(/\s+/).slice(0, 5).join(" ") : null;
  console.log(`${scheduled ? "ok   " : "MISSING"} WBTC comms scheduled (${where}): ${scheduled ? `crontab \`${expr}\` (iMac local time; 50 23 = 23:50 America/Los_Angeles)` : "NOT scheduled — run: abra run gotchibot -- ./scripts/gotchibot comms schedule install"}`);
  for (const l of out.split("\n")) if (l && !l.startsWith("cron:")) console.log(`      ${l}`);
  return scheduled;
}

function statusLocal() {
  const dir = ROOT;
  const r = spawnSync("bash", ["-c", STATUS_SCRIPT], { encoding: "utf8", env: { ...process.env, DIR: dir } });
  const crontabVisible = spawnSync("crontab", ["-l"], { encoding: "utf8" }).status === 0;
  const ok = printStatus(r.stdout || "", crontabVisible ? "this host" : "files only — crontab not visible from here, e.g. inside the gateway container");
  process.exit(ok ? 0 : 1);
}

function statusRemote() {
  const cfg = assertRemoteReady({ needKey: true });
  const key = materializeKey(cfg.key);
  try {
    const r = runSsh(cfg, key.path, `DIR=${shellQuote(cfg.dir)} bash -c ${shellQuote(STATUS_SCRIPT)}`, { stdio: "pipe" });
    const ok = printStatus(r.stdout || "", `iMac ${cfg.host}`);
    process.exit(ok ? 0 : 1);
  } finally {
    key.dispose();
  }
}

function main() {
  if (process.argv.includes("--status")) {
    const remote = Boolean(process.env.REMOTE_HOST || process.env.GOTCHIBOT_REMOTE_HOST) && !process.env.GOTCHIBOT_ON_IMAC;
    return remote ? statusRemote() : statusLocal();
  }
  const secret = process.env.COMM_AUTOMATION_SECRET;
  if (!secret) {
    console.error("COMM_AUTOMATION_SECRET missing — run under: abra run gotchibot -- …");
    process.exit(2);
  }

  const cfg = assertRemoteReady({ needKey: true });
  const key = materializeKey(cfg.key);

  const envBody = [
    `export AARCADE_API_BASE=${shellQuote(API_BASE)}`,
    `export COMM_AUTOMATION_SECRET=${shellQuote(secret)}`,
    `export COMMS_LOG_DIR=${shellQuote(`${cfg.dir}/sessions/comms-logs`)}`,
    "",
  ].join("\n");

  const localEnv = join(tmpdir(), `gotchibot-comms-cron-env-${process.pid}`);
  writeFileSync(localEnv, envBody, { mode: 0o600 });
  const remoteEnv = `${cfg.dir}/sessions/.comms-cron.env`;

  try {
    console.error("[comms-cron] scp env → iMac (0600)…");
    const scp = spawnSync(
      "scp",
      [
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-i",
        key.path,
        localEnv,
        `${cfg.user}@${cfg.host}:${remoteEnv}`,
      ],
      { encoding: "utf8" },
    );
    if (scp.status !== 0) {
      console.error("[comms-cron] scp failed:", scp.stderr || scp.stdout);
      process.exit(1);
    }

    const chmod = runSsh(cfg, key.path, `chmod 600 ${shellQuote(remoteEnv)}`);
    if (chmod.status !== 0) {
      console.error("[comms-cron] chmod failed:", chmod.stderr);
      process.exit(1);
    }

    const wrapperPath = `${cfg.dir}/scripts/comms-agent-cron-run.sh`;
    const wrapper = `#!/bin/bash
# WBTC daily comms — installed by scripts/comms-agent-cron-deploy.mjs
# Claude terminal path (comms-claude-cycle). Commsies / Cloudflare AI is retired.
set -euo pipefail
cd ${shellQuote(cfg.dir)}
export PATH="/opt/homebrew/bin:/usr/local/bin:/Users/${cfg.user}/.local/bin:$PATH"
export GOTCHIBOT_ON_IMAC=1
export GOTCHIBOT_TMUX_SESSION="\${GOTCHIBOT_TMUX_SESSION:-gotchibot}"
# shellcheck disable=SC1091
source ${shellQuote(remoteEnv)}
mkdir -p sessions/comms-logs
# caffeinate: the daily run is unattended, so keep the box awake for the Claude
# terminal round (the stall is App Nap / idle sleep on the attached Terminal).
CAF=""; [ -x /usr/bin/caffeinate ] && CAF="/usr/bin/caffeinate -dimsu"
exec $CAF node scripts/comms-claude-cycle.mjs --host local "$@"
`;

    const writeWrapper = `cat > ${shellQuote(wrapperPath)} << 'EOF'\n${wrapper}\nEOF\nchmod +x ${shellQuote(wrapperPath)}`;
    console.error("[comms-cron] writing wrapper…");
    const w = runSsh(cfg, key.path, writeWrapper);
    if (w.status !== 0) {
      console.error("[comms-cron] wrapper failed:", w.stderr);
      process.exit(1);
    }

    const cronEntry = `${SCHEDULE} ${wrapperPath} >> ${cfg.dir}/sessions/comms-logs/cron.log 2>&1`;
    const addCron = `(crontab -l 2>/dev/null | grep -v "comms-agent-cron-run" ; echo ${shellQuote(cronEntry)}) | crontab -`;
    console.error("[comms-cron] installing crontab…");
    const c = runSsh(cfg, key.path, addCron);
    if (c.status !== 0) {
      console.error("[comms-cron] crontab failed:", c.stderr);
      process.exit(1);
    }

    const verify = runSsh(cfg, key.path, "crontab -l | grep comms-agent-cron-run || true");
    console.error("[comms-cron] crontab:", (verify.stdout || "").trim());

    // Smoke the wrapper the cheap way: env sourced, node found, terminal state
    // readable. The full Claude round is `gotchibot comms dry-run`.
    console.error("[comms-cron] wrapper --status…");
    const once = runSsh(cfg, key.path, `${shellQuote(wrapperPath)} --status`, { stdio: "pipe" });
    if (once.status !== 0) {
      console.error("[comms-cron] wrapper failed:", once.stderr || once.stdout);
      process.exit(1);
    }
    console.error((once.stdout || "").slice(0, 800));
    console.log("ok: owned-22899 daily comms cron installed (Claude terminal path)");
  } finally {
    key.dispose();
    try {
      unlinkSync(localEnv);
    } catch {}
  }
}

main();
