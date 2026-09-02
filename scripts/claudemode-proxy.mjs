#!/usr/bin/env node
/**
 * OpenAI-compatible proxy for OpenCode model `@claudemode` / `claudemode`.
 *
 * Desk OpenCode → POST /v1/chat/completions → Hub VS Code Claude (bridge) →
 * streamed assistant reply in Desk chat (not a System bubble).
 *
 *   node scripts/claudemode-proxy.mjs
 */
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.GOTCHIBOT_CLAUDEMODE_PORT) || 45680;
const HOST = process.env.GOTCHIBOT_CLAUDEMODE_HOST || "127.0.0.1";
const BRIDGE = join(ROOT, "scripts/bridge-prompt.mjs");
const TIMEOUT_SEC = Number(process.env.GOTCHIBOT_CLAUDEMODE_TIMEOUT) || 300;

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
      return c
        .map((p) => (typeof p === "string" ? p : p?.text || ""))
        .join("\n")
        .trim();
    }
  }
  return "";
}

/** Strip abra banners / bridge status lines so only Claude text reaches Desk chat. */
function cleanReply(stdout, stderr) {
  const lines = String(stdout || "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd())
    .filter((l) => {
      const t = l.trim();
      if (!t) return false;
      if (/^▸/.test(t)) return false;
      if (/^injecting \d+ var/i.test(t)) return false;
      if (/^accepted id=/i.test(t)) return false;
      if (/^waiting up to /i.test(t)) return false;
      if (/^Hub Claude:/i.test(t)) return t.replace(/^Hub Claude:\s*/i, "");
      return true;
    });
  let text = lines.join("\n").trim();
  if (!text) {
    const errLines = String(stderr || "")
      .split(/\r?\n/)
      .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim())
      .filter((t) => t && !/^▸/.test(t) && !/^injecting /i.test(t) && !/^accepted id=/i.test(t));
    text = errLines.join("\n").trim();
  }
  return text.replace(/^Hub Claude:\s*/i, "").trim();
}

function runBridge(prompt) {
  const id = `cm-${randomUUID().slice(0, 8)}`;
  const env = { ...process.env };
  const useAbra =
    !(env.SSH_PRIVATE_KEY && env.REMOTE_HOST) &&
    spawnSync("which", ["abra"], { encoding: "utf8" }).status === 0;

  const bridgeArgs = ["--host", "imac", "--wait", "--timeout", String(TIMEOUT_SEC), "--id", id, prompt];
  const cmd = useAbra ? "abra" : process.execPath;
  const finalArgs = useAbra
    ? ["run", "gotchibot", "--", "node", BRIDGE, ...bridgeArgs]
    : [BRIDGE, ...bridgeArgs];

  const r = spawnSync(cmd, finalArgs, {
    cwd: ROOT,
    encoding: "utf8",
    env,
    timeout: (TIMEOUT_SEC + 30) * 1000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const text = cleanReply(r.stdout, r.stderr);
  if (r.status !== 0) {
    throw new Error(text || String(r.stderr || "").trim() || `bridge exit ${r.status}`);
  }
  if (!text) throw new Error("empty reply from Hub Claude bridge");
  return text;
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

  // First chunk: role=assistant (OpenAI / AI SDK convention)
  res.write(
    `data: ${JSON.stringify({
      ...base,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    })}\n\n`,
  );

  // Stream content in modest chunks so the Desk chat paints as a normal assistant reply
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    });
    return res.end();
  }

  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/v1/health")) {
    return json(res, 200, { ok: true, model: "@claudemode" });
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    return json(res, 200, {
      object: "list",
      data: [
        { id: "@claudemode", object: "model", created: 0, owned_by: "gotchibot" },
        { id: "claudemode", object: "model", created: 0, owned_by: "gotchibot" },
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
    const prompt = lastUserText(payload.messages);
    if (!prompt) {
      return json(res, 400, { error: { message: "no user message" } });
    }

    const model = payload.model || "@claudemode";
    const wantStream = payload.stream === true;
    console.log(`[claudemode] ${wantStream ? "stream" : "json"} prompt=${JSON.stringify(prompt).slice(0, 120)}`);

    try {
      const text = runBridge(prompt);
      console.log(`[claudemode] reply chars=${text.length}`);
      if (wantStream) return writeSseAssistant(res, model, text);
      return writeJsonAssistant(res, model, text);
    } catch (e) {
      const message = e?.message || String(e);
      console.error(`[claudemode] error: ${message}`);
      return json(res, 502, {
        error: { message, type: "gotchibridge_error", code: "bridge_failed" },
      });
    }
  }

  json(res, 404, { error: { message: "not found" } });
});

server.listen(PORT, HOST, () => {
  console.log(`claudemode proxy http://${HOST}:${PORT}/v1  (model @claudemode)`);
});
