#!/usr/bin/env node
/**
 * OpenAI-compatible proxy for OpenCode model `wisp/gotchi` (and aliases).
 *
 * Desk stays on agent=gotchi (project chat). /model wisp/gotchi routes here.
 * Free plan: MCP build_chat_context + local Zen reply (BYOM).
 * Paid/partner: POST /api/companion/chat when available.
 *
 *   node scripts/wisp-proxy.mjs
 *   gotchibot wisp-proxy [--check]
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.GOTCHIBOT_WISP_PORT) || 45682;
const HOST = process.env.GOTCHIBOT_WISP_HOST || "127.0.0.1";
const BASE = (process.env.WISP_BASE_URL || "https://api.gotchicloset.com").replace(/\/$/, "");
const ENV_FILE = join(ROOT, "sessions/.wisp.env");
const STATE = join(ROOT, "sessions/.wisp.json");

function loadKey() {
  const fromEnv = process.env.WISP_API_KEY?.trim() || "";
  if (fromEnv.startsWith("wsp_")) return fromEnv;
  if (!existsSync(ENV_FILE)) return "";
  try {
    const m = readFileSync(ENV_FILE, "utf8").match(/^WISP_API_KEY=(.+)$/m);
    const v = (m?.[1] || "").trim().replace(/^["']|["']$/g, "");
    return v.startsWith("wsp_") ? v : "";
  } catch {
    return "";
  }
}

function loadTokenHint() {
  const env = process.env.GOTCHIBOT_WISP_TOKEN_ID?.trim() || "";
  if (/^\d{3,7}$/.test(env)) return env;
  try {
    const id = String(JSON.parse(readFileSync(STATE, "utf8")).lastTokenId || "").trim();
    return /^\d{3,7}$/.test(id) ? id : "";
  } catch {
    return "";
  }
}

function saveLastToken(tokenId) {
  try {
    mkdirSync(dirname(STATE), { recursive: true });
    let prev = {};
    if (existsSync(STATE)) prev = JSON.parse(readFileSync(STATE, "utf8"));
    prev.lastTokenId = String(tokenId);
    prev.updatedAt = new Date().toISOString();
    writeFileSync(STATE, `${JSON.stringify(prev, null, 2)}\n`);
  } catch {
    /* optional */
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 2_000_000) {
        reject(new Error("payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function lastUserText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string") return c.trim();
    if (Array.isArray(c)) {
      return c.map((p) => (typeof p === "string" ? p : p?.text || "")).join("\n").trim();
    }
  }
  return "";
}

function extractTokenId(model, text) {
  const m1 = String(model || "").match(/^(?:wisp\/)?(?:gotchi\/)?(\d{3,7})$/i);
  if (m1) return m1[1];
  const m2 = String(model || "").match(/wisp\/(?:gotchi\/)?(\d{3,7})/i);
  if (m2) return m2[1];
  const hint = loadTokenHint();
  if (hint) return hint;
  const fromText =
    String(text || "").match(/\b(?:gotchi\s*#?|token(?:Id)?\s*[:=]?\s*)(\d{3,7})\b/i) ||
    String(text || "").match(/\b(\d{4,6})\b/);
  return fromText?.[1] || "";
}

async function mcpCall(key, name, args) {
  const r = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const raw = await r.text();
  let payload = raw;
  const dataLine = raw.split("\n").find((l) => l.startsWith("data: "));
  if (dataLine) payload = dataLine.slice(6);
  const j = JSON.parse(payload);
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  const text = (j.result?.content || []).map((c) => c.text || "").join("\n");
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function companionChat(key, tokenId, message) {
  const r = await fetch(`${BASE}/api/companion/chat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      tokenId: String(tokenId),
      message,
      wallet: process.env.WISP_WALLET || undefined,
    }),
  });
  const body = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body };
}

function zenComplete(systemPrompt, messages, userText) {
  const prompt = [
    systemPrompt || "You are an Aavegotchi. Stay in character. Short replies.",
    "",
    ...(Array.isArray(messages)
      ? messages.map((m) => {
          const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
          return `${m.role}: ${c}`;
        })
      : []),
    `user: ${userText}`,
    "",
    "assistant:",
  ].join("\n");

  const model = process.env.GOTCHIBOT_WISP_BACKING_MODEL || "opencode/big-pickle";
  const r = spawnSync("opencode", ["run", "-m", model, "--format", "text", prompt], {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const out = (r.stdout || "").trim();
  if (r.status === 0 && out) return out;
  const err = (r.stderr || out || `exit ${r.status}`).slice(0, 240);
  throw new Error(`wisp BYOM (opencode run) failed: ${err}`);
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function writeSseAssistant(res, model, text) {
  const id = `chatcmpl-${randomUUID().slice(0, 8)}`;
  const created = Math.floor(Date.now() / 1000);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const base = { id, object: "chat.completion.chunk", created, model };
  res.write(
    `data: ${JSON.stringify({
      ...base,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    })}\n\n`,
  );
  const chunkSize = 80;
  for (let i = 0; i < text.length; i += chunkSize) {
    const content = text.slice(i, i + chunkSize);
    res.write(
      `data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      })}\n\n`,
    );
  }
  res.write(
    `data: ${JSON.stringify({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`,
  );
  res.write("data: [DONE]\n\n");
  res.end();
}

function writeJsonAssistant(res, model, text) {
  const id = `chatcmpl-${randomUUID().slice(0, 8)}`;
  return json(res, 200, {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: text.length, total_tokens: text.length },
  });
}

async function handleChat(payload) {
  const key = loadKey();
  if (!key) {
    throw new Error("no WISP_API_KEY — run: ./scripts/gotchibot wisp mint");
  }
  const model = payload.model || "wisp/gotchi";
  const userText = lastUserText(payload.messages) || "gm";
  const tokenId = extractTokenId(model, userText);
  if (!tokenId) {
    throw new Error(
      'name a gotchi token id (e.g. /model wisp/gotchi then say "gotchi 22899", or set GOTCHIBOT_WISP_TOKEN_ID)',
    );
  }
  saveLastToken(tokenId);

  const chat = await companionChat(key, tokenId, userText);
  if (chat.ok && (chat.body?.reply || chat.body?.message || chat.body?.content)) {
    return String(chat.body.reply || chat.body.message || chat.body.content);
  }

  const ctx = await mcpCall(key, "build_chat_context", {
    tokenId: String(tokenId),
    message: userText,
  });
  const systemPrompt = ctx.systemPrompt || ctx.raw || "";
  const messages = Array.isArray(ctx.messages) ? ctx.messages : [];
  return zenComplete(systemPrompt, messages, userText);
}

if (process.argv.includes("--check")) {
  fetch(`http://${HOST}:${PORT}/health`)
    .then(async (r) => {
      console.log(await r.text());
      process.exit(r.ok ? 0 : 1);
    })
    .catch(() => {
      console.error(`wisp proxy down on :${PORT}`);
      process.exit(1);
    });
} else {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        });
        return res.end();
      }
      if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/healthz" || url.pathname === "/v1/health")) {
        return json(res, 200, { ok: true, model: "wisp/gotchi", key: Boolean(loadKey()) });
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        return json(res, 200, {
          object: "list",
          data: [
            { id: "wisp/gotchi", object: "model", created: 0, owned_by: "wisp" },
            { id: "gotchi", object: "model", created: 0, owned_by: "wisp" },
            { id: "wisp", object: "model", created: 0, owned_by: "wisp" },
          ],
        });
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        let payload;
        try {
          payload = JSON.parse(await readBody(req));
        } catch {
          return json(res, 400, { error: { message: "invalid json" } });
        }
        const model = payload.model || "wisp/gotchi";
        const wantStream = payload.stream === true;
        console.log(`[wisp] ${wantStream ? "stream" : "json"} model=${model}`);
        try {
          const text = await handleChat(payload);
          console.log(`[wisp] reply chars=${text.length}`);
          if (wantStream) return writeSseAssistant(res, model, text);
          return writeJsonAssistant(res, model, text);
        } catch (e) {
          const message = e?.message || String(e);
          console.error(`[wisp] error: ${message}`);
          return json(res, 502, {
            error: { message, type: "wisp_error", code: "wisp_failed" },
          });
        }
      }
      json(res, 404, { error: { message: "not found" } });
    } catch (e) {
      json(res, 500, { error: { message: String(e.message || e) } });
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`wisp proxy http://${HOST}:${PORT}/v1  (models: wisp/gotchi)`);
  });
}
