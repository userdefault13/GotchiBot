#!/usr/bin/env node
/**
 * infra-webhook-cron.mjs
 *
 * Sets up a cron job on the iMac to keep the infra-webhook alive.
 * Runs every minute, starts the webhook if not already running (lock file).
 *
 * Run via abra so the SSH key is injected:
 *   abra run gotchibot -- node scripts/infra-webhook-cron.mjs
 */

import { assertRemoteReady, materializeKey, runSsh } from "./remote-lib.mjs";

function main() {
  const cfg = assertRemoteReady({ needKey: true });
  const key = materializeKey(cfg.key);

  // The token must match what the cron402 registration will use
  // We'll read it from the existing startup script or generate a new one
  // For now, use a fixed token that we'll also use for cron402 registration
  const token = "infra-webhook-shared-secret-2026"; // Fixed token for simplicity

  // Create the watchdog script that cron will run every minute
  const watchdogScript = `#!/bin/bash
# infra-webhook watchdog - runs every minute via cron
# Starts the webhook if not already running (lock file prevents duplicates)

set -e
cd "${cfg.dir}"
export PATH="/usr/local/bin:/opt/homebrew/bin:/Users/juliuswong/.nvm/versions/node/current/bin:\$PATH"
export INFRA_WEBHOOK_TOKEN="${token}"
export INFRA_WEBHOOK_PORT=8788
mkdir -p "${cfg.dir}/sessions/infra-logs"

LOCK_FILE="${cfg.dir}/sessions/infra-webhook.lock"
PID_FILE="${cfg.dir}/sessions/infra-webhook.pid"

# Check if already running (lock file exists and process is alive)
if [ -f "\$LOCK_FILE" ]; then
  LOCK_PID=\$(cat "\$LOCK_FILE" 2>/dev/null)
  if [ -n "\$LOCK_PID" ] && kill -0 "\$LOCK_PID" 2>/dev/null; then
    # Process is alive, nothing to do
    exit 0
  fi
  # Stale lock, remove it
  rm -f "\$LOCK_FILE"
fi

# Create lock
echo \$\$ > "\$LOCK_FILE"

# Kill any existing webhook process
pkill -f "infra-webhook.mjs" 2>/dev/null || true

# Start webhook
export PATH="/usr/local/bin:/opt/homebrew/bin:/Users/juliuswong/.nvm/versions/node/current/bin:\$PATH"
export INFRA_WEBHOOK_TOKEN="${token}"
export INFRA_WEBHOOK_PORT=8788
mkdir -p "${cfg.dir}/sessions/infra-logs"

nohup /usr/local/bin/node "${cfg.dir}/scripts/infra-webhook.mjs" \
  >> "${cfg.dir}/sessions/infra-logs/webhook.out.log" 2>&1 &
PID=\$!
disown \$PID
echo \$PID > "${cfg.dir}/sessions/infra-webhook.pid"

# Remove lock (webhook is now running under its own PID)
rm -f "\$LOCK_FILE"

echo "Webhook started (PID: \$PID)"
`;

  const watchdogPath = `${cfg.dir}/scripts/infra-webhook-watchdog.sh`;
  const writeWatchdog = `cat > ${watchdogPath} << 'WATCHDOG_EOF'\n${watchdogScript}\nWATCHDOG_EOF\nchmod +x ${watchdogPath}`;

  console.error("[cron] writing watchdog script...");
  const r1 = runSsh(cfg, key.path, writeWatchdog);
  if (r1.status !== 0) {
    console.error("[cron] failed to write watchdog script:", r1.stderr);
    key.dispose();
    process.exit(1);
  }

  // Add cron entry (every minute)
  const cronEntry = `* * * * * ${watchdogPath} >> ${cfg.dir}/sessions/infra-logs/cron.log 2>&1`;
  const addCron = `(crontab -l 2>/dev/null | grep -v "infra-webhook-watchdog" ; echo "${cronEntry}") | crontab -`;

  console.error("[cron] adding cron entry...");
  const r2 = runSsh(cfg, key.path, addCron);
  if (r2.status !== 0) {
    console.error("[cron] failed to add cron entry:", r2.stderr);
    key.dispose();
    process.exit(1);
  }

  // Verify cron entry
  const verifyCron = `crontab -l | grep infra-webhook-watchdog`;
  const r3 = runSsh(cfg, key.path, verifyCron);
  console.error("[cron] cron entry:", (r3.stdout || "").trim());

  // Run watchdog once now to start the webhook
  console.error("[cron] running watchdog once to start webhook...");
  const r4 = runSsh(cfg, key.path, watchdogPath);
  if (r4.status !== 0) {
    console.error("[cron] initial watchdog run failed:", r4.stderr);
    key.dispose();
    process.exit(1);
  }

  // Wait a moment and verify
  const verify = `
sleep 2
curl -sS -m 5 -X POST http://127.0.0.1:8788/infra-webhook -H "x-infra-token: ${token}" -d '{}' | head -c 300
`;
  const r5 = runSsh(cfg, key.path, verify);
  console.error("[cron] health check:", r5.stdout || r5.stderr);

  key.dispose();
  console.log(token);
}

main();