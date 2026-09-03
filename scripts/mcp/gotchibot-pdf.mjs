#!/usr/bin/env node
/**
 * MCP: PyMuPDF tools for GotchiBot (pdf_check, pdf_info, pdf_text, pdf_render, pdf_search).
 */
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TOOL = join(ROOT, "scripts/pdf-tool.mjs");

function sendJson(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function reply(id, result) {
  sendJson({ jsonrpc: "2.0", id, result });
}
function replyError(id, code, message) {
  sendJson({ jsonrpc: "2.0", id, error: { code, message } });
}

function runPdf(argv) {
  const r = spawnSync(process.execPath, [TOOL, ...argv], {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
    timeout: 120_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  const out = String(r.stdout || "").trim();
  const err = String(r.stderr || "").trim();
  if (r.status !== 0) throw new Error(err || out || `pdf exit ${r.status}`);
  return out;
}

const TOOLS = [
  {
    name: "pdf_check",
    description: "Verify PyMuPDF (fitz) is available in GotchiBot .venv-pdf.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "pdf_info",
    description: "PDF metadata + page count via PyMuPDF. Path must be under allowlisted roots.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Path to .pdf" } },
      required: ["path"],
    },
  },
  {
    name: "pdf_text",
    description: "Extract text from a PDF (optional page list). Returns JSON with per-page text.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        pages: { type: "string", description: "0-based pages e.g. 0,2-4 (default all)" },
        max_chars: { type: "number", description: "Cap total characters (default 200000)" },
      },
      required: ["path"],
    },
  },
  {
    name: "pdf_render",
    description: "Render one PDF page to PNG via PyMuPDF.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        out: { type: "string", description: "Output .png path under allowWriteRoots" },
        page: { type: "number", description: "0-based page (default 0)" },
        dpi: { type: "number", description: "DPI (default 144)" },
      },
      required: ["path", "out"],
    },
  },
  {
    name: "pdf_search",
    description: "Search PDF text for a query; returns page + bbox hits.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        query: { type: "string" },
        max_hits: { type: "number" },
      },
      required: ["path", "query"],
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
      serverInfo: { name: "gotchibot-pdf", version: "1.0.0" },
    });
  }
  if (method === "notifications/initialized" || method === "initialized") return;
  if (method === "tools/list") return reply(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      let text;
      if (name === "pdf_check") text = runPdf(["check"]);
      else if (name === "pdf_info") text = runPdf(["info", String(args.path || "")]);
      else if (name === "pdf_text") {
        const argv = ["text", String(args.path || "")];
        if (args.pages) argv.push("--pages", String(args.pages));
        if (args.max_chars != null) argv.push("--max-chars", String(args.max_chars));
        text = runPdf(argv);
      } else if (name === "pdf_render") {
        const argv = [
          "render",
          String(args.path || ""),
          "--out",
          String(args.out || ""),
        ];
        if (args.page != null) argv.push("--page", String(args.page));
        if (args.dpi != null) argv.push("--dpi", String(args.dpi));
        text = runPdf(argv);
      } else if (name === "pdf_search") {
        const argv = ["search", String(args.path || ""), String(args.query || "")];
        if (args.max_hits != null) argv.push("--max-hits", String(args.max_hits));
        text = runPdf(argv);
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
