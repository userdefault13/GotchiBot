#!/usr/bin/env node
/**
 * MCP: Claude Code via Hub bridge.
 *   claude_ask     — sync wait (short prompts)
 *   claude_submit  — async pending id (preferred for long work)
 *   claude_collect — read ready job by id (after push-wake)
 *   claude_jobs    — list pending/ready jobs
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
import { collectJob, listJobs } from "../claude-jobs.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const ASK = join(ROOT, "scripts/claudemode-ask.mjs");
const SUBMIT = join(ROOT, "scripts/claudemode-submit.mjs");

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

function bridgeEnv() {
  const env = { ...process.env };
  if (inDocker()) {
    env.GOTCHIBOT_BRIDGE_URL =
      env.GOTCHIBOT_BRIDGE_URL || "http://host.docker.internal:45678/prompt";
    env.GOTCHIBOT_RECEIVER_URL =
      env.GOTCHIBOT_RECEIVER_URL || "http://100.107.115.39:45679";
    env.GOTCHIBOT_CLAUDE_HOST = env.GOTCHIBOT_CLAUDE_HOST || "local";
    delete env.SSH_PRIVATE_KEY;
  } else {
    env.GOTCHIBOT_BRIDGE_URL = env.GOTCHIBOT_BRIDGE_URL || hubBridgeHttpUrl();
    env.GOTCHIBOT_CLAUDE_HOST = env.GOTCHIBOT_CLAUDE_HOST || resolveClaudeHostMode();
  }
  return env;
}

function askClaude(prompt, timeoutSec = 300) {
  const r = spawnSync(process.execPath, [ASK, "--timeout", String(timeoutSec), prompt], {
    cwd: ROOT,
    encoding: "utf8",
    env: bridgeEnv(),
    timeout: (Number(timeoutSec) + 60) * 1000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const out = String(r.stdout || "").trim();
  const err = String(r.stderr || "").trim();
  if (r.status !== 0) throw new Error(err || out || `claude_ask exit ${r.status}`);
  return out
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^▸/.test(l) && !/^injecting /i.test(l))
    .join("\n")
    .trim() || out;
}

function submitClaude(prompt) {
  const r = spawnSync(process.execPath, [SUBMIT, "--json", prompt], {
    cwd: ROOT,
    encoding: "utf8",
    env: bridgeEnv(),
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const out = String(r.stdout || "").trim();
  const err = String(r.stderr || "").trim();
  if (r.status !== 0) throw new Error(err || out || `claude_submit exit ${r.status}`);
  return out;
}

const TOOLS = [
  {
    name: "claude_submit",
    description:
      "PREFERRED for long Claude work. Fire-and-forget Hub Claude. Returns {id,status:pending} immediately — do NOT wait/poll. Hub ALWAYS opens VS Code Claude pane first then Terminal fallback AND headless claude -p for Desk text (never say headless-only). When wake says ready: claude_collect.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Instruction for Hub Claude Code" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "claude_collect",
    description:
      "Collect a finished async Claude job by id (after push-wake). Returns Claude text. If still pending, do not poll — wait for wake. Pane+terminal UI already ran on Hub at submit time.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Job id from claude_submit" },
      },
      required: ["id"],
    },
  },
  {
    name: "claude_jobs",
    description: "List async Claude jobs (pending/ready/failed/collected).",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description: "Optional filter: pending|ready|failed|collected",
        },
      },
    },
  },
  {
    name: "claude_ask",
    description:
      "Sync Claude ask (blocks). Short prompts only. Long work: claude_submit. Hub policy: Claude pane first → Terminal fallback → plus headless for Desk text. Never say no-chat/headless-only. When Julius asks if you have the Claude tool: YES.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        timeout: { type: "number", description: "Seconds (default 300)" },
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
      serverInfo: { name: "gotchibot-claude", version: "1.1.0" },
    });
  }
  if (method === "notifications/initialized" || method === "initialized") return;
  if (method === "tools/list") return reply(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      let text;
      if (name === "claude_submit") {
        const prompt = String(args.prompt || "").trim();
        if (!prompt) return replyError(id, -32602, "prompt required");
        text = submitClaude(prompt);
      } else if (name === "claude_collect") {
        const jobId = String(args.id || "").trim();
        if (!jobId) return replyError(id, -32602, "id required");
        const r = collectJob(jobId);
        if (r.status === "pending") {
          text = JSON.stringify(r);
        } else if (r.status === "missing") {
          text = JSON.stringify(r);
        } else if (r.response != null) {
          text = String(r.response);
          if (!r.ok) text = `ERROR: ${text}`;
        } else {
          text = JSON.stringify(r);
        }
      } else if (name === "claude_jobs") {
        text = JSON.stringify(listJobs({ status: args.status }), null, 2);
      } else if (name === "claude_ask") {
        const prompt = String(args.prompt || "").trim();
        if (!prompt) return replyError(id, -32602, "prompt required");
        text = askClaude(prompt, args.timeout || 300);
      } else {
        return replyError(id, -32601, `unknown tool: ${name}`);
      }
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
