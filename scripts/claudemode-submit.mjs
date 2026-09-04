#!/usr/bin/env node
/**
 * Fire-and-forget Hub Claude submit — returns job id immediately (no wait/poll).
 *
 *   node scripts/claudemode-submit.mjs "…"
 *   abra run gotchibot -- node scripts/claudemode-submit.mjs --json "…"
 */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hubBridgeHttpUrl,
  isHubMachine,
  inDocker,
  resolveClaudeHostMode,
  hubReceiverUrl,
} from "./claude-bridge-role.mjs";
import { createPending, markFailed } from "./claude-jobs.mjs";
import { prefixProxyPrompt, runPaneInit } from "./claude-pane-init.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE = join(ROOT, "scripts/bridge-prompt.mjs");

const args = process.argv.slice(2);
if (!args.length || args[0] === "-h" || args[0] === "--help") {
  console.error(`usage: claudemode-submit.mjs [--json] [--id <id>] <prompt…>
  Submits to Hub Claude bridge and returns {id,status:pending} immediately.`);
  process.exit(args.length ? 0 : 2);
}

let jsonOut = false;
let id = `gb-${randomUUID().slice(0, 8)}`;
const promptParts = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--json") jsonOut = true;
  else if (args[i] === "--id") id = args[++i] || id;
  else promptParts.push(args[i]);
}
const rawPrompt = promptParts.join(" ").trim();
if (!rawPrompt) {
  console.error("missing prompt");
  process.exit(2);
}

const env = { ...process.env };
env.GOTCHIBOT_BRIDGE_URL = env.GOTCHIBOT_BRIDGE_URL || hubBridgeHttpUrl();
env.GOTCHIBOT_CLAUDE_JOB_ID = id;
if (inDocker() && !env.GOTCHIBOT_RECEIVER_URL) {
  env.GOTCHIBOT_RECEIVER_URL = hubReceiverUrl();
}
const hostMode = resolveClaudeHostMode(env.GOTCHIBOT_CLAUDE_HOST);

try {
  runPaneInit({});
} catch {
  /* non-fatal on Desk if templates missing — Hub workspace may still have files */
}

const prompt = prefixProxyPrompt(rawPrompt, {
  jobId: id,
  includeInit: process.env.GOTCHIBOT_CLAUDE_PANE_INIT !== "0",
});

createPending({
  id,
  prompt: rawPrompt,
  meta: {
    hostMode,
    bridgeUrl: env.GOTCHIBOT_BRIDGE_URL,
    role: isHubMachine() ? "hub" : "desk",
    reportsTo: process.env.GOTCHIBOT_HERO_ID || "owned-954",
  },
});

const r = spawnSync(
  process.execPath,
  [BRIDGE, "--host", hostMode, "--no-wait", "--json", "--id", id, prompt],
  {
    cwd: ROOT,
    encoding: "utf8",
    env,
    timeout: 45_000,
    maxBuffer: 2 * 1024 * 1024,
  },
);

const stdout = String(r.stdout || "").trim();
const stderr = String(r.stderr || "").trim();
if (r.status !== 0) {
  markFailed(id, stderr || stdout || `submit exit ${r.status}`);
  const err = {
    ok: false,
    id,
    status: "failed",
    error: stderr || stdout || `bridge submit failed (exit ${r.status})`,
  };
  console.log(JSON.stringify(err, null, jsonOut ? 0 : 2));
  process.exit(1);
}

let accepted = null;
try {
  accepted = JSON.parse(stdout.split(/\r?\n/).filter(Boolean).pop() || "{}");
} catch {
  accepted = { raw: stdout };
}

const out = {
  ok: true,
  id,
  status: "pending",
  host: accepted?.host || hostMode,
  accepted,
  hint: `When wake arrives (or job ready): MCP claude_collect {\"id\":\"${id}\"} or ./scripts/gotchibot claude-collect ${id}`,
};
console.log(JSON.stringify(out, null, jsonOut ? 0 : 2));
