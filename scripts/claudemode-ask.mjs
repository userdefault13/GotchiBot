#!/usr/bin/env node
/**
 * Ask Hub VS Code Claude (gotchibot bridge) and print only the reply.
 * Orchestrator stays on big-pickle; this is a tool call, not a model switch.
 *
 * Remote desks on Tailscale/LAN ALWAYS use the Hub bridge (network HTTP → SSH).
 * Hub uses local :45678. Never nest abra from headless (Touch ID fails).
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hubBridgeHttpUrl,
  isHubMachine,
  inDocker,
  resolveClaudeHostMode,
} from "./claude-bridge-role.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE = join(ROOT, "scripts/bridge-prompt.mjs");
const OPEN = join(ROOT, "scripts/hub-vscode-open.mjs");
const ENSURE = join(ROOT, "scripts/hub-bridge-ensure.mjs");

const args = process.argv.slice(2);
if (!args.length || args[0] === "-h" || args[0] === "--help") {
  console.error(`usage: claudemode-ask.mjs [--timeout SEC] <prompt…>
  Desk → Hub bridge always. Sub-agents: node ./scripts/claudemode-ask.mjs (no abra).`);
  process.exit(args.length ? 0 : 2);
}

let timeout = "300";
const promptParts = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--timeout") timeout = args[++i] || timeout;
  else promptParts.push(args[i]);
}
const prompt = promptParts.join(" ").trim();
if (!prompt) {
  console.error("missing prompt");
  process.exit(2);
}

const env = { ...process.env };
const docker = inDocker();
const hub = isHubMachine();

env.GOTCHIBOT_BRIDGE_URL = env.GOTCHIBOT_BRIDGE_URL || hubBridgeHttpUrl();
if (docker && !env.GOTCHIBOT_RECEIVER_URL) {
  env.GOTCHIBOT_RECEIVER_URL = "http://100.107.115.39:45679";
}

const hostMode = resolveClaudeHostMode(env.GOTCHIBOT_CLAUDE_HOST);

const interactive =
  Boolean(process.stdin.isTTY && process.stdout.isTTY) &&
  env.GOTCHIBOT_HEADLESS !== "1" &&
  env.CI !== "true";

// Desk network path needs no abra. SSH fallback may need secrets — only abra when interactive Desk + ssh mode.
const useAbra =
  interactive &&
  !docker &&
  !hub &&
  hostMode === "imac" &&
  !(env.SSH_PRIVATE_KEY && env.REMOTE_HOST) &&
  env.GOTCHIBOT_NO_ABRA !== "1" &&
  spawnSync("which", ["abra"], { encoding: "utf8" }).status === 0;

const bridgeArgs = ["--host", hostMode, "--wait", "--timeout", timeout, prompt];
const cmd = useAbra ? "abra" : process.execPath;
const finalArgs = useAbra
  ? ["run", "gotchibot", "--", "node", BRIDGE, ...bridgeArgs]
  : [BRIDGE, ...bridgeArgs];

function runBridge() {
  return spawnSync(cmd, finalArgs, {
    cwd: ROOT,
    encoding: "utf8",
    env,
    timeout: (Number(timeout) + 60) * 1000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function ensureHubBridge() {
  // Prefer one-shot ensure (receiver + open + restart-bridge). Fall back to vscode-open.
  const ensureArgs = ["--timeout", "45"];
  const ensure = spawnSync(process.execPath, [ENSURE, ...ensureArgs], {
    cwd: ROOT,
    encoding: "utf8",
    env,
    timeout: 120_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (ensure.status === 0) return;
  if (docker || hub) return;
  const openCmd = useAbra ? "abra" : process.execPath;
  const openArgs = useAbra
    ? ["run", "gotchibot", "--", "node", OPEN, "--timeout", "45"]
    : [OPEN, "--timeout", "45"];
  spawnSync(openCmd, openArgs, {
    cwd: ROOT,
    encoding: "utf8",
    env,
    timeout: 90_000,
    maxBuffer: 2 * 1024 * 1024,
  });
}

const strip = (s) =>
  String(s || "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""))
    .filter((l) => {
      const t = l.trim();
      if (!t) return false;
      if (/^▸/.test(t)) return false;
      if (/^injecting \d+ var/i.test(t)) return false;
      if (/^accepted id=/i.test(t)) return false;
      if (/^waiting up to /i.test(t)) return false;
      if (/SecKeychain|User interaction is not allowed/i.test(t)) return false;
      return true;
    })
    .join("\n")
    .trim();

let r = runBridge();
if (r.status !== 0) {
  // Weak-model path: revive Hub VS Code bridge + Desk receiver, then retry once.
  ensureHubBridge();
  r = runBridge();
}

let out = strip(r.stdout) || strip(r.stderr);
if (r.status !== 0) {
  const raw = String(r.stderr || r.stdout || "");
  if (useAbra || /SecKeychain|User interaction is not allowed/i.test(raw)) {
    const retry = spawnSync(
      process.execPath,
      [BRIDGE, "--host", "network", "--wait", "--timeout", timeout, prompt],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...env, GOTCHIBOT_CLAUDE_HOST: "network" },
        timeout: (Number(timeout) + 60) * 1000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    out = strip(retry.stdout) || strip(retry.stderr);
    if (retry.status === 0 && out) {
      process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
      process.exit(0);
    }
  }
  console.error(
    out ||
      raw.trim() ||
      `claudemode-ask failed (exit ${r.status}). Desk→Hub bridge: need VS Code bridge on ${hubBridgeHttpUrl()}.`,
  );
  process.exit(r.status || 1);
}
if (!out) {
  console.error("empty reply from Hub Claude");
  process.exit(1);
}
process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
