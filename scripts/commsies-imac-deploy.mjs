#!/usr/bin/env node
/**
 * commsies-imac-deploy.mjs
 *
 * Keep Commsies (Express + local Ollama) alive on the iMac at :3002.
 * Replaces Vercel / Cloudflare Workers as the AI backend for Aarcade comms.
 *
 *   abra run gotchibot -- node scripts/commsies-imac-deploy.mjs
 *
 * Assumes ~/Dev/commsies exists on the iMac (same layout as MBP).
 * After this is up, point Aarcade Vercel env:
 *   COMMSIES_URL=https://commsies.aarcadeghst.com
 * and route that hostname via cloudflared → http://127.0.0.1:3002
 *
 * Env:
 *   COMMSIES_DIR          remote path (default ~/Dev/commsies under REMOTE_USER)
 *   COMMSIES_PORT         default 3003 (3002 is aavegotchi-petter on the iMac)
 *   OLLAMA_HOST           default http://127.0.0.1:11434
 *   OLLAMA_MODEL          default qwen2.5:3b (already on the iMac)
 */

import { assertRemoteReady, materializeKey, runSsh } from "./remote-lib.mjs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = process.env.COMMSIES_PORT || "3003";
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5:3b";

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function main() {
  const cfg = assertRemoteReady({ needKey: true });
  const key = materializeKey(cfg.key);
  const commsiesDir =
    process.env.COMMSIES_DIR ||
    (cfg.user ? `/Users/${cfg.user}/Dev/commsies` : join(homedir(), "Dev", "commsies"));
  const logDir = `${commsiesDir}/sessions`;
  const watchdogPath = `${commsiesDir}/scripts/imac-watchdog.sh`;

  try {
    const ensure = runSsh(
      cfg,
      key.path,
      `test -d ${shellQuote(commsiesDir)} && test -f ${shellQuote(`${commsiesDir}/server.js`)}`,
    );
    if (ensure.status !== 0) {
      console.error(
        `[commsies] missing ${commsiesDir} on iMac — clone/sync the commsies repo first`,
      );
      process.exit(1);
    }

    const watchdog = `#!/bin/bash
# Commsies keep-alive — installed by GotchiBot scripts/commsies-imac-deploy.mjs
set -euo pipefail
cd ${shellQuote(commsiesDir)}
export PATH="/usr/local/bin:/opt/homebrew/bin:/Users/${cfg.user}/.nvm/versions/node/current/bin:$PATH"
export PORT=${shellQuote(PORT)}
export OLLAMA_HOST=${shellQuote(OLLAMA_HOST)}
export OLLAMA_MODEL=${shellQuote(OLLAMA_MODEL)}
# Prefer Ollama on the iMac — do not fall through to Cloudflare Workers AI.
unset CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN || true
mkdir -p ${shellQuote(logDir)}

LOCK_FILE=${shellQuote(`${logDir}/commsies.lock`)}
PID_FILE=${shellQuote(`${logDir}/commsies.pid`)}

if [ -f "$LOCK_FILE" ]; then
  LOCK_PID=$(cat "$LOCK_FILE" 2>/dev/null || true)
  if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
    exit 0
  fi
  rm -f "$LOCK_FILE"
fi

# Already healthy?
if curl -fsS -m 3 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  exit 0
fi

echo $$ > "$LOCK_FILE"
pkill -f "${commsiesDir}/server.js" 2>/dev/null || true
nohup node server.js >> ${shellQuote(`${logDir}/commsies.out.log`)} 2>&1 &
PID=$!
disown $PID
echo $PID > "$PID_FILE"
rm -f "$LOCK_FILE"
echo "Commsies started (PID: $PID) on :${PORT}"
`;

    const writeWatchdog = `mkdir -p ${shellQuote(`${commsiesDir}/scripts`)} ${shellQuote(logDir)}
cat > ${shellQuote(watchdogPath)} << 'WATCHDOG_EOF'
${watchdog}
WATCHDOG_EOF
chmod +x ${shellQuote(watchdogPath)}`;

    console.error("[commsies] writing watchdog…");
    const w = runSsh(cfg, key.path, writeWatchdog);
    if (w.status !== 0) {
      console.error("[commsies] write failed:", w.stderr);
      process.exit(1);
    }

    const cronEntry = `* * * * * ${watchdogPath} >> ${logDir}/cron.log 2>&1`;
    const addCron = `(crontab -l 2>/dev/null | grep -v "commsies/scripts/imac-watchdog" ; echo ${shellQuote(cronEntry)}) | crontab -`;
    console.error("[commsies] installing crontab…");
    const c = runSsh(cfg, key.path, addCron);
    if (c.status !== 0) {
      console.error("[commsies] crontab failed:", c.stderr);
      process.exit(1);
    }

    console.error("[commsies] starting once…");
    const once = runSsh(cfg, key.path, watchdogPath);
    if (once.status !== 0) {
      console.error("[commsies] start failed:", once.stderr || once.stdout);
      process.exit(1);
    }

    const health = runSsh(
      cfg,
      key.path,
      `sleep 2; curl -fsS -m 5 http://127.0.0.1:${PORT}/health`,
    );
    console.error("[commsies] health:", health.stdout || health.stderr);
    if (health.status !== 0) process.exit(1);

    console.log(`ok: Commsies on iMac :${PORT} (point COMMSIES_URL at the cloudflared hostname)`);
  } finally {
    key.dispose();
  }
}

main();
