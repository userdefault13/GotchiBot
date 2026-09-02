#!/usr/bin/env node
/**
 * Compact iMac hub status for tmux status bar (OpenClaw agent center).
 *
 * Reads sessions/.focus-list.json instantly; optionally refreshes over SSH in
 * the background when stale. OpenClaw gateway health is cached separately.
 *
 *   node scripts/imac-status.mjs            # "Hub: up · 2 run · OC✓ · tun✓ · dk✓"
 *   node scripts/imac-status.mjs --json
 *   node scripts/imac-status.mjs --refresh  # blocking roster + gateway probe
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commandExists } from "./onboarding-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = `${ROOT}/sessions`;
const FOCUS_LIST = `${SESSIONS}/.focus-list.json`;
const CACHE = `${SESSIONS}/.imac-status-cache.json`;
const FOCUS_TTL_MS = Number(process.env.GOTCHIBOT_IMAC_FOCUS_TTL_MS || 60_000);
const OC_TTL_MS = Number(process.env.GOTCHIBOT_IMAC_OC_TTL_MS || 45_000);
const ACTIVE = new Set(["running", "working", "active"]);

const json = process.argv.includes("--json");
const force = process.argv.includes("--refresh");
const probeOcOnly = process.argv.includes("--probe-oc");

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeCache(data) {
  mkdirSync(SESSIONS, { recursive: true });
  writeFileSync(CACHE, `${JSON.stringify(data, null, 2)}\n`);
}

function countImacSessions(focusList) {
  let running = 0;
  let total = 0;
  for (const e of focusList?.entries || []) {
    if (e.kind !== "session" || e.host !== "imac") continue;
    total++;
    if (ACTIVE.has(String(e.status || "").toLowerCase())) running++;
  }
  return { running, total };
}

function hasRemoteEnv() {
  return Boolean(process.env.REMOTE_HOST && process.env.SSH_PRIVATE_KEY && process.env.REMOTE_USER);
}

function canRefreshRemote() {
  return hasRemoteEnv() || commandExists("abra");
}

function spawnDetached(cmd, args) {
  const child = spawn(cmd, args, { cwd: ROOT, stdio: "ignore", detached: true });
  child.unref();
}

function refreshFocusListBlocking() {
  if (hasRemoteEnv()) {
    spawnSync(process.execPath, ["scripts/agent-focus.mjs", "list"], {
      cwd: ROOT,
      stdio: "ignore",
    });
    return;
  }
  if (commandExists("abra")) {
    spawnSync(
      "abra",
      ["run", "gotchibot", "--", process.execPath, "scripts/agent-focus.mjs", "list"],
      { cwd: ROOT, stdio: "ignore" },
    );
  }
}

function refreshFocusListBackground() {
  if (hasRemoteEnv()) {
    spawnDetached(process.execPath, ["scripts/agent-focus.mjs", "list"]);
    return;
  }
  if (commandExists("abra")) {
    spawnDetached("abra", [
      "run",
      "gotchibot",
      "--",
      process.execPath,
      "scripts/agent-focus.mjs",
      "list",
    ]);
  }
}

function focusListAgeMs(focusList) {
  if (!focusList?.at) return Infinity;
  return Date.now() - Date.parse(focusList.at);
}

function refreshOpenClawBackground() {
  const child = spawn(process.execPath, ["scripts/imac-status.mjs", "--probe-oc"], {
    cwd: ROOT,
    stdio: "ignore",
    detached: true,
  });
  child.unref();
}

function loadOpenClawReachable() {
  const cached = readJson(CACHE);
  if (!cached?.fetchedAt) {
    refreshOpenClawBackground();
    return null;
  }
  if (Date.now() - Date.parse(cached.fetchedAt) >= OC_TTL_MS) {
    refreshOpenClawBackground();
  }
  return cached.openclawReachable ?? null;
}

function saveRemoteSnapshot(payload) {
  const cached = readJson(CACHE) || {};
  writeCache({
    ...cached,
    remoteOk: payload.remoteOk,
    running: payload.running,
    total: payload.total,
    reason: payload.reason,
    remoteFetchedAt: new Date().toISOString(),
  });
}

function loadRemoteSnapshot() {
  const cached = readJson(CACHE);
  if (!cached?.remoteFetchedAt) return null;
  if (Date.now() - Date.parse(cached.remoteFetchedAt) > 5 * 60_000) return null;
  return cached;
}

function formatStatus({ remoteOk, reason, running, total, openclawReachable, staleNoSsh }) {
  const cached = readJson(CACHE) || {};
  const oc =
    openclawReachable === true ? "OC✓" : openclawReachable === false ? "OC✗" : "OC?";
  const tun =
    cached.tunnelOk === true ? "tun✓" : cached.tunnelOk === false ? "tun✗" : null;
  const dk =
    cached.dockerAvailable === false || cached.dockerAvailable == null
      ? null
      : cached.dockerUnhealthy > 0
        ? `dk ${cached.dockerUnhealthy}↓`
        : "dk✓";
  const extras = [oc, tun, dk].filter(Boolean).join(" · ");

  // Prefer Hub barLine when hub-status recently wrote one.
  if (cached.barLine && cached.hubFetchedAt) {
    const age = Date.now() - Date.parse(cached.hubFetchedAt);
    if (Number.isFinite(age) && age < 3 * 60_000) return cached.barLine;
  }

  if (staleNoSsh) {
    const snap = loadRemoteSnapshot();
    if (snap?.remoteOk === true) {
      const load =
        snap.running > 0 ? `${snap.running} run` : snap.total > 0 ? `${snap.total} idle` : "idle";
      return `Hub: up · ${load} · ${extras}`;
    }
    if (snap?.remoteOk === false) {
      return `Hub: down · ${extras}`;
    }
    return `Hub: … · ${extras}`;
  }

  if (remoteOk === false) {
    const hint = reason?.includes("no-remote-ssh-env") ? "no-ssh" : "down";
    return `Hub: ${hint} · ${extras}`;
  }

  const load =
    running > 0 ? `${running} run` : total > 0 ? `${total} idle` : "idle";
  return `Hub: up · ${load} · ${extras}`;
}

async function probeOpenClawGateway() {
  try {
    const { gatewayReachable } = await import("./openclaw-fleet.mjs");
    return await gatewayReachable();
  } catch {
    return null;
  }
}

function buildPayload() {
  const focusList = readJson(FOCUS_LIST);
  const age = focusListAgeMs(focusList);
  if (canRefreshRemote() && (force || age > FOCUS_TTL_MS)) {
    refreshFocusListBackground();
  }

  const staleNoSsh =
    focusList?.remote?.ok === false &&
    String(focusList?.remote?.reason || "").includes("no-remote-ssh-env") &&
    !hasRemoteEnv() &&
    commandExists("abra");

  let remoteOk = focusList?.remote?.ok;
  let reason = focusList?.remote?.reason || null;
  let { running, total } = countImacSessions(focusList);

  if (!staleNoSsh) {
    saveRemoteSnapshot({ remoteOk, reason, running, total });
  } else if (staleNoSsh) {
    const snap = loadRemoteSnapshot();
    if (snap) {
      remoteOk = snap.remoteOk;
      reason = snap.reason ?? reason;
      running = snap.running ?? running;
      total = snap.total ?? total;
    }
  }

  const openclawReachable = loadOpenClawReachable();

  return {
    remoteOk,
    reason,
    running,
    total,
    openclawReachable,
    staleNoSsh,
    focusListAt: focusList?.at || null,
    focusListAgeMs: Number.isFinite(age) ? age : null,
  };
}

async function main() {
  if (probeOcOnly) {
    const reachable = await probeOpenClawGateway();
    writeCache({ openclawReachable: reachable, fetchedAt: new Date().toISOString() });
    return;
  }

  if (force) {
    refreshFocusListBlocking();
    const reachable = await probeOpenClawGateway();
    writeCache({ openclawReachable: reachable, fetchedAt: new Date().toISOString() });
  }

  const payload = buildPayload();
  const line = formatStatus(payload);

  if (json) {
    console.log(JSON.stringify({ ...payload, line }, null, 2));
  } else {
    console.log(line);
  }
}

main().catch(() => {
  console.log("Hub: ?");
});
