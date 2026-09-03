#!/usr/bin/env node
/**
 * MCP: agent-sized PDF tools (gotchibot-pdf).
 * pdf_check | pdf_info | pdf_search | pdf_read_pages | pdf_tables | pdf_chunks | pdf_render
 * Pages are 1-indexed.
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

function pagesArg(pages) {
  if (Array.isArray(pages)) return pages.join(",");
  if (pages == null) return null;
  return String(pages);
}

const TOOLS = [
  {
    name: "pdf_check",
    description: "Verify PyMuPDF is available in GotchiBot .venv-pdf.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "pdf_info",
    description:
      "PDF classify/metadata: pages, title, TOC, scanned flag. Prefer before read.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Path to .pdf" } },
      required: ["path"],
    },
  },
  {
    name: "pdf_search",
    description: "Search PDF text; returns 1-based page hits + short snippets + bbox.",
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
  {
    name: "pdf_read_pages",
    description:
      "Extract structured text/markdown for specific 1-indexed pages. Caps output (~12k tokens); truncated:true means request fewer pages.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        pages: {
          type: "array",
          items: { type: "integer" },
          description: "1-indexed page numbers, e.g. [3,4,5]",
        },
        format: { type: "string", enum: ["markdown", "text"], description: "default markdown" },
        max_tokens: { type: "number", description: "Output cap (default 12000)" },
      },
      required: ["path", "pages"],
    },
  },
  {
    name: "pdf_tables",
    description: "Extract tables from one 1-indexed page as markdown + JSON rows.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        page: { type: "integer", description: "1-indexed page" },
      },
      required: ["path", "page"],
    },
  },
  {
    name: "pdf_chunks",
    description:
      "Heading-aware RAG chunks (~400–800 tokens, overlap) with page/section/type/token_estimate.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        pages: {
          type: "string",
          description: "Optional 1-based filter e.g. 1-10 or 3,4,5",
        },
        max_tokens: { type: "number" },
      },
      required: ["path"],
    },
  },
  {
    name: "pdf_render",
    description: "Render one 1-indexed PDF page to PNG (visual verify / grounding).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        out: { type: "string", description: "Output .png under allowWriteRoots" },
        page: { type: "number", description: "1-indexed page (default 1)" },
        dpi: { type: "number", description: "DPI (default 144)" },
      },
      required: ["path", "out"],
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
      serverInfo: { name: "gotchibot-pdf", version: "2.0.0" },
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
      else if (name === "pdf_search") {
        const argv = ["search", String(args.path || ""), String(args.query || "")];
        if (args.max_hits != null) argv.push("--max-hits", String(args.max_hits));
        text = runPdf(argv);
      } else if (name === "pdf_read_pages" || name === "pdf_text") {
        const argv = ["read-pages", String(args.path || "")];
        const p = pagesArg(args.pages);
        if (p) argv.push("--pages", p);
        if (args.format) argv.push("--format", String(args.format));
        if (args.max_tokens != null) argv.push("--max-tokens", String(args.max_tokens));
        text = runPdf(argv);
      } else if (name === "pdf_tables") {
        text = runPdf([
          "tables",
          String(args.path || ""),
          "--page",
          String(args.page ?? 1),
        ]);
      } else if (name === "pdf_chunks") {
        const argv = ["chunks", String(args.path || "")];
        if (args.pages) argv.push("--pages", String(args.pages));
        if (args.max_tokens != null) argv.push("--max-tokens", String(args.max_tokens));
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
