#!/usr/bin/env node
/**
 * Outbound auth for Solo infra (install token) vs legacy operator secrets.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENDPOINTS = JSON.parse(readFileSync(`${ROOT}/config/subgraph.endpoints.json`, "utf8"));
const AUTH_CFG = JSON.parse(readFileSync(`${ROOT}/config/infra.auth.json`, "utf8"));

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

export { AUTH_CFG, ENDPOINTS };
