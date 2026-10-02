#!/usr/bin/env node
/**
 * Read-only stdio MCP server for GotchiBot hub status.
 *
 * Start (cwd = GotchiBot checkout that holds sessions/):
 *   node mcp-servers/hub-status/stdio.mjs
 *
 * No writes. No SSH. No network.
 */
import { readHubSnapshot, gatewayCheckWouldRun } from "./hub-status-lib.mjs";

const SERVER = { name: "gotchibot-hub-status", version: "0.1.0" };

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
];

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function toolText(data) {
  return { content: [{ type: "text", text: JSON.stringify(data) }], isError: false };
}

function callTool(name) {
  if (name === "hub_status") return toolText(readHubSnapshot());
  if (name === "openclaw_gateway_check_would_run") return toolText(gatewayCheckWouldRun());
  return {
    content: [{ type: "text", text: JSON.stringify({ error: "unknown tool" }) }],
    isError: true,
  };
}

function handle(msg) {
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
    send({ jsonrpc: "2.0", id, result: callTool(params?.name) });
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
