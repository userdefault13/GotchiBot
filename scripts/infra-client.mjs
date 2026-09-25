#!/usr/bin/env node
/**
 * Outbound auth for Solo infra (install token) vs legacy operator secrets.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENDPOINTS = JSON.parse(readFileSync(`${ROOT}/config/subgraph.endpoints.json`, "utf8"));
const AUTH_CFG = JSON.parse(readFileSync(`${ROOT}/config/infra.auth.json`, "utf8"));

const ARCADE_CHAT_HOSTS = new Set(
  ["gotchibot.aarcadeghst.com", "www.aarcadeghst.com"].map((h) => h.toLowerCase()),
);

export function hasInstallToken(env = process.env) {
  return Boolean(String(env.GOTCHIBOT_INFRA_TOKEN || "").trim());
}

export function hasOperatorSubgraphKey(env = process.env) {
  return Boolean(
    String(env.GOTCHIBOT_SUBGRAPH_PROXY_KEY || env.SUBGRAPH_PROXY_SECRET || "").trim(),
  );
}

export function hasOperatorServiceKey(env = process.env) {
  return Boolean(String(env.AARCADE_GOTCHIBOT_SERVICE_SECRET || "").trim());
}

/** Solo path: www API + install token */
export function useSoloApi(env = process.env) {
  return hasInstallToken(env);
}

export function infraHeaders(env = process.env) {
  const headers = {
    Accept: "application/json",
    "User-Agent": "GotchiBot/infra-client",
  };
  const token = String(env.GOTCHIBOT_INFRA_TOKEN || "").trim();
  if (token) {
    headers[AUTH_CFG.installTokenHeader || "X-GotchiBot-Install-Token"] = token;
    headers[AUTH_CFG.clientHeader || "X-GotchiBot-Client"] =
      AUTH_CFG.clientHeaderValue || "gotchibot";
  }
  const proxyKey = String(env.GOTCHIBOT_SUBGRAPH_PROXY_KEY || env.SUBGRAPH_PROXY_SECRET || "").trim();
  if (proxyKey && !token) {
    headers[ENDPOINTS.auth?.header || "X-Subgraph-Proxy-Key"] = proxyKey;
  }
  const serviceKey = String(env.AARCADE_GOTCHIBOT_SERVICE_SECRET || "").trim();
  if (serviceKey) {
    headers["x-aarcade-service-key"] = serviceKey;
  }
  return headers;
}

export function soloApiBase(env = process.env) {
  return String(env.GOTCHIBOT_SOLO_API_BASE || AUTH_CFG.soloApiBase || "https://www.aarcadeghst.com").replace(
    /\/$/,
    "",
  );
}

function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Local chat-store pin (never commit) — sessions/.mongo.json */
export function readMongoPin(root = ROOT) {
  return readJsonSafe(`${root}/sessions/.mongo.json`);
}

/** Hub Tailscale pin — sessions/.hub.json */
export function readHubPin(root = ROOT) {
  return readJsonSafe(`${root}/sessions/.hub.json`);
}

/**
 * Prefer Hub MagicDNS + desk API port over Arcade shared home.
 * Override: GOTCHIBOT_DESK_API_BASE.
 */
export function deskApiBaseFromHubPin(hub, env = process.env) {
  if (!hub?.tailscaleHost) return null;
  const host = String(hub.tailscaleHost).trim();
  if (!host) return null;
  const port = String(env.GOTCHIBOT_API_PORT || AUTH_CFG.deskApiPort || "8793").replace(/^:/, "");
  const proto = env.GOTCHIBOT_DESK_API_PROTO || AUTH_CFG.deskApiProto || "http";
  // Tailscale Serve / HTTPS override
  if (hub.deskApiBase) return String(hub.deskApiBase).replace(/\/$/, "");
  if (/^https?:\/\//i.test(host)) return host.replace(/\/$/, "");
  return `${proto}://${host}:${port}`;
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function isArcadeSharedChatBase(base) {
  if (!base) return false;
  const host = hostnameOf(base);
  return ARCADE_CHAT_HOSTS.has(host);
}

/**
 * Chat sync + Hub desk API — user's Hub only, never Arcade shared Mongo.
 * Resolution order:
 *   1. GOTCHIBOT_DESK_API_BASE
 *   2. sessions/.hub.json deskApiBase / MagicDNS:8793
 * Else null (never Arcade).
 */
export function deskApiBase(env = process.env) {
  const fromEnv = String(env.GOTCHIBOT_DESK_API_BASE || "").trim().replace(/\/$/, "");
  if (fromEnv) return fromEnv;

  const hub = readHubPin();
  const fromHub = deskApiBaseFromHubPin(hub, env);
  if (fromHub) return fromHub;

  return null;
}

/**
 * Guard for chat push/pull/snapshot — require pinned Hub; refuse shared Arcade outright.
 * @throws {Error} with code NO_HUB_PINNED | SHARED_ARCADE_CHAT
 * @returns {{ ok: true, base: string }}
 */
export function assertChatDeskAllowed(env = process.env) {
  const base = deskApiBase(env);
  if (!base) {
    const err = new Error(
      [
        "No Hub pinned for chat sync — chats only go to YOUR Hub.",
        "Run: ./scripts/gotchibot db wizard",
        "Then: ./scripts/gotchibot db pin-desk  (or ./scripts/gotchibot hub enable)",
        "Or set GOTCHIBOT_DESK_API_BASE=http://<MagicDNS>:8793",
      ].join("\n"),
    );
    err.code = "NO_HUB_PINNED";
    throw err;
  }

  if (isArcadeSharedChatBase(base)) {
    const mongo = readMongoPin();
    const err = new Error(
      [
        "Chat sync must use YOUR Hub desk API (BYO Mongo), not Arcade shared home.",
        "Run: ./scripts/gotchibot db wizard",
        "Then: ./scripts/gotchibot db pin-desk",
        "Or set GOTCHIBOT_DESK_API_BASE=http://<MagicDNS>:8793",
        mongo?.kind ? `(local pin kind=${mongo.kind})` : "(no sessions/.mongo.json yet)",
      ].join("\n"),
    );
    err.code = "SHARED_ARCADE_CHAT";
    err.base = base;
    throw err;
  }

  return { ok: true, base };
}

export function resolveSubgraphUrl(subgraphName = "aavegotchi-core-base", env = process.env) {
  if (useSoloApi(env)) {
    return `${soloApiBase(env)}/api/subgraph/${subgraphName}`;
  }
  const sub = ENDPOINTS.subgraphs?.[subgraphName];
  return sub?.url || `${ENDPOINTS.gateway}/subgraphs/name/${subgraphName}`;
}

export function resolveCartridgeApiBase(env = process.env) {
  if (useSoloApi(env)) {
    return `${soloApiBase(env)}/api/cartridge-sim`;
  }
  const layer = ENDPOINTS.identityLayer || {};
  const origin = String(
    env.GOTCHIBOT_CARTRIDGE_URL || env.AARCADE_SIM_URL || env.CARTRIDGE_SIM || layer.cartridgeSim || "",
  ).replace(/\/$/, "");
  if (/\/api\/cartridge-sim$/i.test(origin)) return origin;
  if (/:(8791)\b/i.test(origin) || /^https?:\/\/cartridge\.aarcadeghst\.com$/i.test(origin)) {
    return origin;
  }
  return `${origin}/api/cartridge-sim`;
}

export function authMode(env = process.env) {
  if (useSoloApi(env)) return "solo_install_token";
  if (hasOperatorSubgraphKey(env) || hasOperatorServiceKey(env)) return "legacy_operator";
  return "none";
}

export { AUTH_CFG, ENDPOINTS, ROOT as INFRA_ROOT };
