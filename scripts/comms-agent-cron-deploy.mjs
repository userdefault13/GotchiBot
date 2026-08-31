#!/usr/bin/env node
/**
 * comms-agent-cron-deploy.mjs
 *
 * Installs the daily Aarcade comms cron on the iMac for WBTC (owned-22899).
 * Runs scripts/comms-agent-cron.mjs once per day (default 09:00 America/Los_Angeles
 * via `0 16 * * *` UTC). Override with COMMS_CRON_SCHEDULE.
 *
 * Requires abra-injected secrets (never logged):
 *   abra run gotchibot -- node scripts/comms-agent-cron-deploy.mjs
 *
 * Env:
 *   COMM_AUTOMATION_SECRET  required — forwarded to iMac as 0600 sessions/.comms-cron.env
 *   AARCADE_API_BASE        optional (default https://aarcadeghst.com)
 *   COMMS_CRON_SCHEDULE     optional crontab expr (default `0 16 * * *`)
 *   REMOTE_HOST / REMOTE_USER / SSH_PRIVATE_KEY — via abra (remote-lib)
 */

import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { assertRemoteReady, materializeKey, runSsh } from "./remote-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEDULE = process.env.COMMS_CRON_SCHEDULE || "0 16 * * *";
const API_BASE = (process.env.AARCADE_API_BASE || "https://aarcadeghst.com").replace(/\/+$/, "");

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function main() {
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
set -euo pipefail
cd ${shellQuote(cfg.dir)}
export PATH="/usr/local/bin:/opt/homebrew/bin:/Users/${cfg.user}/.nvm/versions/node/current/bin:$PATH"
# shellcheck disable=SC1091
source ${shellQuote(remoteEnv)}
mkdir -p sessions/comms-logs
exec node scripts/comms-agent-cron.mjs
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

    console.error("[comms-cron] dry-run once…");
    const once = runSsh(cfg, key.path, wrapperPath);
    if (once.status !== 0) {
      console.error("[comms-cron] dry-run failed:", once.stderr || once.stdout);
      process.exit(1);
    }
    console.error((once.stdout || "").slice(0, 800));
    console.log("ok: owned-22899 daily comms cron installed");
  } finally {
    key.dispose();
    try {
      unlinkSync(localEnv);
    } catch {}
  }
}

main();
