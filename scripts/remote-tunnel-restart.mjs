#!/usr/bin/env node
/**
 * Restart Cloudflare tunnel (cloudflared) on the iMac and verify subgraph proxy.
 *
 * Requires passwordless sudo for launchctl on the iMac, or run manually on iMac:
 *   sudo launchctl kickstart -k system/com.cloudflare.cloudflared
 *
 *   abra run gotchibot -- node scripts/remote-tunnel-restart.mjs
 *   abra run gotchibot -- node scripts/remote-tunnel-restart.mjs --check-only
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertRemoteReady, materializeKey, runSsh } from "./remote-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check-only");

function remote(cfg, keyPath, script) {
  return runSsh(cfg, keyPath, script, { stdio: "pipe" });
}

async function waitForPublic(maxMs = 90_000) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const r = spawnSync(process.execPath, [`${ROOT}/scripts/tunnel-health.mjs`], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (r.status === 0) return true;
    spawnSync("sleep", ["3"]);
  }
  return false;
}

async function main() {
  const cfg = assertRemoteReady();
  const key = materializeKey(cfg.key);

  const remoteScript = [
    "set -e",
    'echo "=== iMac cloudflared ==="',
    "pgrep -fl cloudflared || echo no-cloudflared",
    'echo "=== local subgraph :8787 ==="',
    'curl -sS -m 8 -X POST http://127.0.0.1:8787/subgraphs/name/aavegotchi-core-base -H "Content-Type: application/json" -d \'{"query":"{ _meta { block { number } } }"}\' | head -c 200 || echo local-fail',
    "echo",
  ];

  if (!checkOnly) {
    remoteScript.push(
      'echo "=== restarting cloudflared (sudo) ==="',
      "sudo launchctl kickstart -k system/com.cloudflare.cloudflared 2>&1 || sudo launchctl stop com.cloudflare.cloudflared; sudo launchctl start com.cloudflare.cloudflared",
      "sleep 3",
      "pgrep -fl cloudflared || echo restart-failed",
    );
  }

  try {
    const r = remote(cfg, key.path, remoteScript.join("\n"));
    process.stdout.write(r.stdout || "");
    if (r.stderr) process.stderr.write(r.stderr);

    if (checkOnly) {
      process.exit(r.status ?? 0);
    }

    console.log("\nWaiting for public subgraph tunnel…");
    const ok = await waitForPublic();
    if (ok) {
      console.log("✓ subgraph.aarcadeghst.com is reachable");
      process.exit(0);
    }

    console.error("✗ tunnel still down after restart");
    console.error("  iMac logs: /Library/Logs/com.cloudflare.cloudflared.err.log");
    console.error("  common cause: home network UDP blocked — iMac lost QUIC to Cloudflare edge");
    process.exit(1);
  } finally {
    key.dispose();
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
