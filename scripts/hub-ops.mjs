#!/usr/bin/env node
/**
 * Hub ops SOP runner — status / restart OpenClaw gateway / vscode / bridge / tunnel.
 * For weak models: load skill hub-sop, then run this script (do not improvise SSH).
 *
 *   abra run gotchibot -- ./scripts/gotchibot hub status
 *   abra run gotchibot -- ./scripts/gotchibot hub restart-gateway
 *   abra run gotchibot -- node ./scripts/hub-ops.mjs restart-gateway --wait
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REMOTE_SH = "scripts/hub-ops-remote.sh";

function usage() {
  console.error(`usage:
  hub-ops.mjs status|restart-gateway|vscode-open|bridge-check|bridge-ensure|bridge-info|claude-pane-init|tunnel-restart|doctor
              [--json] [--wait] [--timeout SEC]

Prefer: abra run gotchibot -- ./scripts/gotchibot hub <action>`);
  process.exit(2);
}

const args = process.argv.slice(2);
const action = (args[0] || "").replace(/^--/, "");
let jsonOut = false;
let wait = true;
let timeoutSec = 90;
const rest = [];
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === "--json") jsonOut = true;
  else if (a === "--wait") wait = true;
  else if (a === "--no-wait") wait = false;
  else if (a === "--timeout") timeoutSec = Number(args[++i]) || timeoutSec;
  else rest.push(a);
}

const ACTIONS = new Set([
  "status",
  "restart-gateway",
  "restart",
  "vscode-open",
  "bridge-check",
  "bridge-ensure",
  "ensure-bridge",
  "bridge-info",
  "claude-pane-init",
  "tunnel-restart",
  "doctor",
  "help",
]);

if (!action || action === "help" || action === "-h" || !ACTIONS.has(action)) {
  if (action && action !== "help" && action !== "-h") console.error(`unknown action: ${action}`);
  usage();
}

function runLocal(script, argv, { timeout } = {}) {
  return spawnSync(process.execPath, [join(ROOT, script), ...argv], {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
    timeout: timeout ?? 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function useAbra() {
  if (process.env.SSH_PRIVATE_KEY && process.env.REMOTE_HOST) return false;
  return spawnSync("which", ["abra"], { encoding: "utf8" }).status === 0;
}

async function sshRemote(remoteCmd, { timeout } = {}) {
  const { assertRemoteReady, materializeKey, runSsh } = await import(join(ROOT, "scripts/remote-lib.mjs"));
  const cfg = assertRemoteReady();
  const mat = materializeKey(cfg.key);
  try {
    return {
      cfg,
      result: runSsh(cfg, mat.path, remoteCmd, {
        stdio: "pipe",
        timeout: timeout ?? 180_000,
      }),
    };
  } finally {
    mat.dispose();
  }
}

function printResult(r, label) {
  const out = String(r.stdout || "").trim();
  const err = String(r.stderr || "").trim();
  if (out) console.log(out);
  if (err && r.status !== 0) console.error(err);
  if (r.status !== 0) {
    console.error(`${label} failed (exit ${r.status})`);
    process.exit(r.status || 1);
  }
}

async function main() {
  if (action === "status") {
    const r = runLocal("scripts/hub-status.mjs", jsonOut ? ["--json"] : [], { timeout: 60_000 });
    printResult(r, "hub status");
    return;
  }

  if (action === "vscode-open") {
    const argv = ["--timeout", String(timeoutSec)];
    if (jsonOut) argv.push("--json");
    if (!wait) argv.push("--no-wait");
    const r = runLocal("scripts/hub-vscode-open.mjs", argv, { timeout: (timeoutSec + 60) * 1000 });
    printResult(r, "vscode-open");
    return;
  }

  if (action === "bridge-check") {
    const r = runLocal("scripts/bridge-prompt.mjs", ["--check", "--host", "network"], { timeout: 45_000 });
    printResult(r, "bridge-check");
    return;
  }

  if (action === "bridge-ensure" || action === "ensure-bridge") {
    const argv = ["--timeout", String(timeoutSec)];
    if (jsonOut) argv.push("--json");
    const r = runLocal("scripts/hub-bridge-ensure.mjs", argv, { timeout: (timeoutSec + 90) * 1000 });
    printResult(r, "bridge-ensure");
    return;
  }

  if (action === "bridge-info") {
    const argv = jsonOut ? ["--json"] : ["--text"];
    const r = runLocal("scripts/hub-bridge-info.mjs", argv, { timeout: 90_000 });
    printResult(r, "bridge-info");
    return;
  }

  if (action === "claude-pane-init") {
    const argv = ["--json", ...rest];
    const r = runLocal("scripts/claude-pane-init.mjs", argv, { timeout: 30_000 });
    printResult(r, "claude-pane-init");
    return;
  }

  if (action === "tunnel-restart") {
    const r = runLocal("scripts/remote-tunnel-restart.mjs", rest, { timeout: 120_000 });
    printResult(r, "tunnel-restart");
    return;
  }

  if (action === "doctor" || action === "restart-gateway" || action === "restart") {
    const remoteAction = action === "restart" ? "restart-gateway" : action;
    const waitFlag = wait ? "1" : "0";
    const cmd = `bash ${REMOTE_SH} ${remoteAction} ${timeoutSec} ${waitFlag}`;
    const { cfg, result } = await sshRemote(cmd, { timeout: (timeoutSec + 90) * 1000 });
    const out = String(result.stdout || "").trim();
    const err = String(result.stderr || "").trim();
    if (jsonOut) {
      let parsed = null;
      try {
        parsed = JSON.parse(out.split("\n").filter(Boolean).pop() || "{}");
      } catch {
        parsed = { raw: out, stderr: err, status: result.status };
      }
      console.log(JSON.stringify({ host: cfg.host, action: remoteAction, ...parsed }, null, 2));
    } else {
      if (out) console.log(out);
      if (err) console.error(err);
    }
    if (result.status !== 0) process.exit(result.status || 1);

    if (remoteAction === "restart-gateway" && wait) {
      const { gatewayReachable, gatewayUrl } = await import(join(ROOT, "scripts/openclaw-fleet.mjs"));
      const url = gatewayUrl();
      const ok = await gatewayReachable();
      if (jsonOut) {
        // already printed; append note via stderr
        console.error(ok ? `desk reach ${url} ok` : `desk reach ${url} still down`);
      } else {
        console.log(ok ? `✓ Desk can reach ${url}` : `✗ Desk still cannot reach ${url} — check Tailscale / logs`);
      }
      if (!ok) process.exit(1);
    }
    return;
  }

  usage();
}

await main();
