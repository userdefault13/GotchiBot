#!/usr/bin/env node
/**
 * infra-webhook-deploy.mjs
 *
 * Deploys the infra-webhook receiver to the iMac:
 *   1. Generates a shared secret token
 *   2. Creates a launchctl plist for the webhook service (listens on :8788)
 *   3. Adds a path-based ingress to cloudflared:
 *        subgraph.aarcadeghst.com/infra-webhook  ->  http://127.0.0.1:8788
 *   4. Restarts cloudflared and loads the launchctl service
 *
 * Run via abra so the SSH key is injected:
 *   abra run gotchibot -- node scripts/infra-webhook-deploy.mjs
 *
 * Prints the generated token to stdout (capture it for the cron registration).
 */

import { assertRemoteReady, materializeKey, runSsh } from "./remote-lib.mjs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

function main() {
  const cfg = assertRemoteReady({ needKey: true });
  const key = materializeKey(cfg.key);

  // Generate a shared secret token (32 bytes hex)
  const token = randomBytes(32).toString("hex");
  console.error(`[deploy] generated token: ${token}`);

// --- 1. Create webhook startup script (nohup + disown + brief sleep, PID file) ---
  const startScript = `#!/bin/bash
# infra-webhook startup script
set -e
cd "${cfg.dir}"
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.nvm/versions/node/current/bin:\$PATH"
export INFRA_WEBHOOK_TOKEN="${token}"
export INFRA_WEBHOOK_PORT=8788
mkdir -p "${cfg.dir}/sessions/infra-logs"

# Kill existing
pkill -f "infra-webhook.mjs" 2>/dev/null || true

# Start webhook in background, fully detach from shell, then brief sleep to let it detach
nohup /usr/local/bin/node "${cfg.dir}/scripts/infra-webhook.mjs" \
  >> "${cfg.dir}/sessions/infra-logs/webhook.out.log" 2>&1 &
PID=\$!
disown \$PID
echo \$PID > "${cfg.dir}/sessions/infra-webhook.pid"
echo "Webhook started (PID: \$PID)"
# Brief sleep lets the background process fully detach from the SSH session
sleep 2
`;

  const startScriptPath = `${cfg.dir}/scripts/infra-webhook-start.sh`;
  const writeStartScript = `cat > ${startScriptPath} << 'START_EOF'\n${startScript}\nSTART_EOF\nchmod +x ${startScriptPath}`;

  console.error("[deploy] writing startup script...");
  const r1 = runSsh(cfg, key.path, writeStartScript);
  if (r1.status !== 0) {
    console.error("[deploy] failed to write startup script:", r1.stderr);
    key.dispose();
    process.exit(1);
  }

  // --- 2. Update cloudflared config (add path ingress) ---
  if (r1.status !== 0) {
    console.error("[deploy] failed to write plist:", r1.stderr);
    key.dispose();
    process.exit(1);
  }

  // --- 2. Update cloudflared config (add path ingress) ---
  // Config is at /usr/local/etc/cloudflared/config.yml (symlink)
  const updateTunnel = `
set -e
CONFIG_FILE="/usr/local/etc/cloudflared/config.yml"
if [ ! -f "$CONFIG_FILE" ]; then
  echo "cloudflared config not found at $CONFIG_FILE"
  exit 1
fi
# Backup
cp "$CONFIG_FILE" "$CONFIG_FILE.bak.$(date +%s)"

# Check if infra-webhook ingress already exists
if grep -q "infra-webhook" "$CONFIG_FILE"; then
  echo "infra-webhook ingress already present"
else
  # Insert path rule before the first catch-all hostname rule
  awk '
    /^ingress:/ { print; printed=1; next }
    printed && /^  - hostname:/ && !inserted {
      print "  - hostname: subgraph.aarcadeghst.com"
      print "    path: /infra-webhook"
      print "    service: http://localhost:8788"
      print ""
      inserted=1
    }
    { print }
  ' "$CONFIG_FILE" > "$CONFIG_FILE.new" && mv "$CONFIG_FILE.new" "$CONFIG_FILE"
  echo "Added infra-webhook path ingress"
fi
`;

  console.error("[deploy] updating cloudflared config...");
  const r2 = runSsh(cfg, key.path, updateTunnel);
  if (r2.status !== 0) {
    console.error("[deploy] failed to update cloudflared config:", r2.stderr);
    key.dispose();
    process.exit(1);
  }

  // --- 3. Restart cloudflared (user process, no sudo needed) ---
  const restartTunnel = `
# Kill existing user cloudflared and restart
pkill -f "cloudflared tunnel run" 2>/dev/null || true
sleep 1
# Start cloudflared in background (assumes config at /usr/local/etc/cloudflared/config.yml)
nohup cloudflared tunnel --config /usr/local/etc/cloudflared/config.yml run > ~/cloudflared.out.log 2>&1 &
sleep 3
pgrep -fl "cloudflared tunnel" || echo "cloudflared restart failed"
`;

  console.error("[deploy] restarting cloudflared...");
  const r3 = runSsh(cfg, key.path, restartTunnel);
  if (r3.status !== 0) {
    console.error("[deploy] cloudflared restart failed:", r3.stderr);
    key.dispose();
    process.exit(1);
  }

  // --- 4. Run the webhook startup script via ssh -f (forks to background on remote) ---
  const runStartup = `ssh -f -o ConnectTimeout=5 -o ServerAliveInterval=5 -o ServerAliveCountMax=1 -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -i ${key.path} ${cfg.user}@${cfg.host} "cd ${cfg.dir} && export PATH=\"/usr/local/bin:/opt/homebrew/bin:$HOME/.nvm/versions/node/current/bin:\$PATH\" && export INFRA_WEBHOOK_TOKEN=\"${token}\" && export INFRA_WEBHOOK_PORT=8788 && mkdir -p sessions/infra-logs && pkill -f \"infra-webhook.mjs\" 2>/dev/null || true && nohup /usr/local/bin/node scripts/infra-webhook.mjs >> sessions/infra-logs/webhook.out.log 2>&1 & disown && sleep 2"`;

  console.error("[deploy] starting webhook via ssh -f...");
  const r4 = spawnSync("bash", ["-lc", runStartup], { stdio: "inherit", encoding: "utf8" });
  if (r4.status !== 0) {
    console.error("[deploy] webhook startup failed:", r4.stderr);
    key.dispose();
    process.exit(1);
  }

  // --- 5. Quick health check ---
  const healthCheck = `
sleep 2
curl -sS -m 5 -X POST http://127.0.0.1:8788/infra-webhook -H "x-infra-token: ${token}" -d '{}' | head -c 200 || echo "health check failed"
`;

  console.error("[deploy] running health check...");
  const r5 = runSsh(cfg, key.path, healthCheck);
  console.error("[deploy] health check output:", r5.stdout || r5.stderr);

  key.dispose();

  // Print token to stdout (for cron registration)
  console.log(token);
}

main();