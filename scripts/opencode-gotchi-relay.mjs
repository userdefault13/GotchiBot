#!/usr/bin/env node
/**
 * Local OpenAI-compatible relay for gotchi mode.
 *
 * OpenCode TUI talks to 127.0.0.1; each user prompt is injected into the
 * iMac OpenClaw orchestrator TUI session (agent:<orchId>:main).
 *
 * Backend:
 *   1. Gateway POST /v1/chat/completions + x-openclaw-session-key (if enabled)
 *   2. Else: openclaw agent --agent <id> --session-key agent:<id>:main
 *
 *   node scripts/opencode-gotchi-relay.mjs
 *   GOTCHIBOT_GOTCHI_RELAY_PORT=18791 node scripts/opencode-gotchi-relay.mjs
 */
import http from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import {
  gatewayUrl,
  heroToAgentId,
  loadAgentMap,
  loadGatewayConfig,
  orchestratorHeroId,
  runAgentTurn,
  tuiSessionKey,
} from "./openclaw-fleet.mjs";

const PORT = Number(process.env.GOTCHIBOT_GOTCHI_RELAY_PORT || 18791);
const HOST = process.env.GOTCHIBOT_GOTCHI_RELAY_HOST || "127.0.0.1";
const MODEL = "openclaw/orchestrator";

function authToken() {
  const file = loadGatewayConfig();
  return (
    process.env.OPENCLAW_GATEWAY_TOKEN?.trim() ||
    process.env.GOTCHIBOT_OPENCLAW_TOKEN?.trim() ||
    file?.token?.trim() ||
    ""
  );
}

function orchTarget() {
  const map = loadAgentMap();
  const orchestratorId =
    process.env.GOTCHIBOT_OPENCLAW_ORCH_ID?.trim() ||
    map?.orchestratorAgentId ||
    heroToAgentId(orchestratorHeroId());
  const sessionKey =
    process.env.GOTCHIBOT_OPENCLAW_SESSION_KEY?.trim() || tuiSessionKey(orchestratorId);
  return { orchestratorId, sessionKey };
}

function lastUserText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return c
        .map((p) => {
          if (typeof p === "string") return p;
          if (p && p.type === "text" && typeof p.text === "string") return p.text;
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
  }
  return "";
}

function extractAgentReply(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return "";
  const tryObj = (j) => {
    const payloads = j?.result?.payloads;
    if (Array.isArray(payloads)) {
      const joined = payloads.map((p) => p?.text).filter(Boolean).join("\n").trim();
      if (joined) return joined;
    }
    if (typeof j?.summary === "string" && j.summary.trim()) return j.summary.trim();
    if (typeof j?.result?.text === "string" && j.result.text.trim()) return j.result.text.trim();
    return "";
  };
  try {
    const hit = tryObj(JSON.parse(text));
    if (hit) return hit;
  } catch {
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line.startsWith("{")) continue;
      try {
        const hit = tryObj(JSON.parse(line));
        if (hit) return hit;
      } catch {}
    }
  }
  return text;
}

function openaiMessage(id, content, model = MODEL) {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
  };
}

function writeSse(res, id, model, content, finish = null) {
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: content != null ? { content } : {},
        finish_reason: finish,
      },
    ],
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function sendJson(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(raw),
    "Cache-Control": "no-store",
  });
  res.end(raw);
}

function unauthorized(res) {
  sendJson(res, 401, {
    error: { message: "Missing or invalid Authorization bearer", type: "auth_error" },
  });
}

function checkAuth(req) {
  const expected = authToken();
  if (!expected) return true;
  const hdr = String(req.headers.authorization || "");
  const got = hdr.replace(/^Bearer\s+/i, "").trim();
  return got === expected;
}

async function probeRemoteChatCompletions() {
  const gateway = (process.env.GOTCHIBOT_OPENCLAW_URL || gatewayUrl()).replace(/\/$/, "");
  const token = authToken();
  try {
    const r = await fetch(`${gateway}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ model: "openclaw/default", messages: [] }),
      signal: AbortSignal.timeout(2500),
    });
    // 404 = disabled (SPA catch-all). 400/401/200 = endpoint is live.
    return { ok: r.status !== 404 && r.status !== 405, status: r.status, gateway };
  } catch {
    return { ok: false, status: 0, gateway };
  }
}

async function relayViaHttp({ text, sessionKey, orchestratorId, stream, res, id, model }) {
  const gateway = (process.env.GOTCHIBOT_OPENCLAW_URL || gatewayUrl()).replace(/\/$/, "");
  const token = authToken();
  const r = await fetch(`${gateway}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: stream ? "text/event-stream" : "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "x-openclaw-session-key": sessionKey,
      "x-openclaw-agent-id": orchestratorId,
    },
    body: JSON.stringify({
      model: "openclaw/default",
      stream: Boolean(stream),
      messages: [{ role: "user", content: text }],
    }),
    signal: AbortSignal.timeout(15 * 60 * 1000),
  });
  if (r.status === 404 || r.status === 405) {
    return { ok: false, reason: "endpoint-disabled", status: r.status };
  }
  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    return { ok: false, reason: "gateway-http-error", status: r.status, body: errText.slice(0, 800) };
  }
  if (stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    if (!r.body) {
      writeSse(res, id, model, "", "stop");
      res.write("data: [DONE]\n\n");
      res.end();
      return { ok: true };
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(dec.decode(value, { stream: true }));
    }
    res.end();
    return { ok: true };
  }
  const data = await r.json();
  sendJson(res, 200, data);
  return { ok: true };
}

function relayViaCli({ text, sessionKey, orchestratorId }) {
  return runAgentTurn(orchestratorId, text, {
    json: true,
    timeout: Number(process.env.GOTCHIBOT_GOTCHI_RELAY_TIMEOUT || 600),
    sessionKey,
  });
}

function pairingHint(result) {
  const blob = `${result?.stderr || ""}\n${result?.stdout || ""}\n${result?.reason || ""}`;
  if (/pairing required|device is not approved|device-pairing-required/i.test(blob)) {
    return [
      "OpenClaw CLI cannot inject into the iMac TUI session: this Mac is not paired with the gateway.",
      "Enable HTTP chat-completions on the iMac (no pairing needed):",
      "  abra run gotchibot -- ./scripts/gotchibot remote-openclaw --http-only",
      "Then respawn the chat pane. Pairing the MBP (`openclaw devices`) is the other path.",
    ].join("\n");
  }
  return null;
}

async function handleChatCompletions(req, res, body) {
  const { orchestratorId, sessionKey } = orchTarget();
  const text = lastUserText(body?.messages).trim();
  const stream = Boolean(body?.stream);
  const id = `gotchi-relay-${Date.now().toString(36)}`;
  const model = typeof body?.model === "string" && body.model.trim() ? body.model : MODEL;

  if (!text) {
    sendJson(res, 400, {
      error: { message: "messages must include a user turn", type: "invalid_request_error" },
    });
    return;
  }

  const preferHttp = process.env.GOTCHIBOT_GOTCHI_RELAY_BACKEND !== "cli";
  if (preferHttp) {
    const probe = await probeRemoteChatCompletions();
    if (probe.ok) {
      const httpResult = await relayViaHttp({
        text,
        sessionKey,
        orchestratorId,
        stream,
        res,
        id,
        model,
      });
      if (httpResult.ok) return;
      if (httpResult.reason !== "endpoint-disabled") {
        const msg = `OpenClaw gateway HTTP relay failed (${httpResult.status || "?"}): ${httpResult.body || httpResult.reason}`;
        if (stream) {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
          writeSse(res, id, model, msg, "stop");
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        sendJson(res, 502, { error: { message: msg, type: "api_error" } });
        return;
      }
    }
  }

  const result = relayViaCli({ text, sessionKey, orchestratorId });
  const hint = pairingHint(result);
  const reply = result.ok
    ? extractAgentReply(result.stdout) || "(empty orchestrator reply)"
    : hint ||
      `Gotchi relay failed (${result.reason || "openclaw-agent-failed"}). Session ${sessionKey}. ${String(result.stderr || result.stdout || "").trim().slice(0, 600)}`;

  if (stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    writeSse(res, id, model, reply, "stop");
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }
  sendJson(res, result.ok ? 200 : 502, result.ok ? openaiMessage(id, reply, model) : {
    error: { message: reply, type: "api_error" },
  });
}

function handleModels(_req, res) {
  sendJson(res, 200, {
    object: "list",
    data: [
      { id: "openclaw/orchestrator", object: "model", owned_by: "gotchibot" },
      { id: "openclaw/default", object: "model", owned_by: "gotchibot" },
      { id: "orchestrator", object: "model", owned_by: "gotchibot" },
    ],
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > 20 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "GET" && (path === "/healthz" || path === "/health")) {
    const { orchestratorId, sessionKey } = orchTarget();
    sendJson(res, 200, { ok: true, relay: "gotchi", orchestratorId, sessionKey });
    return;
  }

  if (!checkAuth(req) && path !== "/healthz" && path !== "/health") {
    unauthorized(res);
    return;
  }

  if (req.method === "GET" && path === "/v1/models") {
    handleModels(req, res);
    return;
  }

  if (req.method === "POST" && path === "/v1/chat/completions") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      await handleChatCompletions(req, res, body);
    } catch (e) {
      sendJson(res, 400, {
        error: { message: e.message || "bad request", type: "invalid_request_error" },
      });
    }
    return;
  }

  sendJson(res, 404, { error: { message: "not found", type: "invalid_request_error" } });
});

server.timeout = 0;
server.headersTimeout = 0;
server.requestTimeout = 0;
server.keepAliveTimeout = 0;

server.listen(PORT, HOST, () => {
  const root = process.env.GOTCHIBOT_ROOT;
  if (root) {
    try {
      mkdirSync(`${root}/sessions`, { recursive: true });
      writeFileSync(`${root}/sessions/.gotchi-relay.pid`, `${process.pid}\n`);
      writeFileSync(
        `${root}/sessions/.gotchi-relay.json`,
        `${JSON.stringify(
          {
            pid: process.pid,
            host: HOST,
            port: PORT,
            url: `http://${HOST}:${PORT}/v1`,
            startedAt: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
      );
    } catch {}
  }
  console.error(`gotchi relay http://${HOST}:${PORT}/v1 pid=${process.pid}`);
});
