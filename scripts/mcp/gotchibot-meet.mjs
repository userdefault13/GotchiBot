#!/usr/bin/env node
/**
 * MCP: meeting morning-recap + Colabo (gotchibot-meet).
 */
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const MEET = join(ROOT, "scripts/gotchi-meet.mjs");

function sendJson(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function reply(id, result) {
  sendJson({ jsonrpc: "2.0", id, result });
}
function replyError(id, code, message) {
  sendJson({ jsonrpc: "2.0", id, error: { code, message } });
}

function runMeet(argv) {
  const r = spawnSync(process.execPath, [MEET, ...argv], {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
    timeout: 600_000,
    maxBuffer: 12 * 1024 * 1024,
  });
  const out = String(r.stdout || "").trim();
  const err = String(r.stderr || "").trim();
  if (r.status !== 0) throw new Error(err || out || `meet exit ${r.status}`);
  return out || "(ok)";
}

const TOOLS = [
  {
    name: "meet_status",
    description: "Current GotchiBot meeting status (id, topic, kind, participants).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "meet_start_morning",
    description: "Start a morning-recap meeting (kind=morning-recap). Then invite + morning_collect.",
    inputSchema: {
      type: "object",
      properties: { topic: { type: "string" } },
    },
  },
  {
    name: "meet_morning_tasks",
    description: "List morning-recap checklist tasks (optional hero override from config/morning-recap.json).",
    inputSchema: {
      type: "object",
      properties: { hero: { type: "string" } },
    },
  },
  {
    name: "meet_morning_collect",
    description: "Wake all meeting agents to run morning recap scripts and collect reports.",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", enum: ["imac", "local", "auto"] },
        timeout: { type: "number" },
      },
    },
  },
  {
    name: "meet_morning_present",
    description: "Chair presents the current agent's morning recap in the transcript.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "meet_morning_next",
    description: "After Q&A, advance to the next agent (or goals-ready when done).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "meet_colabo",
    description: "Colabo: broadcast one prompt to every agent in the open meeting; post all replies.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        timeout: { type: "number" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "meet_end",
    description: "End meeting; write minutes.md + handoff.md (big-pickle + Claude-as-tool checklist).",
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
      serverInfo: { name: "gotchibot-meet", version: "1.0.0" },
    });
  }
  if (method === "notifications/initialized" || method === "initialized") return;
  if (method === "tools/list") return reply(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      let text;
      if (name === "meet_status") text = runMeet(["status", "--json"]);
      else if (name === "meet_start_morning") {
        text = runMeet([
          "start",
          "--morning",
          String(args.topic || "Morning recap"),
        ]);
      } else if (name === "meet_morning_tasks") {
        const argv = ["morning", "tasks", "--json"];
        if (args.hero) argv.push("--hero", String(args.hero));
        text = runMeet(argv);
      } else if (name === "meet_morning_collect") {
        const argv = ["morning", "collect"];
        if (args.host) argv.push("--host", String(args.host));
        if (args.timeout != null) argv.push("--timeout", String(args.timeout));
        text = runMeet(argv);
      } else if (name === "meet_morning_present") text = runMeet(["morning", "present"]);
      else if (name === "meet_morning_next") text = runMeet(["morning", "next"]);
      else if (name === "meet_colabo") {
        const argv = ["colabo", String(args.prompt || "")];
        if (args.timeout != null) argv.push("--timeout", String(args.timeout));
        text = runMeet(argv);
      } else if (name === "meet_end") text = runMeet(["end"]);
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
