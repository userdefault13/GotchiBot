#!/usr/bin/env node
/**
 * Start/restart the GotchiBot orchestrator OpenCode server on the iMac.
 *
 * Injects abra secrets into the serve process so the gotchi agent can spawn
 * sub-agents on the iMac without interactive Keychain unlock.
 *
 *   abra run gotchibot -- node scripts/remote-serve.mjs
 *   abra run gotchibot -- ./scripts/gotchibot remote-serve
 */
import { writeFileSync, unlinkSync, appendFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { assertRemoteReady, materializeKey } from "./remote-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG = join(ROOT, ".cursor", "debug-892b96.log");

/** Env keys to forward from MBP abra → iMac serve (for spawn / wallet gate). */
const FORWARD = [
  "OPENCODE_SERVER_USERNAME",
  "OPENCODE_SERVER_PASSWORD",
  "AARCADE_GOTCHIBOT_SERVICE_SECRET",
  "NVIDIA_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "GOTCHIBOT_OWNER",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "OPENCODE_API_KEY",
  "OPENCODE_ZEN_API_KEY",
];

function dbg(hypothesisId, message, data) {
  // #region agent log
  const payload = {
    sessionId: "892b96",
    runId: "remote-serve",
    hypothesisId,
    location: "remote-serve.mjs",
    message,
    data,
    timestamp: Date.now(),
  };
  try {
    appendFileSync(LOG, `${JSON.stringify(payload)}\n`);
  } catch {}
  fetch("http://127.0.0.1:7576/ingest/0147507d-1fe4-4821-a7bb-afea994177ef", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "892b96" },
    body: JSON.stringify(payload),
  }).catch(() => {});
  // #endregion
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

const cfg = assertRemoteReady();
const iosMode = process.env.GOTCHIBOT_OPENCODE_IOS === "1" || process.argv.includes("--ios");
const user = process.env.OPENCODE_SERVER_USERNAME || "opencode";
const pass = process.env.OPENCODE_SERVER_PASSWORD || "";
if (!iosMode && !pass) {
  console.error("OPENCODE_SERVER_PASSWORD missing — abra run gotchibot -- node scripts/remote-serve.mjs");
  console.error("Or use iOS mode (Tailscale-only, no Basic auth): GOTCHIBOT_OPENCODE_IOS=1 … remote-serve");
  process.exit(2);
}

const forwarded = {};
for (const k of FORWARD) {
  if (process.env[k]) forwarded[k] = process.env[k];
}
if (iosMode) {
  forwarded.GOTCHIBOT_OPENCODE_IOS = "1";
  forwarded.GOTCHIBOT_OPENCODE_HOSTNAME = process.env.GOTCHIBOT_OPENCODE_HOSTNAME || cfg.host;
  forwarded.REMOTE_HOST = cfg.host;
  // Do not forward server password — OpenCode Mobile connect UI often cannot send Basic auth.
  delete forwarded.OPENCODE_SERVER_PASSWORD;
  delete forwarded.OPENCODE_SERVER_USERNAME;
} else {
  forwarded.OPENCODE_SERVER_USERNAME = user;
  forwarded.OPENCODE_SERVER_PASSWORD = pass;
}

const envBody =
  Object.entries(forwarded)
    .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
    .join("\n") + "\n";

const localEnv = join(tmpdir(), `gotchibot-serve-env-${process.pid}`);
writeFileSync(localEnv, envBody, { mode: 0o600 });

const key = materializeKey(cfg.key);
const remoteRoot = cfg.dir;
const remoteEnv = "/tmp/gotchibot-serve.env";

try {
  dbg("N", "remote-serve start", {
    host: cfg.host,
    forwardKeys: Object.keys(forwarded),
    remoteRoot,
  });

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
    console.error(scp.stderr || "scp env failed");
    process.exit(scp.status ?? 1);
  }

  const script = [
    `export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"`,
    `chmod 600 ${shellQuote(remoteEnv)}`,
    `set -a`,
    `source ${shellQuote(remoteEnv)}`,
    `set +a`,
    `cd ${shellQuote(remoteRoot)}`,
    `pkill -f "opencode serve" 2>/dev/null || true`,
    `pkill -f "tailscale serve" 2>/dev/null || true`,
    `sleep 1`,
    // Kill public tunnels when running authless iOS mode
    iosMode
      ? `pkill -f "ngrok http" 2>/dev/null || true; pkill -f "cloudflared tunnel --url" 2>/dev/null || true`
      : `true`,
    `nohup ./scripts/opencode-serve.sh > /tmp/opencode-serve.log 2>&1 &`,
    `sleep 3`,
    `tail -15 /tmp/opencode-serve.log`,
    iosMode
      ? `curl -s -o /dev/null -w "ts:%{http_code}\\n" http://${cfg.host}:4096/global/health || true`
      : [
          `curl -s -o /dev/null -w "anon:%{http_code}\\n" http://127.0.0.1:4096/global/health || true`,
          `curl -s -u ${shellQuote(`${user}:${pass}`)} -o /dev/null -w "auth:%{http_code}\\n" http://127.0.0.1:4096/global/health || true`,
        ].join("\n"),
    `test -f sessions/.wallet.json && echo wallet_ok || echo wallet_missing`,
    `test -f .opencode/agents/gotchi.md && echo gotchi_agent_ok || echo gotchi_agent_missing`,
  ].join("\n");

  const r = spawnSync(
    "ssh",
    [
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-i",
      key.path,
      `${cfg.user}@${cfg.host}`,
      `bash -lc ${shellQuote(script)}`,
    ],
    { encoding: "utf8" },
  );

  const scrub = (s) =>
    (s || "")
      .replace(/opencode:[^\s'"]+/g, "opencode:***")
      .replace(/OPENCODE_SERVER_PASSWORD='[^']*'/g, "OPENCODE_SERVER_PASSWORD='***'");
  process.stdout.write(scrub(r.stdout));
  process.stderr.write(scrub(r.stderr));
  dbg("N", "remote-serve result", { status: r.status, out: scrub(r.stdout).slice(0, 600) });

  if (r.status === 0) {
    console.log(`\nOrchestrator server on iMac: http://${cfg.host}:4096`);
    if (iosMode) {
      console.log(`Mode:       iOS / Tailscale-only (no Basic auth, public tunnels killed)`);
      console.log(`iPhone:     Tailscale ON → http://${cfg.host}:4096  (blank user/password)`);
      console.log(`MBP attach: opencode attach http://${cfg.host}:4096`);
    } else {
      console.log(`MBP attach:  abra run gotchibot -- ./scripts/gotchibot attach`);
      console.log(`iPhone:      prefer GOTCHIBOT_OPENCODE_IOS=1 — app often cannot send Basic auth`);
    }
  }
  process.exit(r.status ?? 1);
} finally {
  key.dispose();
  try {
    unlinkSync(localEnv);
  } catch {}
}
