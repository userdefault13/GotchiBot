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
import { assertRemoteReady, materializeKey, sshArgs } from "./remote-lib.mjs";

// Nothing listens on 127.0.0.1:8787 on the M1; the local subgraph entry is
// graphql-proxy on :8786, which requires X-Subgraph-Proxy-Key.
export const LOCAL_PROXY_URL = "http://127.0.0.1:8786/subgraphs/name/aavegotchi-core-base";
export const PROXY_KEY_HEADER = "X-Subgraph-Proxy-Key";

export function proxyKeyFromEnv(env = process.env) {
  return String(env.GOTCHIBOT_SUBGRAPH_PROXY_KEY || env.SUBGRAPH_PROXY_SECRET || "").trim();
}

/**
 * Remote probe line. The key never appears in argv or the script: curl reads the
 * header line from stdin (-H @-), which we feed over the ssh session's stdin.
 */
export function localProbeLines(hasKey) {
  const hdr = hasKey ? " -H @-" : "";
  return [
    'echo "=== local graphql-proxy :8786 ==="',
    `curl -sS -m 8 -X POST ${LOCAL_PROXY_URL} -H "Content-Type: application/json"${hdr} -d '{"query":"{ _meta { block { number } } }"}' | head -c 200 || echo local-fail`,
    "echo",
  ];
}

export function proxyKeyStdin(key) {
  return key ? `${PROXY_KEY_HEADER}: ${key}\n` : "";
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check-only");

function remote(cfg, keyPath, script, input = "") {
  return spawnSync("ssh", sshArgs(cfg, keyPath, script), { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
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
  const proxyKey = proxyKeyFromEnv();

  const remoteScript = [
    "set -e",
    'echo "=== iMac cloudflared ==="',
    "pgrep -fl cloudflared || echo no-cloudflared",
    ...localProbeLines(Boolean(proxyKey)),
  ];
  if (!proxyKey) console.error("note: no GOTCHIBOT_SUBGRAPH_PROXY_KEY (run via abra); local probe will be rejected");

  if (!checkOnly) {
    remoteScript.push(
      'echo "=== restarting cloudflared (sudo) ==="',
      "sudo launchctl kickstart -k system/com.cloudflare.cloudflared 2>&1 || sudo launchctl stop com.cloudflare.cloudflared; sudo launchctl start com.cloudflare.cloudflared",
      "sleep 3",
      "pgrep -fl cloudflared || echo restart-failed",
    );
  }

  try {
    const r = remote(cfg, key.path, remoteScript.join("\n"), proxyKeyStdin(proxyKey));
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
