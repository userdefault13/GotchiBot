#!/usr/bin/env node
/**
 * One-shot Hub Claude bridge recovery for weak models.
 * Checks Desk receiver :45679, probes Hub bridge :45678, opens VS Code if needed,
 * falls back to SSH restart-bridge if still down.
 *
 *   node ./scripts/hub-bridge-ensure.mjs [--json] [--timeout SEC]
 *   abra run gotchibot -- node ./scripts/hub-bridge-ensure.mjs --json
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hubBridgeHttpUrl,
  isHubMachine,
  probeBridgeHttp,
  resolveClaudeHostMode,
} from "./claude-bridge-role.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  console.error(`usage: hub-bridge-ensure.mjs [--json] [--timeout SEC]
  One-shot recover: Desk receiver :45679 + Hub bridge :45678.
  Prefer: abra run gotchibot -- ./scripts/gotchibot hub bridge-ensure`);
  process.exit(2);
}

const args = process.argv.slice(2);
let jsonOut = false;
let timeoutSec = 45;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--json") jsonOut = true;
  else if (a === "--timeout") timeoutSec = Number(args[++i]) || timeoutSec;
  else if (a === "-h" || a === "--help") usage();
  else { console.error(`unknown arg: ${a}`); usage(); }
}

const log = jsonOut ? () => {} : (...a) => console.log(...a);
const err = jsonOut ? () => {} : (...a) => console.error(...a);

// ── Receiver :45679 ──

function checkReceiver() {
  const health = "http://127.0.0.1:45679/health";
  try {
    const r = spawnSync("curl", ["-sf", "--max-time", "2", health], { encoding: "utf8" });
    return r.status === 0;
  } catch {
    return false;
  }
}

async function startReceiver() {
  if (checkReceiver()) return true;
  const candidates = [
    join(process.env.HOME || "", "Dev/gotchibot-bridge/mbp-receiver/receiver.js"),
    join(process.env.HOME || "", "dev/gotchibot-bridge/mbp-receiver/receiver.js"),
  ];
  const script = candidates.find((p) => existsSync(p));
  if (!script) return false;
  try {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [script], {
      cwd: dirname(script),
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    spawnSync("sleep", ["0.7"]);
    return checkReceiver();
  } catch {
    return false;
  }
}

// ── Hub bridge :45678 ──

function probeHubBridge() {
  const url = hubBridgeHttpUrl();
  return { ok: probeBridgeHttp(url), url };
}

// ── SSH remote restart-bridge ──

async function sshRestartBridge(timeout) {
  try {
    const { assertRemoteReady, materializeKey, runSsh } = await import("./remote-lib.mjs");
    const cfg = assertRemoteReady();
    const mat = materializeKey(cfg.key);
    try {
      const remoteSh = "scripts/hub-vscode-open-remote.sh";
      const r = runSsh(cfg, mat.path, `bash ${remoteSh} restart-bridge ${timeout}`, {
        stdio: "pipe",
        timeout: (timeout + 30) * 1000,
      });
      return { ok: r.status === 0, raw: String(r.stdout || "").trim(), stderr: String(r.stderr || "").trim() };
    } finally {
      mat.dispose();
    }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// ── Main ──

async function main() {
  const isHub = isHubMachine();
  const steps = [];

  // Step 1: Desk receiver
  log("Checking Desk receiver :45679 …");
  let receiverOk = checkReceiver();
  if (!receiverOk) {
    log("Receiver down — starting …");
    receiverOk = await startReceiver();
  }
  steps.push({ step: "receiver", ok: receiverOk });
  if (receiverOk) log("  ✓ Desk receiver :45679 up");
  else err("  ✗ Desk receiver :45679 not reachable (non-fatal for Hub-side bridge)");

  // Step 2: Probe Hub bridge HTTP
  log("Probing Hub bridge :45678 …");
  let { ok: bridgeUp, url: bridgeUrl } = probeHubBridge();
  steps.push({ step: "probe", ok: bridgeUp, url: bridgeUrl });
  if (bridgeUp) {
    log(`  ✓ Hub bridge up (${bridgeUrl})`);
    // Still ensure proxy identity files on local Hub tree when we can
    try {
      const { runPaneInit } = await import("./claude-pane-init.mjs");
      const init = runPaneInit({});
      steps.push({ step: "claude-pane-init", ok: init.ok, reportsTo: init.reportsTo });
    } catch (e) {
      steps.push({ step: "claude-pane-init", ok: false, error: e?.message || String(e) });
    }
    const result = { ok: true, already: true, receiver: receiverOk, bridgeUrl, steps };
    if (jsonOut) console.log(JSON.stringify(result));
    else log("Bridge already healthy — nothing to do.");
    process.exit(0);
  }
  err(`  ✗ Hub bridge down (${bridgeUrl})`);

  // Step 3: On Hub machine, try local vscode-open
  if (isHub) {
    log("On Hub — opening VS Code locally …");
    const r = spawnSync(process.execPath, [join(ROOT, "scripts/hub-vscode-open.mjs"), "--timeout", String(timeoutSec), "--json"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: (timeoutSec + 30) * 1000,
    });
    const openResult = r.stdout?.trim();
    steps.push({ step: "vscode-open", raw: openResult, status: r.status });

    // Re-probe
    ({ ok: bridgeUp } = probeHubBridge());
    steps.push({ step: "reprobe-local", ok: bridgeUp });
  } else {
    // Step 3 (Desk): SSH vscode-open + wait-bridge
    log("Opening Hub VS Code via SSH …");
    const vscodeResult = await sshRun(`bash scripts/hub-vscode-open-remote.sh open ${timeoutSec}`, timeoutSec + 30);
    steps.push({ step: "vscode-open", ...vscodeResult });

    // Step 4: SSH restart-bridge (code --command gotchibotBridge.restart)
    if (!bridgeUp) {
      log("Attempting SSH restart-bridge …");
      const restartResult = await sshRestartBridge(timeoutSec);
      steps.push({ step: "restart-bridge", ...restartResult });
      if (restartResult.ok) log("  ✓ restart-bridge sent");
      else err(`  ✗ restart-bridge failed: ${restartResult.error || restartResult.stderr}`);
    }
  }

  // Step 5: Final re-probe
  log("Re-probing Hub bridge …");
  ({ ok: bridgeUp } = probeHubBridge());
  steps.push({ step: "reprobe", ok: bridgeUp });

  const result = { ok: bridgeUp, receiver: receiverOk, bridgeUrl, steps };
  if (bridgeUp) {
    if (jsonOut) console.log(JSON.stringify(result));
    else log("✓ Hub bridge :45678 now up");
    process.exit(0);
  }

  // Failed — clear next steps for Julius
  const nextStep = [
    "Bridge still down after recovery attempts.",
    "",
    "On Hub (iMac), check:",
    "  1. VS Code is open on the GotchiBot folder",
    "  2. Extension 'gotchibot-bridge' is enabled (Extensions panel)",
    "  3. Claude is signed in (Claude pane visible)",
    "  4. Try: View → Command Palette → gotchibotBridge.restart",
    "",
    `Or from Desk:  abra run gotchibot -- ./scripts/gotchibot vscode-open`,
  ].join("\n");
  result.nextStep = nextStep;

  if (jsonOut) {
    console.log(JSON.stringify(result));
  } else {
    err(nextStep);
  }
  process.exit(1);
}

/** SSH helper for non-restart steps (uses remote-lib). */
async function sshRun(remoteCmd, timeout) {
  try {
    const { assertRemoteReady, materializeKey, runSsh } = await import("./remote-lib.mjs");
    const cfg = assertRemoteReady();
    const mat = materializeKey(cfg.key);
    try {
      const r = runSsh(cfg, mat.path, remoteCmd, {
        stdio: "pipe",
        timeout: (timeout || 60) * 1000,
      });
      return { ok: r.status === 0, raw: String(r.stdout || "").trim(), stderr: String(r.stderr || "").trim() };
    } finally {
      mat.dispose();
    }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

await main();
