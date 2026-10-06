#!/usr/bin/env node
/**
 * Desk tools runner — `/local` in the chat runs Cursor, Codex or Claude Code on
 * THIS desk's CPU, while the prompt and reply stay in the (Hub) chat session.
 *
 * An OpenAI-compatible server on 127.0.0.1:45690. OpenCode reaches it as the
 * `desk` provider (opencode.json: desk/cursor, desk/codex, desk/claude); the
 * gotchi-local-tools plugin reroutes a chat's messages here while /local is on.
 * In a Hub chat the Hub's OpenCode calls it through the reverse tunnel the desk
 * opens on attach (hub-desk.mjs open: ssh -R 127.0.0.1:45690:127.0.0.1:45690).
 *
 *   node scripts/desk-tools.mjs serve            run in the foreground
 *   node scripts/desk-tools.mjs ensure           start detached unless already up
 *   node scripts/desk-tools.mjs status [--json]  up? which CLIs are installed?
 *
 * Every request needs `Authorization: Bearer <token>`: sessions/.desk-tools-token
 * (0600, made on first start). The tools run in the desk's current project with
 * edits allowed (codex workspace-write, claude acceptEdits, cursor-agent --force),
 * on their own logins; GotchiBot's API keys are stripped from their env. Each chat
 * session keeps its own conversation per tool (sessions/.desk-tools-sessions.json).
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DESK_TOOLS_PORT = Number(process.env.GOTCHIBOT_DESK_TOOLS_PORT) || 45690;
const TIMEOUT_MS = Number(process.env.GOTCHIBOT_DESK_TOOLS_TIMEOUT_MS) || 30 * 60_000;
const HEARTBEAT_MS = 10_000;
export const TOOLS = { cursor: "cursor-agent", codex: "codex", claude: "claude" };
/** Never handed to the CLIs: they use their own logins, not GotchiBot's keys. */
const STRIP_ENV = /^(ABRA_|AARCADE_|NVIDIA_|OPENROUTER_|DEEPSEEK_|OPENCODE_|OPENCLAW_|GOTCHIBOT_.*(TOKEN|KEY|SECRET|PASSWORD))/;

export const tokenPath = (root = ROOT) => join(root, "sessions", ".desk-tools-token");
const sessionsPath = (root = ROOT) => join(root, "sessions", ".desk-tools-sessions.json");

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

/** The runner's bearer token; created (0600) on first use. */
export function deskToolsToken(root = ROOT, { create = true } = {}) {
  try {
    const t = readFileSync(tokenPath(root), "utf8").trim();
    if (t) return t;
  } catch {}
  if (!create) return null;
  const t = randomBytes(24).toString("base64url");
  mkdirSync(dirname(tokenPath(root)), { recursive: true });
  writeFileSync(tokenPath(root), `${t}\n`, { mode: 0o600 });
  chmodSync(tokenPath(root), 0o600);
  return t;
}

/** `desk/codex`, `codex` → "codex"; anything else → null. */
export function toolOf(model) {
  const id = String(model || "").split("/").pop().toLowerCase();
  return Object.hasOwn(TOOLS, id) ? id : null;
}

/** Text of the last user message (string or content parts). */
export function lastUserText(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content.trim();
    if (Array.isArray(m.content)) return m.content.filter((p) => p?.type === "text").map((p) => p.text || "").join("\n").trim();
  }
  return "";
}

/**
 * argv for one turn. `resume` is the tool's own conversation id from an earlier
 * turn of the same chat session. Pure.
 */
export function toolArgs(tool, { prompt, cwd, resume = null, outFile = null }) {
  if (tool === "codex") {
    const common = ["--json", "-c", "sandbox_mode=workspace-write", "--skip-git-repo-check", ...(outFile ? ["-o", outFile] : [])];
    return resume ? ["exec", "resume", resume, ...common, prompt] : ["exec", "-C", cwd, ...common, prompt];
  }
  if (tool === "claude") {
    return ["-p", "--output-format", "json", "--permission-mode", "acceptEdits", ...(resume ? ["--resume", resume] : []), prompt];
  }
  if (tool === "cursor") {
    return ["--print", "--output-format", "json", "--force", "--trust", "--workspace", cwd, ...(resume ? ["--resume", resume] : []), prompt];
  }
  throw new Error(`unknown tool: ${tool}`);
}

/** { text, resume } from a finished run's output. Pure. */
export function parseToolOutput(tool, stdout, outFileText = "") {
  const lines = String(stdout || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const json = (l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  };
  if (tool === "codex") {
    let resume = null;
    let last = "";
    for (const e of lines.map(json).filter(Boolean)) {
      if (e.type === "thread.started" && e.thread_id) resume = e.thread_id;
      if (e.type === "item.completed" && e.item?.type === "agent_message" && e.item.text) last = e.item.text;
    }
    return { text: String(outFileText || "").trim() || last, resume };
  }
  // claude -p / cursor-agent --print with --output-format json: one result object.
  const result = [...lines].reverse().map(json).find((e) => e && (e.type === "result" || "result" in e));
  if (!result) return { text: lines.join("\n"), resume: null };
  return { text: String(result.result ?? "").trim(), resume: result.session_id || null, error: result.is_error ? true : undefined };
}

function childEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!STRIP_ENV.test(k)) env[k] = v;
  return env;
}

/** The desk's current project folder (what the chat is about), else the repo. */
async function projectDir() {
  try {
    const { currentProjectSlug, reconnectProjectDb } = await import("./project-context.mjs");
    const slug = currentProjectSlug();
    return (slug && reconnectProjectDb(slug)) || ROOT;
  } catch {
    return ROOT;
  }
}

const busy = new Set();

/** Run one turn; resolves { text, resume, ok }. */
function runTool(tool, { prompt, cwd, resume, onTick }) {
  return new Promise((done) => {
    const dir = mkdtempSync(join(tmpdir(), "gb-desk-tool-"));
    const outFile = tool === "codex" ? join(dir, "last.txt") : null;
    const child = spawn(TOOLS[tool], toolArgs(tool, { prompt, cwd, resume, outFile }), { cwd, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const tick = setInterval(() => onTick?.(), HEARTBEAT_MS);
    const kill = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);
    const finish = (code, spawnErr) => {
      clearInterval(tick);
      clearTimeout(kill);
      let outText = "";
      try {
        if (outFile) outText = readFileSync(outFile, "utf8");
      } catch {}
      rmSync(dir, { recursive: true, force: true });
      if (spawnErr) return done({ ok: false, text: `${TOOLS[tool]} could not start: ${spawnErr.message}` });
      const parsed = parseToolOutput(tool, out, outText);
      if (code !== 0 && !parsed.text) {
        const why = err.trim().split("\n").filter(Boolean).pop() || `exit ${code}`;
        return done({ ok: false, text: `${TOOLS[tool]} failed: ${why}` });
      }
      done({ ok: code === 0 && !parsed.error, text: parsed.text || "(no reply)", resume: parsed.resume });
    };
    child.on("error", (e) => finish(null, e));
    child.on("close", (code) => finish(code));
  });
}

function sse(res, model, text) {
  const base = { id: `desk-${Date.now()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })}\n\n`);
  res.end("data: [DONE]\n\n");
}

function readBody(req) {
  return new Promise((ok, fail) => {
    let b = "";
    req.on("data", (c) => {
      b += c;
      if (b.length > 4_000_000) {
        fail(new Error("payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => ok(b));
    req.on("error", fail);
  });
}

export function createDeskToolsServer({ root = ROOT, token = deskToolsToken(root), run = runTool, cwdOf = projectDir } = {}) {
  return createServer(async (req, res) => {
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/health") {
      return json(200, { ok: true, tools: Object.fromEntries(Object.entries(TOOLS).map(([k, bin]) => [k, spawnSync("which", [bin]).status === 0])) });
    }
    if (req.headers.authorization !== `Bearer ${token}`) return json(401, { error: { message: "desk tools: bad or missing token" } });
    if (req.method === "GET" && req.url === "/v1/models") {
      return json(200, { object: "list", data: Object.keys(TOOLS).map((id) => ({ id, object: "model", owned_by: "desk" })) });
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") return json(404, { error: { message: "not found" } });
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return json(400, { error: { message: "bad json" } });
    }
    const tool = toolOf(body.model);
    if (!tool) return json(400, { error: { message: `unknown desk tool: ${body.model}` } });
    const prompt = lastUserText(body.messages);
    if (!prompt) return json(400, { error: { message: "no user message" } });
    const session = String(req.headers["x-gotchibot-session"] || "default").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 80) || "default";
    const key = `${session}:${tool}`;
    if (busy.has(key)) return json(409, { error: { message: `${tool} is still working on this chat's last prompt` } });
    busy.add(key);
    const stream = body.stream === true;
    if (stream) res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    try {
      const map = readJson(sessionsPath(root), {});
      const cwd = await cwdOf();
      const r = await run(tool, { prompt, cwd, resume: map[session]?.[tool] || null, onTick: () => stream && res.write(": working\n\n") });
      if (r.resume) {
        const fresh = readJson(sessionsPath(root), {});
        fresh[session] = { ...(fresh[session] || {}), [tool]: r.resume, at: new Date().toISOString() };
        writeFileSync(sessionsPath(root), JSON.stringify(fresh, null, 2));
      }
      const text = r.ok ? r.text : `⚠ ${r.text}`;
      if (stream) sse(res, body.model, text);
      else json(200, { id: `desk-${Date.now()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
    } catch (e) {
      if (stream) sse(res, body.model, `⚠ desk tools error: ${e.message}`);
      else json(500, { error: { message: e.message } });
    } finally {
      busy.delete(key);
    }
  });
}

/** Is a runner answering on the port? */
export function probe(port = DESK_TOOLS_PORT, timeoutMs = 800) {
  return new Promise((ok) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/health", timeout: timeoutMs }, (res) => {
      res.resume();
      ok(res.statusCode === 200);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => ok(false));
    req.end();
  });
}

async function ensure() {
  if (await probe()) return true;
  deskToolsToken();
  mkdirSync(join(ROOT, "sessions"), { recursive: true });
  const log = openSync(join(ROOT, "sessions", ".desk-tools.log"), "a");
  spawn(process.execPath, [fileURLToPath(import.meta.url), "serve"], { cwd: ROOT, detached: true, stdio: ["ignore", log, log] }).unref();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (await probe()) return true;
  }
  return false;
}

async function main(argv) {
  const cmd = argv[0] || "status";
  if (cmd === "serve") {
    const server = createDeskToolsServer();
    server.listen(DESK_TOOLS_PORT, "127.0.0.1", () => console.error(`[desk-tools] listening 127.0.0.1:${DESK_TOOLS_PORT}`));
    return;
  }
  if (cmd === "ensure") {
    const up = await ensure();
    if (!up) console.error("desk tools runner did not start — sessions/.desk-tools.log");
    process.exit(up ? 0 : 1);
  }
  if (cmd === "status") {
    const up = await probe();
    const tools = Object.fromEntries(Object.entries(TOOLS).map(([k, bin]) => [k, spawnSync("which", [bin]).status === 0]));
    if (argv.includes("--json")) console.log(JSON.stringify({ up, port: DESK_TOOLS_PORT, tools }));
    else console.log(`desk tools: ${up ? "up" : "down"} on 127.0.0.1:${DESK_TOOLS_PORT} · ${Object.entries(tools).map(([k, v]) => `${k} ${v ? "✓" : "✗"}`).join(" · ")}`);
    return;
  }
  console.error("usage: desk-tools.mjs serve | ensure | status [--json]");
  process.exit(2);
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e?.message || e);
    process.exit(1);
  });
}
