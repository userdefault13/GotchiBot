#!/usr/bin/env node
/**
 * Stdio MCP server for GotchiBot hub status and desk chat.
 *
 * Start (cwd = GotchiBot checkout that holds sessions/):
 *   node mcp-servers/hub-status/stdio.mjs
 *
 * hub_status and openclaw_gateway_check_would_run stay local: no SSH, no probe.
 * gotchibot_chat and gotchibot_handoff call the pinned Hub desk API
 * (X-GotchiBot-Desk-Token). They do not start a runner, bridge, or receiver,
 * and they do not touch chain, signing, or treasury routes.
 */
import { readHubSnapshot, gatewayCheckWouldRun } from "./hub-status-lib.mjs";
import { redactSecrets, talkToHub } from "./chat-lib.mjs";

const SERVER = { name: "gotchibot-hub-status", version: "0.2.0" };

const TOOLS = [
  {
    name: "hub_status",
    description:
      "Read sessions/.imac-status-cache.json and report Hub as ok, bad, or ? (unknown). Omits secrets. Does not refresh the snapshot.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "openclaw_gateway_check_would_run",
    description:
      "Whether the OpenClaw gateway check would be run, using hubHealthRoute and statusGatewayReachable's guards. Does not probe, SSH, or open a connection. wouldRun is null when the answer is unknown.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "gotchibot_chat",
    description:
      "Send a chat message to the GotchiBot hub (POST /api/gotchibot/chats/send) and return the assistant reply if the hub wrote one. Prove liveness with text ping. The hub has no separate ping RPC; the expected reply is the single word pong only when a phone-reply runner writes it. This tool does not invent pong and does not start the runner, bridge, or receiver. A desk-kind token is acknowledged with reply.status none and is not queued.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Message text. Use ping for the liveness check." },
        threadId: { type: "string", description: "Existing thread id. Omit to let the hub create one." },
        waitMs: {
          type: "number",
          description: "How long to wait for a queued phone reply (0-20000). Default 8000. Ignored when the hub does not queue a reply.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "gotchibot_handoff",
    description:
      "Hand a task to the GotchiBot hub on the same chats/send route, titled handoff, and return the hub acknowledgement plus an assistant reply if one was actually written. Does not start a worker. Acceptance alone is success when the runner is down.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task text to hand off." },
        threadId: { type: "string", description: "Existing thread id. Omit to let the hub create one." },
        waitMs: {
          type: "number",
          description: "How long to wait for a queued reply (0-20000). Default 0: return the hub ack without waiting.",
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
  },
];

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function toolText(data) {
  return { content: [{ type: "text", text: JSON.stringify(data) }], isError: false };
}

async function callTool(name, args = {}) {
  if (name === "hub_status") return toolText(readHubSnapshot());
  if (name === "openclaw_gateway_check_would_run") return toolText(gatewayCheckWouldRun());
  if (name === "gotchibot_chat" || name === "gotchibot_handoff") {
    const input = args && typeof args === "object" ? args : {};
    const data = await talkToHub({
      mode: name === "gotchibot_handoff" ? "handoff" : "chat",
      text: name === "gotchibot_handoff" ? input.task : input.text,
      threadId: input.threadId,
      waitMs: input.waitMs,
    });
    return toolText(data);
  }
  return {
    content: [{ type: "text", text: JSON.stringify({ error: "unknown tool" }) }],
    isError: true,
  };
}

async function handle(msg) {
  if (!msg || msg.jsonrpc !== "2.0" || msg.id === undefined || msg.id === null) return;
  const { id, method, params } = msg;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER,
      },
    });
    return;
  }
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }
  if (method === "tools/call") {
    try {
      const result = await callTool(params?.name, params?.arguments || {});
      send({ jsonrpc: "2.0", id, result });
    } catch (e) {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: redactSecrets(e?.message || e) }) }],
          isError: true,
        },
      });
    }
    return;
  }
  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  send({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `method not found: ${method}` },
  });
}

let buf = Buffer.alloc(0);

function takeLine() {
  const nl = buf.indexOf(0x0a);
  if (nl === -1) return null;
  const line = buf.subarray(0, nl).toString("utf8").replace(/\r$/, "");
  buf = buf.subarray(nl + 1);
  return line;
}

function drain() {
  while (buf.length) {
    const head = buf.toString("utf8", 0, Math.min(buf.length, 32));
    if (/^Content-Length:/i.test(head)) {
      const sep = buf.indexOf("\r\n\r\n");
      if (sep === -1) return;
      const header = buf.subarray(0, sep).toString("utf8");
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) {
        buf = buf.subarray(sep + 4);
        continue;
      }
      const len = Number(m[1]);
      const start = sep + 4;
      if (buf.length < start + len) return;
      const body = buf.subarray(start, start + len).toString("utf8");
      buf = buf.subarray(start + len);
      try {
        handle(JSON.parse(body));
      } catch {
        /* ignore malformed */
      }
      continue;
    }
    const line = takeLine();
    if (line === null) return;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      handle(JSON.parse(trimmed));
    } catch {
      /* ignore malformed */
    }
  }
}

process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  drain();
});
process.stdin.on("end", () => {
  setTimeout(() => process.exit(0), 30);
});
