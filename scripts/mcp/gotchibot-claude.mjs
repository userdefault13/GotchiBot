#!/usr/bin/env node
/**
 * MCP server: tool `claude_ask` — Hub VS Code Claude Code via gotchibot bridge.
 *
 * Desk Gotchi (OpenClaw in Docker) needs a *named* tool; Bash-only instructions
 * are ignored by big-pickle ("I don't have the Claude tool").
 *
 * Wire-up:
 *   opencode.json → mcp.gotchibot-claude
 *   ~/.openclaw/openclaw.json → mcp.servers.gotchibot-claude
 */
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hubBridgeHttpUrl,
  resolveClaudeHostMode,
} from "../claude-bridge-role.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const ASK = join(ROOT, "scripts/claudemode-ask.mjs");

function sendJson(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id, result) {
  sendJson({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  sendJson({ jsonrpc: "2.0", id, error: { code, message } });
}

function inDocker() {
  return existsSync("/.dockerenv") || process.env.GOTCHIBOT_IN_DOCKER === "1";
}

function askClaude(prompt, timeoutSec = 300) {
  const env = { ...process.env };
  if (inDocker()) {
    // OpenClaw gateway container → host VS Code bridge + Desk Tailscale receiver
    env.GOTCHIBOT_BRIDGE_URL =
      env.GOTCHIBOT_BRIDGE_URL || "http://host.docker.internal:45678/prompt";
    env.GOTCHIBOT_RECEIVER_URL =
      env.GOTCHIBOT_RECEIVER_URL || "http://100.107.115.39:45679";
    env.GOTCHIBOT_CLAUDE_HOST = env.GOTCHIBOT_CLAUDE_HOST || "local";
    delete env.SSH_PRIVATE_KEY;
  } else {
    // Desk: network → Hub bridge. Hub: local :45678.
    env.GOTCHIBOT_BRIDGE_URL = env.GOTCHIBOT_BRIDGE_URL || hubBridgeHttpUrl();
    env.GOTCHIBOT_CLAUDE_HOST = env.GOTCHIBOT_CLAUDE_HOST || resolveClaudeHostMode();
  }

  const r = spawnSync(process.execPath, [ASK, "--timeout", String(timeoutSec), prompt], {
    cwd: ROOT,
    encoding: "utf8",
    env,
    timeout: (Number(timeoutSec) + 60) * 1000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const out = String(r.stdout || "").trim();
  const err = String(r.stderr || "").trim();
  if (r.status !== 0) {
    throw new Error(err || out || `claude_ask exit ${r.status}`);
  }
  const lines = out
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^▸/.test(l) && !/^injecting /i.test(l));
  return lines.join("\n").trim() || out;
}

const TOOLS = [
  {
    name: "claude_ask",
    description:
      "Claude Code tool (YOU HAVE THIS). Ask Hub iMac VS Code Claude Code in the live pane session. Orchestrator stays on big-pickle. Use for hard logic, then continue the task. When Julius asks if you have the Claude tool / @claudemode: answer YES and use this tool.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Question or instruction for Claude Code on the Hub",
        },
        timeout: {
          type: "number",
          description: "Seconds to wait (default 300)",
        },
      },
      required: ["prompt"],
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
      serverInfo: { name: "gotchibot-claude", version: "1.0.0" },
    });
  }
  if (method === "notifications/initialized" || method === "initialized") return;
  if (method === "tools/list") return reply(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    if (name !== "claude_ask") return replyError(id, -32601, `unknown tool: ${name}`);
    const prompt = String(args.prompt || "").trim();
    if (!prompt) return replyError(id, -32602, "prompt required");
    try {
      const text = askClaude(prompt, args.timeout || 300);
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
    /* ignore parse errors */
  }
});
