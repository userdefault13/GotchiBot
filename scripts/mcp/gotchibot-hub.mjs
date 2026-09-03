#!/usr/bin/env node
/**
 * MCP: Hub SOP tools for weak models (status / restart OpenClaw / vscode / bridge).
 * Wired in opencode.json as mcp.gotchibot-hub. Load skill hub-sop for the full runbook.
 */
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const OPS = join(ROOT, "scripts/hub-ops.mjs");

function sendJson(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function reply(id, result) {
  sendJson({ jsonrpc: "2.0", id, result });
}
function replyError(id, code, message) {
  sendJson({ jsonrpc: "2.0", id, error: { code, message } });
}

function runOps(action, extra = []) {
  const env = { ...process.env };
  const useAbra =
    !(env.SSH_PRIVATE_KEY && env.REMOTE_HOST) &&
    spawnSync("which", ["abra"], { encoding: "utf8" }).status === 0;
  const cmd = useAbra ? "abra" : process.execPath;
  const args = useAbra
    ? ["run", "gotchibot", "--", "node", OPS, action, ...extra]
    : [OPS, action, ...extra];
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    env,
    timeout: 300_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const out = String(r.stdout || "").trim();
  const err = String(r.stderr || "").trim();
  if (r.status !== 0) throw new Error(err || out || `${action} exit ${r.status}`);
  return out
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^▸/.test(l) && !/^injecting /i.test(l))
    .join("\n");
}

const TOOLS = [
  {
    name: "hub_status",
    description: "Hub iMac status (OpenClaw OC✓/OC✗, Docker, tunnel). Use when Julius asks if gateway is down.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "hub_restart_gateway",
    description:
      "Restart Hub OpenClaw gateway remotely (compose recreate + wait healthz). Use when OC✗ / gateway-unreachable.",
    inputSchema: {
      type: "object",
      properties: {
        timeout: { type: "number", description: "Seconds to wait for healthz (default 90)" },
      },
    },
  },
  {
    name: "hub_vscode_open",
    description: "Open/focus Hub VS Code on GotchiBot folder so Claude bridge can run.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "hub_bridge_check",
    description: "Check Hub Claude bridge :45678 and Desk receiver :45679.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

function handle(msg) {
  if (!msg || typeof msg !== "object") return;
  const { id, method, params } = msg;
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "gotchibot-hub", version: "1.0.0" },
    });
  }
  if (method === "notifications/initialized" || method === "initialized") return;
  if (method === "tools/list") return reply(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      let text;
      if (name === "hub_status") text = runOps("status");
      else if (name === "hub_restart_gateway") {
        const t = args.timeout || 90;
        text = runOps("restart-gateway", ["--wait", "--timeout", String(t)]);
      } else if (name === "hub_vscode_open") text = runOps("vscode-open");
      else if (name === "hub_bridge_check") text = runOps("bridge-check");
      else return replyError(id, -32601, `unknown tool: ${name}`);
      return reply(id, { content: [{ type: "text", text }], isError: false });
    } catch (e) {
      return reply(id, {
        content: [{ type: "text", text: e?.message || String(e) }],
        isError: true,
      });
    }
  }
  if (method === "ping") return reply(id, {});
  if (id != null) return replyError(id, -32601, `method not found: ${method}`);
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t.startsWith("{")) return;
  try {
    handle(JSON.parse(t));
  } catch {
    /* ignore */
  }
});
