#!/usr/bin/env node
/**
 * Gotchi mode — OpenCode TUI relays each prompt to the iMac OpenClaw orchestrator.
 *
 * OpenCode stays the native chat UI. When agent=gotchi and the gateway is up,
 * a local OpenAI-compatible relay injects the user turn into the orchestrator
 * TUI session (`agent:<id>:main`). Ask / plan / build stay local OpenCode models.
 *
 * Relay backends (first match):
 *   1. Gateway POST /v1/chat/completions + x-openclaw-session-key (if enabled)
 *   2. openclaw agent --agent <id> --session-key agent:<id>:main
 *
 * usage:
 *   node scripts/opencode-gotchi-mode.mjs status [--json]
 *   node scripts/opencode-gotchi-mode.mjs env
 *   node scripts/opencode-gotchi-mode.mjs model
 *   node scripts/opencode-gotchi-mode.mjs ensure
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  gatewayReachable,
  gatewayUrl,
  heroToAgentId,
  loadAgentMap,
  loadGatewayConfig,
  orchestratorHeroId,
  tuiSessionKey,
} from "./openclaw-fleet.mjs";

const __DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__DIR, "..");
const RELAY_SCRIPT = `${ROOT}/scripts/opencode-gotchi-relay.mjs`;
const RELAY_STATE = `${ROOT}/sessions/.gotchi-relay.json`;
const LOCAL_MODEL = (process.env.GOTCHIBOT_OPENCODE_MODEL || "opencode/nemotron-3.5-lightning-free").trim();
const OPENCLAW_MODEL = (process.env.GOTCHIBOT_OPENCLAW_OPENCODE_MODEL || "openclaw/orchestrator").trim();
// Gotchi TUI always starts on Lightning Free. Orchestrator model is status-only unless forced.
const TUI_MODEL = process.env.GOTCHIBOT_GOTCHI_TUI_MODEL?.trim() || LOCAL_MODEL;
const RELAY_PORT = Number(process.env.GOTCHIBOT_GOTCHI_RELAY_PORT || 18791);

function gatewayAuthEnv() {
  const file = loadGatewayConfig();
  const token =
    process.env.OPENCLAW_GATEWAY_TOKEN?.trim() ||
    process.env.GOTCHIBOT_OPENCLAW_TOKEN?.trim() ||
    file?.token?.trim() ||
    "";
  const password =
    process.env.OPENCLAW_GATEWAY_PASSWORD?.trim() ||
    process.env.GOTCHIBOT_OPENCLAW_PASSWORD?.trim() ||
    "";
  return { token, password };
}

export async function probeGatewayChatCompletions({ gateway, token, timeoutMs = 2500 } = {}) {
  const base = (gateway || gatewayUrl()).replace(/\/$/, "");
  const headers = {
    Accept: "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  try {
    const r = await fetch(`${base}/v1/models`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ct = r.headers.get("content-type") || "";
    if (r.ok && ct.includes("json")) {
      const body = await r.json().catch(() => null);
      if (body && Array.isArray(body.data)) {
        return { ok: true, via: "models", status: r.status, reason: "ok" };
      }
    }
  } catch {
    // fall through to POST probe
  }
  try {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openclaw/default", messages: [] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (r.status === 404 || r.status === 405) {
      return { ok: false, via: "chat", status: r.status, reason: "endpoint-disabled" };
    }
    return { ok: true, via: "chat", status: r.status, reason: "ok" };
  } catch (e) {
    return { ok: false, via: "chat", status: 0, reason: "probe-failed" };
  }
}

async function relayHealth(port = RELAY_PORT) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(400),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function loadRelayState() {
  try {
    return JSON.parse(readFileSync(RELAY_STATE, "utf8"));
  } catch {
    return null;
  }
}

export async function ensureGotchiRelay(mode) {
  const port = RELAY_PORT;
  const listen = `http://127.0.0.1:${port}/v1`;
  const live = await relayHealth(port);
  if (live?.ok) {
    return { ok: true, started: false, listen, pid: live.pid || loadRelayState()?.pid || null };
  }
  if (!existsSync(RELAY_SCRIPT)) {
    return { ok: false, started: false, listen, reason: "relay-script-missing" };
  }
  const auth = gatewayAuthEnv();
  const env = {
    ...process.env,
    GOTCHIBOT_ROOT: ROOT,
    GOTCHIBOT_GOTCHI_RELAY_PORT: String(port),
    GOTCHIBOT_OPENCLAW_URL: mode.gateway,
    GOTCHIBOT_OPENCLAW_SESSION_KEY: mode.sessionKey,
    GOTCHIBOT_OPENCLAW_ORCH_ID: mode.orchestratorId,
    OPENCLAW_GATEWAY_URL: process.env.OPENCLAW_GATEWAY_URL || mode.gateway,
  };
  if (auth.token) env.OPENCLAW_GATEWAY_TOKEN = auth.token;
  if (auth.password) env.OPENCLAW_GATEWAY_PASSWORD = auth.password;
  const child = spawn(process.execPath, [RELAY_SCRIPT], {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
    env,
  });
  child.unref();
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const ok = await relayHealth(port);
    if (ok?.ok) return { ok: true, started: true, listen, pid: child.pid };
    spawnSync("sleep", ["0.15"]);
  }
  return { ok: false, started: false, listen, pid: child.pid, reason: "relay-start-timeout" };
}

export async function resolveGotchiMode({ ensureRelay = false } = {}) {
  const forceLocal =
    process.env.GOTCHIBOT_GOTCHI_BACKEND === "local" ||
    process.env.GOTCHIBOT_GOTCHI_BACKEND === "opencode";
  const skipRelay = process.env.GOTCHIBOT_GOTCHI_RELAY === "0";
  const map = loadAgentMap();
  const orchestratorId =
    map?.orchestratorAgentId || heroToAgentId(orchestratorHeroId());
  const sessionKey = tuiSessionKey(orchestratorId);
  const gateway = gatewayUrl();
  const remoteHttpV1 = `${gateway.replace(/\/$/, "")}/v1`;
  const auth = gatewayAuthEnv();

  const base = {
    orchestratorId,
    sessionKey,
    gateway,
    remoteHttpV1,
    httpV1: remoteHttpV1,
    relay: "none",
    relayListen: null,
    chatCompletions: { ok: false, reason: "skipped" },
    reachable: false,
    blocker: null,
  };

  if (forceLocal) {
    return {
      ...base,
      backend: "local-opencode",
      enabled: false,
      model: LOCAL_MODEL,
      reason: "GOTCHIBOT_GOTCHI_BACKEND=local",
    };
  }

  const reachable = await gatewayReachable();
  if (!reachable) {
    return {
      ...base,
      backend: "local-fallback",
      enabled: false,
      model: LOCAL_MODEL,
      reachable: false,
      reason: "gateway-unreachable",
      blocker: "gateway-unreachable",
    };
  }

  if (!auth.token && !auth.password) {
    return {
      ...base,
      backend: "local-fallback",
      enabled: false,
      model: LOCAL_MODEL,
      reachable: true,
      reason: "gateway-auth-missing",
      blocker: "gateway-auth-missing",
    };
  }

  const chatCompletions = await probeGatewayChatCompletions({ gateway, token: auth.token });
  const httpLive = Boolean(chatCompletions.ok);
  let relay = httpLive ? "gateway-http" : "openclaw-agent-cli";
  let httpV1 = remoteHttpV1;
  let relayListen = null;
  let blocker = httpLive ? null : "chat-completions-disabled";
  let reason = httpLive ? "ok" : "relay-via-openclaw-agent";

  if (!skipRelay) {
    const draft = {
      ...base,
      backend: "openclaw-gateway",
      enabled: true,
      model: TUI_MODEL, backendModel: OPENCLAW_MODEL,
      reachable: true,
      chatCompletions,
      relay,
    };
    if (ensureRelay) {
      const started = await ensureGotchiRelay(draft);
      if (started.ok) {
        httpV1 = started.listen;
        relayListen = started.listen;
        reason = httpLive ? "relay-via-gateway-http" : "relay-via-openclaw-agent";
      } else if (httpLive) {
        httpV1 = remoteHttpV1;
        relay = "gateway-http-direct";
        reason = "relay-start-failed-using-gateway-http";
      } else {
        return {
          ...draft,
          enabled: false,
          model: LOCAL_MODEL,
          backend: "local-fallback",
          httpV1: remoteHttpV1,
          reason: started.reason || "relay-start-failed",
          blocker: "relay-start-failed",
        };
      }
    } else {
      const live = await relayHealth(RELAY_PORT);
      if (live?.ok) {
        httpV1 = `http://127.0.0.1:${RELAY_PORT}/v1`;
        relayListen = httpV1;
      }
    }
  } else if (!httpLive) {
    return {
      ...base,
      backend: "local-fallback",
      enabled: false,
      model: LOCAL_MODEL,
      reachable: true,
      chatCompletions,
      reason: "chat-completions-disabled",
      blocker: "chat-completions-disabled",
    };
  }

  return {
    ...base,
    backend: "openclaw-gateway",
    enabled: true,
    model: TUI_MODEL, backendModel: OPENCLAW_MODEL,
    reachable: true,
    httpV1,
    relay,
    relayListen,
    chatCompletions,
    reason,
    blocker,
  };
}

function shellExport(name, value) {
  if (value == null || value === "") return "";
  return `export ${name}=${JSON.stringify(String(value))}`;
}

async function printEnv(mode) {
  const auth = gatewayAuthEnv();
  const lines = [
    shellExport("GOTCHIBOT_GOTCHI_BACKEND", mode.backend),
    shellExport("GOTCHIBOT_GOTCHI_MODEL", mode.model),
    shellExport("GOTCHIBOT_GOTCHI_RELAY", mode.relay),
    shellExport("GOTCHIBOT_OPENCLAW_URL", mode.gateway),
    shellExport("OPENCLAW_GATEWAY_URL", mode.gateway),
    shellExport("GOTCHIBOT_OPENCLAW_HTTP_V1", mode.httpV1),
    shellExport("GOTCHIBOT_OPENCLAW_SESSION_KEY", mode.sessionKey),
    shellExport("GOTCHIBOT_OPENCLAW_ORCH_ID", mode.orchestratorId),
  ];
  if (auth.token) lines.push(shellExport("OPENCLAW_GATEWAY_TOKEN", auth.token));
  else if (auth.password) lines.push(shellExport("OPENCLAW_GATEWAY_TOKEN", auth.password));
  if (auth.password) lines.push(shellExport("OPENCLAW_GATEWAY_PASSWORD", auth.password));
  console.log(lines.filter(Boolean).join("\n"));
}

function printStatus(mode) {
  if (mode.enabled) {
    console.log(`gotchi mode: OpenCode TUI → OpenClaw orchestrator (${mode.orchestratorId})`);
    console.log(`  gateway    ${mode.gateway}`);
    console.log(`  model      ${mode.model}`);
    console.log(`  session    ${mode.sessionKey}`);
    console.log(`  opencode   ${mode.httpV1}`);
    console.log(`  relay      ${mode.relay}${mode.relayListen ? ` (${mode.relayListen})` : ""}`);
    const cc = mode.chatCompletions;
    if (cc && !cc.ok) {
      console.log(`  http /v1   missing (${cc.reason || cc.status || "disabled"})`);
      console.log("  iMac fix:  abra run gotchibot -- ./scripts/gotchibot remote-openclaw --http-only");
    } else {
      console.log("  http /v1   live");
    }
    if (mode.blocker === "chat-completions-disabled") {
      console.log("  note: CLI inject needs this Mac paired with the iMac gateway;");
      console.log("        enabling /v1/chat/completions avoids pairing.");
    }
  } else {
    console.log(`gotchi mode: local OpenCode (${mode.model}) — ${mode.reason}`);
    if (mode.reason === "gateway-auth-missing") {
      console.log("  fix: ./scripts/gotchibot openclaw point <imac-host>  or set OPENCLAW_GATEWAY_TOKEN");
    } else if (!mode.reachable) {
      console.log(`  gateway ${mode.gateway} unreachable — orchestrator offline or tunnel down`);
    } else if (mode.blocker === "chat-completions-disabled") {
      console.log("  gateway HTTP /v1/chat/completions is off and local relay is disabled.");
      console.log("  iMac fix: abra run gotchibot -- ./scripts/gotchibot remote-openclaw --http-only");
    }
  }
}

async function main() {
  const cmd = process.argv[2] || "status";
  const json = process.argv.includes("--json");
  const ensure = cmd === "env" || cmd === "ensure";
  const mode = await resolveGotchiMode({ ensureRelay: ensure });

  if (cmd === "model") {
    process.stdout.write(mode.model);
    process.exit(0);
  }

  if (cmd === "env") {
    await printEnv(mode);
    process.exit(0);
  }

  if (cmd === "ensure") {
    if (json) console.log(JSON.stringify(mode, null, 2));
    else printStatus(mode);
    process.exit(mode.enabled || mode.backend === "local-opencode" ? 0 : 1);
  }

  if (cmd === "status") {
    if (json) {
      console.log(JSON.stringify(mode, null, 2));
      process.exit(0);
    }
    printStatus(mode);
    process.exit(0);
  }

  console.error("usage: opencode-gotchi-mode.mjs status|env|model|ensure [--json]");
  process.exit(2);
}

if (process.argv[1]?.endsWith("opencode-gotchi-mode.mjs")) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
