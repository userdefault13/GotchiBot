#!/usr/bin/env node
/**
 * Shared Claude bridge role + URL resolution.
 * Desk (remote clients on Tailscale/LAN) always use Hub bridge — never a local Claude.
 * Hub uses localhost :45678. Docker uses host.docker.internal.
 */
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HUB_CFG = join(ROOT, "config/hub-bridge.json");

export function loadHubBridgeConfig() {
  try {
    if (!existsSync(HUB_CFG)) return {};
    return JSON.parse(readFileSync(HUB_CFG, "utf8"));
  } catch {
    return {};
  }
}

export function inDocker() {
  return (
    process.env.GOTCHIBOT_IN_DOCKER === "1" ||
    existsSync("/.dockerenv")
  );
}

export function isHubMachine() {
  if (process.env.GOTCHIBOT_ROLE === "hub" || process.env.GOTCHIBOT_ON_HUB === "1") {
    return true;
  }
  const h = String(hostname() || "").toLowerCase();
  if (/imac/.test(h)) return true;
  const cfg = loadHubBridgeConfig();
  const hubHost = String(cfg.host || "").toLowerCase();
  if (hubHost && (h === hubHost || h.startsWith(hubHost.split(".")[0]))) return true;
  return false;
}

/** Hub Tailscale / MagicDNS / LAN hostname for network desks. */
export function hubNetworkHost() {
  return (
    process.env.GOTCHIBOT_HUB_HOST?.trim() ||
    process.env.REMOTE_HOST?.trim() ||
    process.env.GOTCHIBOT_REMOTE_HOST?.trim() ||
    loadHubBridgeConfig().host ||
    "localhost"
  );
}

/**
 * Receiver endpoint for desks that cannot reach the bridge directly (e.g. from
 * inside Docker). Resolved from env, then config, then the local host — never a
 * hardcoded address, which would only ever be correct on one person's network.
 */
export function hubReceiverUrl() {
  const explicit = process.env.GOTCHIBOT_RECEIVER_URL?.trim();
  if (explicit) return explicit;
  const cfg = loadHubBridgeConfig();
  const port = cfg.receiverPort || 45679;
  return `http://${hubNetworkHost()}:${port}`;
}

export function hubBridgeHttpUrl() {
  if (process.env.GOTCHIBOT_BRIDGE_URL?.trim()) {
    const u = process.env.GOTCHIBOT_BRIDGE_URL.trim();
    return u.endsWith("/prompt") ? u : `${u.replace(/\/$/, "")}/prompt`;
  }
  const cfg = loadHubBridgeConfig();
  const port = Number(process.env.GOTCHIBOT_BRIDGE_PORT || cfg.bridgePort || 45678);
  const path = cfg.bridgePath || "/prompt";
  if (inDocker()) {
    return `http://host.docker.internal:${port}${path.startsWith("/") ? path : `/${path}`}`;
  }
  if (isHubMachine()) {
    return `http://127.0.0.1:${port}${path.startsWith("/") ? path : `/${path}`}`;
  }
  // Desk / remote client on same Tailscale/LAN → Hub bridge over the network
  return `http://${hubNetworkHost()}:${port}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * @returns {"local"|"imac"|"network"}
 * - local: Hub (or Docker → host bridge)
 * - network: Desk HTTP to Hub:45678 (same Tailscale/LAN)
 * - imac: Desk SSH tunnel POST (fallback when HTTP blocked)
 */
export function resolveClaudeHostMode(explicit) {
  const forced = (explicit || process.env.GOTCHIBOT_CLAUDE_HOST || "").toLowerCase();
  if (forced === "local" || forced === "imac" || forced === "network") return forced;

  if (inDocker() || isHubMachine()) return "local";

  // Remote desks: always Hub bridge. Prefer network HTTP; bridge-prompt falls back to SSH.
  if (process.env.GOTCHIBOT_CLAUDE_VIA === "ssh") return "imac";
  return "network";
}

export function probeBridgeHttp(url, { timeoutMs = 2500 } = {}) {
  try {
    const r = spawnSync(
      "curl",
      [
        "-sS",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "--max-time",
        String(Math.max(1, Math.ceil(timeoutMs / 1000))),
        "-X",
        "POST",
        "-H",
        "Content-Type: application/json",
        "-d",
        "{}",
        url,
      ],
      { encoding: "utf8" },
    );
    const code = String(r.stdout || "").trim();
    return r.status === 0 && /^(200|202|400)$/.test(code);
  } catch {
    return false;
  }
}
