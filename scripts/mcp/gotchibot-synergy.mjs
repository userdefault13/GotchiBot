#!/usr/bin/env node
/**
 * MCP: Roster synergy tools (list / focus / chat).
 * Pair with skill `.opencode/skills/synergy/SKILL.md`.
 */
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const FOCUS = join(ROOT, "scripts/agent-focus.mjs");

function sendJson(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function reply(id, result) {
  sendJson({ jsonrpc: "2.0", id, result });
}
function replyError(id, code, message) {
  sendJson({ jsonrpc: "2.0", id, error: { code, message } });
}

function runFocus(argv) {
  const env = { ...process.env };
  const useAbra =
    !(env.SSH_PRIVATE_KEY && env.REMOTE_HOST) &&
    spawnSync("which", ["abra"], { encoding: "utf8" }).status === 0;
  const cmd = useAbra ? "abra" : process.execPath;
  const args = useAbra
    ? ["run", "gotchibot", "--", "node", FOCUS, ...argv]
    : [FOCUS, ...argv];
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    env,
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const out = String(r.stdout || "").trim();
  const err = String(r.stderr || "").trim();
  if (r.status !== 0) throw new Error(err || out || `agent-focus exit ${r.status}`);
  return out
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^▸/.test(l) && !/^injecting /i.test(l))
    .join("\n");
}

const TOOLS = [
  {
    name: "roster_list",
    description:
      "List GotchiBot roster (cartridge heroes + sessions). Use for who is available / busy.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "roster_status",
    description: "Current ORCH/SUB focus (who Julius is talking to).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "roster_select",
    description:
      "Pin avatar + SUB-focus a hero (direct chat). Pass hero id e.g. owned-22899 or starter-link-h1-1.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Hero id or list index" },
      },
      required: ["id"],
    },
  },
  {
    name: "roster_orch",
    description: "Return focus to the orchestrator (owned-954 / gotchi).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "roster_chat",
    description:
      "Send a prompt to the focused SUB hero (or escalate to orch if classifier says so). Load skill synergy for norms.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Message for the focused agent" },
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
      serverInfo: { name: "gotchibot-synergy", version: "1.0.0" },
    });
  }
  if (method === "notifications/initialized" || method === "initialized") return;
  if (method === "tools/list") return reply(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      let text;
      if (name === "roster_list") text = runFocus(["list", "--json"]);
      else if (name === "roster_status") text = runFocus(["status", "--json"]);
      else if (name === "roster_select") {
        const hero = String(args.id || "").trim();
        if (!hero) throw new Error("id required");
        text = runFocus(["select", hero]);
      } else if (name === "roster_orch") text = runFocus(["orch"]);
      else if (name === "roster_chat") {
        const prompt = String(args.prompt || "").trim();
        if (!prompt) throw new Error("prompt required");
        text = runFocus(["chat", prompt]);
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
