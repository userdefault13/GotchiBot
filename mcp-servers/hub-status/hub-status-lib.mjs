/**
 * Read-only Hub snapshot and the OpenClaw gateway-check predicate.
 *
 * Does not SSH, fetch, or spawn. Hub ok/bad/? comes from
 * sessions/.imac-status-cache.json using the same words as hub-status.mjs
 * (remoteOk true → ok, ssh-not-ready → ?, ssh attempted and down → bad).
 * Whether the gateway check would run follows statusGatewayReachable and
 * hubHealthRoute in scripts/openclaw-fleet.mjs, stopping before any probe.
 */
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hubHealthRoute, shortHostName, gatewayListenPort } from "../../scripts/openclaw-fleet.mjs";
import { remoteConfig } from "../../scripts/remote-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const CACHE_REL = "sessions/.imac-status-cache.json";

const ALLOWED = [
  "remoteOk",
  "running",
  "total",
  "reason",
  "openclawReachable",
  "bridgeOk",
  "receiverOk",
  "tunnelOk",
  "dockerUp",
  "dockerUnhealthy",
  "dockerAvailable",
  "barLine",
  "fetchedAt",
  "remoteFetchedAt",
  "hubFetchedAt",
];

const SECRET_KEY = /token|password|passwd|secret|cookie|authorization|credential|private[-_]?key|api[-_]?key|bearer|session/i;

function looksSecret(value) {
  if (typeof value !== "string") return false;
  const s = value.trim();
  if (!s) return false;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(s)) return true;
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s)) return true;
  if (/^(sk|rk|pk)_[A-Za-z0-9]{8,}$/.test(s)) return true;
  if (/^[A-Za-z0-9+/_=-]{40,}$/.test(s) && !/^\d{4}-\d{2}-\d{2}T/.test(s)) return true;
  return false;
}

/** Drop secret-looking keys and values. Unknown keys are not copied. */
export function publicCacheFields(cache) {
  if (!cache || typeof cache !== "object" || Array.isArray(cache)) return {};
  const out = {};
  for (const key of ALLOWED) {
    if (!Object.prototype.hasOwnProperty.call(cache, key)) continue;
    if (SECRET_KEY.test(key)) continue;
    const value = cache[key];
    if (value == null) {
      out[key] = value;
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
      continue;
    }
    if (typeof value === "string") {
      if (looksSecret(value)) continue;
      if (key === "reason" && value.length > 200) continue;
      out[key] = value;
    }
  }
  return out;
}

/**
 * Hub word from a snapshot. ok / bad / ? only.
 * Matches scripts/hub-status.mjs: remoteOk → ok, ssh not ready → ?, else bad.
 * "Hub: no-ssh" from the status-bar formatter is unknown (?).
 */
export function hubWord(cache) {
  if (!cache || typeof cache !== "object") return "?";
  if (cache.remoteOk === true) return "ok";
  if (cache.remoteOk === false) {
    const reason = String(cache.reason || "");
    if (reason.includes("no-remote-ssh-env")) return "?";
    return "bad";
  }
  const line = typeof cache.barLine === "string" ? cache.barLine : "";
  const m = line.match(/^Hub:\s*(\S+)/);
  if (m) {
    if (m[1] === "ok" || m[1] === "bad") return m[1];
    return "?";
  }
  return "?";
}

export function readHubSnapshot(root = ROOT) {
  const path = resolve(root, CACHE_REL);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") {
      return { snapshot: "missing", hub: "?", fields: {} };
    }
    return { snapshot: "invalid", hub: "?", fields: {} };
  }
  let cache;
  try {
    cache = JSON.parse(raw);
  } catch {
    return { snapshot: "invalid", hub: "?", fields: {} };
  }
  if (!cache || typeof cache !== "object" || Array.isArray(cache)) {
    return { snapshot: "invalid", hub: "?", fields: {} };
  }
  return { snapshot: "present", hub: hubWord(cache), fields: publicCacheFields(cache) };
}

/**
 * Would statusGatewayReachable run the remote (SSH curl) gateway check?
 * Local loopback is a separate boolean. Neither is performed here.
 *
 * wouldRun is the remote check: true, false, or null (unknown).
 * null means the repo gates that SSH on a loopback /healthz we refuse to open.
 */
export function decideGatewayWouldRun({ port, route, hostname: name }) {
  const localProbeWouldRun = /^\d+$/.test(String(port ?? ""));
  if (!localProbeWouldRun) {
    return {
      wouldRun: false,
      localProbeWouldRun: false,
      remoteCheckWouldRun: false,
      routeKind: route?.kind || "none",
      reason:
        "listen port is not all digits; statusGatewayReachable returns null and does not probe",
    };
  }
  const kind = route?.kind || "none";
  const host = route?.host ? String(route.host) : "";
  if (!host || kind === "none") {
    return {
      wouldRun: false,
      localProbeWouldRun: true,
      remoteCheckWouldRun: false,
      routeKind: kind,
      reason:
        "hubHealthRoute has no SSH target, so the remote OpenClaw gateway check would not run. statusGatewayReachable would still try loopback /healthz; this tool did not open it",
    };
  }
  if (shortHostName(name) && shortHostName(name) === shortHostName(host)) {
    return {
      wouldRun: false,
      localProbeWouldRun: true,
      remoteCheckWouldRun: false,
      routeKind: kind,
      reason:
        "this machine is the hub (short hostname matches hubHealthRoute), so statusGatewayReachable probes loopback only and does not SSH. This tool did not connect",
    };
  }
  return {
    wouldRun: null,
    localProbeWouldRun: true,
    remoteCheckWouldRun: null,
    routeKind: kind,
    reason:
      "unknown: hubHealthRoute would allow a remote check and this host is not the hub. statusGatewayReachable probes loopback /healthz first and SSHes only if that probe is inconclusive. The probe was not run, so whether the remote check would run is unknown",
  };
}

export function gatewayCheckWouldRun() {
  const cfg = remoteConfig();
  const route = hubHealthRoute({ host: cfg.host, user: cfg.user, key: cfg.key });
  return decideGatewayWouldRun({
    port: gatewayListenPort(),
    route,
    hostname: hostname(),
  });
}
