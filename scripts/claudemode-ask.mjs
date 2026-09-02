#!/usr/bin/env node
/**
 * Ask Hub VS Code Claude (gotchibot bridge) and print only the reply.
 * Orchestrator stays on big-pickle; this is a tool call, not a model switch.
 *
 *   node scripts/claudemode-ask.mjs "What should we do about X?"
 *   abra run gotchibot -- node ./scripts/claudemode-ask.mjs "…"
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE = join(ROOT, "scripts/bridge-prompt.mjs");

const args = process.argv.slice(2);
if (!args.length || args[0] === "-h" || args[0] === "--help") {
  console.error(`usage: claudemode-ask.mjs [--timeout SEC] <prompt…>
  Relays to Hub Claude pane via bridge; prints reply only. Stay on big-pickle.`);
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
const inDocker =
  env.GOTCHIBOT_IN_DOCKER === "1" ||
  spawnSync("test", ["-f", "/.dockerenv"], { encoding: "utf8" }).status === 0;
if (inDocker) {
  env.GOTCHIBOT_BRIDGE_URL =
    env.GOTCHIBOT_BRIDGE_URL || "http://host.docker.internal:45678/prompt";
  env.GOTCHIBOT_RECEIVER_URL =
    env.GOTCHIBOT_RECEIVER_URL || "http://100.107.115.39:45679";
}
const hostMode =
  env.GOTCHIBOT_CLAUDE_HOST ||
  (inDocker || env.GOTCHIBOT_BRIDGE_URL ? "local" : "imac");
const useAbra =
  !inDocker &&
  !(env.SSH_PRIVATE_KEY && env.REMOTE_HOST) &&
  spawnSync("which", ["abra"], { encoding: "utf8" }).status === 0;

const bridgeArgs = ["--host", hostMode, "--wait", "--timeout", timeout, prompt];
const cmd = useAbra ? "abra" : process.execPath;
const finalArgs = useAbra
  ? ["run", "gotchibot", "--", "node", BRIDGE, ...bridgeArgs]
  : [BRIDGE, ...bridgeArgs];

const r = spawnSync(cmd, finalArgs, {
  cwd: ROOT,
  encoding: "utf8",
  env,
  timeout: (Number(timeout) + 60) * 1000,
  maxBuffer: 10 * 1024 * 1024,
});

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
      return true;
    })
    .join("\n")
    .trim();

const out = strip(r.stdout) || strip(r.stderr);
if (r.status !== 0) {
  console.error(out || `claudemode-ask failed (exit ${r.status})`);
  process.exit(r.status || 1);
}
if (!out) {
  console.error("empty reply from Hub Claude");
  process.exit(1);
}
process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
