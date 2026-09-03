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
  {
    name: "hub_bridge_ensure",
    description:
      "Ensure Hub VS Code Claude bridge is up (open workspace, restart bridge server, verify :45678). Call when claude_ask / bridge fails with connection refused or receiver/bridge down. Weak-model safe.",
    inputSchema: {
      type: "object",
      properties: {
        timeout: { type: "number", description: "Seconds to wait for bridge (default 45)" },
      },
    },
  },
  {
    name: "hub_bridge_info",
    description:
      "Return Hub gotchibot-bridge paths/config for weak models. Use when looking for globalStorage, extension config, listenHost, or where Claude bridge stores state. There is NO globalStorage/local.gotchibot-bridge folder.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "hub_claude_pane_init",
    description:
      "Ensure Hub GotchiBot Claude pane proxy identity (CLAUDE.md + .claude/agents/gotchibot-proxy.md). Call on cold/new VS Code Claude pane, create-agent, or when Claude has no GotchiBot role. Weak-model safe — do not invent identity.",
    inputSchema: {
      type: "object",
      properties: {
        check: {
          type: "boolean",
          description: "If true, only verify files exist (no write)",
        },
      },
    },
  },
  {
    name: "hub_monitor",
    description:
      "Hub dashboard / agent truth board (OpenClaw gateway + VS Code bridge + Claude jobs + sessions). Use when Desk shows agents running but Hub Claude panes are idle.",
    inputSchema: {
      type: "object",
      properties: {
        open: {
          type: "boolean",
          description: "If true, create/attach gotchibot-hubmon tmux session",
        },
        dashboard: {
          type: "boolean",
          description: "If true, return OpenClaw+bridge dashboard only",
        },
      },
    },
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
      else if (name === "hub_bridge_ensure") {
        const t = args.timeout || 45;
        text = runOps("bridge-ensure", ["--timeout", String(t)]);
      }
      else if (name === "hub_bridge_info") text = runOps("bridge-info", ["--json"]);
      else if (name === "hub_claude_pane_init") {
        const extra = args.check ? ["--check"] : [];
        text = runOps("claude-pane-init", extra);
      } else if (name === "hub_monitor") {
        const mon = join(ROOT, "scripts/hub-agent-monitor.mjs");
        const argv = args.open
          ? ["open", "--force"]
          : args.dashboard
            ? ["dashboard", "--json"]
            : ["snapshot", "--json"];
        const r = spawnSync(process.execPath, [mon, ...argv], {
          cwd: ROOT,
          encoding: "utf8",
          env: process.env,
          timeout: 30_000,
          maxBuffer: 4 * 1024 * 1024,
        });
        text = String(r.stdout || "").trim() || String(r.stderr || "").trim();
        if (r.status !== 0) throw new Error(text || `hub_monitor exit ${r.status}`);
      } else return replyError(id, -32601, `unknown tool: ${name}`);
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
