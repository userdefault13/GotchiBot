#!/usr/bin/env node
/**
 * Hub monitor — Desk view of the always-on OpenClaw fleet host (iMac).
 *
 *   node scripts/hub-status.mjs              # dashboard
 *   node scripts/hub-status.mjs --json
 *   node scripts/hub-status.mjs --live       # refresh mesh cache first
 *   node scripts/hub-status.mjs --infra      # Docker table via SSH infra-monitor
 *   node scripts/hub-status.mjs infra
 *
 * Secrets stay in env (abra run gotchibot -- …); never logged.
 * Does not modify themes or color config.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { remoteConfig, materializeKey, runSsh } from "./remote-lib.mjs";
import { getTopology } from "./topology.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = `${ROOT}/sessions`;
const FOCUS_LIST = `${SESSIONS}/.focus-list.json`;
const IMAC_CACHE = `${SESSIONS}/.imac-status-cache.json`;
const ACTIVE = new Set(["running", "working", "active"]);

function parseArgs(argv) {
  const out = { json: false, live: false, infra: false, help: false };
  for (const a of argv) {
    if (a === "--json") out.json = true;
    else if (a === "--live") out.live = true;
    else if (a === "--infra" || a === "infra") out.infra = true;
    else if (a === "status") continue;
    else if (a === "-h" || a === "--help") out.help = true;
  }
  return out;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeImacCachePatch(patch) {
  mkdirSync(SESSIONS, { recursive: true });
  const cur = readJson(IMAC_CACHE) || {};
  writeFileSync(
    IMAC_CACHE,
    `${JSON.stringify({ ...cur, ...patch, hubFetchedAt: new Date().toISOString() }, null, 2)}\n`,
  );
}

function refreshFocusList() {
  spawnSync(process.execPath, [`${ROOT}/scripts/agent-focus.mjs`, "list"], {
    cwd: ROOT,
    stdio: "ignore",
  });
}

function countSessions(focusList) {
  const out = {
    mbp: { running: 0, total: 0 },
    imac: { running: 0, total: 0 },
  };
  for (const e of focusList?.entries || []) {
    if (e.kind !== "session") continue;
    const bucket = e.host === "imac" ? out.imac : e.host === "local" ? out.mbp : null;
    if (!bucket) continue;
    bucket.total++;
    if (ACTIVE.has(String(e.status || "").toLowerCase())) bucket.running++;
  }
  return out;
}

function sshReady() {
  const cfg = remoteConfig();
  return Boolean(cfg.host && cfg.user && cfg.key);
}

function withSsh(fn) {
  if (!sshReady()) {
    return { ok: false, reason: "no-remote-ssh-env (abra run gotchibot -- …)" };
  }
  const cfg = remoteConfig();
  const key = materializeKey(cfg.key);
  try {
    return fn(cfg, key.path);
  } finally {
    key.dispose();
  }
}

function probeSsh() {
  return withSsh((cfg, keyPath) => {
    const r = runSsh(cfg, keyPath, "echo ok && hostname", { stdio: "pipe" });
    if (r.status !== 0) {
      return {
        ok: false,
        reason: (r.stderr || r.stdout || "ssh failed").trim().slice(0, 120) || "ssh failed",
        host: cfg.host,
      };
    }
    return { ok: true, host: cfg.host, detail: (r.stdout || "").trim() };
  });
}

function probeDockerSummary() {
  return withSsh((cfg, keyPath) => {
    const r = runSsh(
      cfg,
      keyPath,
      'docker ps -a --format "{{.Names}}|{{.Status}}" 2>/dev/null',
      { stdio: "pipe" },
    );
    if (r.status !== 0) {
      return {
        ok: false,
        available: false,
        reason: (r.stderr || "docker unavailable").trim().slice(0, 120),
        up: 0,
        unhealthy: 0,
        total: 0,
        containers: [],
      };
    }
    const containers = (r.stdout || "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const idx = line.indexOf("|");
        const name = idx === -1 ? line : line.slice(0, idx);
        const status = idx === -1 ? "" : line.slice(idx + 1);
        const isUp = status.startsWith("Up");
        const unhealthy = /\(unhealthy\)/.test(status);
        return { name, status, healthy: isUp && !unhealthy, up: isUp };
      });
    const up = containers.filter((c) => c.up).length;
    const unhealthy = containers.filter((c) => !c.healthy).length;
    return {
      ok: containers.length > 0 && unhealthy === 0,
      available: true,
      up,
      unhealthy,
      total: containers.length,
      containers,
    };
  });
}

function runInfraRemote() {
  return withSsh((cfg, keyPath) => {
    const r = runSsh(
      cfg,
      keyPath,
      "node scripts/infra-monitor-cron.mjs --json",
      { stdio: "pipe" },
    );
    // infra-monitor exits 1 when degraded — still parse JSON from stdout
    const text = (r.stdout || "").trim();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      return {
        ok: false,
        reason:
          (r.stderr || text || `infra-monitor exit ${r.status}`).trim().slice(0, 200) ||
          "infra-monitor failed",
      };
    }
    return { ok: true, exit: r.status, report: body };
  });
}

async function probeOpenClaw() {
  try {
    const { gatewayReachable, gatewayUrl, loadAgentMap, loadOpenClawFocus } = await import(
      "./openclaw-fleet.mjs"
    );
    const reachable = await gatewayReachable();
    const map = loadAgentMap();
    const focus = loadOpenClawFocus();
    const agentCount = map?.agents ? Object.keys(map.agents).length : map?.count ?? 0;
    return {
      reachable,
      gateway: gatewayUrl(),
      agentCount,
      focus: focus
        ? { mode: focus.mode, agentId: focus.agentId, heroId: focus.heroId }
        : null,
    };
  } catch (e) {
    return { reachable: null, gateway: null, agentCount: 0, focus: null, error: String(e?.message || e) };
  }
}

async function probeTunnel() {
  try {
    const r = spawnSync(process.execPath, [`${ROOT}/scripts/tunnel-health.mjs`, "--json"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 20_000,
    });
    if (r.stdout) {
      try {
        const j = JSON.parse(r.stdout);
        // tunnel-health --json shape may vary — accept common fields
        const probes = j.probes || j.results || [];
        const first = Array.isArray(probes) ? probes[0] : null;
        if (first) return { ok: Boolean(first.ok), detail: first.error || first.label || null };
        if (typeof j.ok === "boolean") return { ok: j.ok, detail: j.error || null };
      } catch {}
    }
    return { ok: r.status === 0, detail: r.status === 0 ? null : "tunnel probe failed" };
  } catch (e) {
    return { ok: false, detail: String(e?.message || e) };
  }
}

function dockerChip(docker) {
  if (!docker || docker.available === false) return "dk?";
  if (docker.unhealthy > 0) return `dk ${docker.unhealthy}↓`;
  if (docker.ok) return "dk✓";
  return "dk?";
}

function printInfraTable(docker) {
  console.log("");
  console.log("Docker (Hub)");
  if (!docker?.available) {
    console.log(`  unavailable — ${docker?.reason || docker?.error || "unknown"}`);
    return;
  }
  const rows = docker.containers || [];
  if (!rows.length) {
    console.log("  (no containers)");
    return;
  }
  const nameW = Math.min(40, Math.max(12, ...rows.map((c) => c.name.length)));
  console.log(`  ${"NAME".padEnd(nameW)}  STATUS`);
  console.log(`  ${"—".repeat(nameW)}  ${"—".repeat(24)}`);
  for (const c of rows) {
    const mark = c.healthy ? "✓" : "✗";
    console.log(`  ${mark} ${c.name.padEnd(nameW)}  ${c.status}`);
  }
}

function probeBridgeDesk() {
  const cfg = readJson(`${ROOT}/config/hub-bridge.json`) || {};
  const url =
    process.env.GOTCHIBOT_HUB_BRIDGE_URL ||
    cfg.url ||
    `http://${cfg.host || "localhost"}:${cfg.bridgePort || 45678}${cfg.bridgePath || "/prompt"}`;
  const health = String(url).replace(/\/prompt\/?$/, "/health");
  const r = spawnSync("curl", ["-sf", "--max-time", "2", health], {
    encoding: "utf8",
  });
  const recv = spawnSync(
    "curl",
    ["-sf", "--max-time", "2", "http://127.0.0.1:45679/health"],
    { encoding: "utf8" },
  );
  return {
    ok: r.status === 0,
    health,
    url: String(url),
    receiverOk: recv.status === 0,
  };
}

function printHuman(payload) {
  const host = payload.ssh?.host || process.env.REMOTE_HOST || "hub";
  console.log(`Hub · ${host}`);
  console.log(`  SSH        ${payload.ssh?.ok ? "up" : `down${payload.ssh?.reason ? ` — ${payload.ssh.reason}` : ""}`}`);
  const oc = payload.openclaw;
  const ocLabel =
    oc?.reachable === true ? "up" : oc?.reachable === false ? "down" : "?";
  console.log(
    `  OpenClaw   ${ocLabel}${oc?.gateway ? `  ${oc.gateway}` : ""}${oc?.error ? ` — ${oc.error}` : ""}`,
  );
  const br = payload.bridge;
  if (br) {
    console.log(
      `  VS Bridge  ${br.ok ? "up" : "down"}  ${br.health || ""}${br.receiverOk === false ? " · recv✗" : br.receiverOk ? " · recv✓" : ""}`,
    );
  }
  const focus = oc?.focus
    ? `focus ${oc.focus.mode || "?"}${oc.focus.heroId ? ` · ${oc.focus.heroId}` : ""}`
    : "focus —";
  console.log(`  Fleet      ${oc?.agentCount ?? 0} agents · ${focus}`);
  const s = payload.sessions;
  console.log(
    `  Sessions   MBP ${s?.mbp?.running ?? 0} run/${s?.mbp?.total ?? 0} · iMac ${s?.imac?.running ?? 0} run/${s?.imac?.total ?? 0}`,
  );
  console.log(
    `  Tunnel     ${payload.tunnel?.ok ? "ok" : payload.tunnel?.ok === false ? "down" : "?"}${payload.tunnel?.detail ? ` — ${payload.tunnel.detail}` : ""}`,
  );
  const d = payload.docker;
  if (d?.available) {
    console.log(`  Docker     ${d.up} up · ${d.unhealthy} unhealthy · ${d.total} total`);
  } else {
    console.log(`  Docker     ${d?.reason || "unavailable"}`);
  }
  console.log(`  Topology   ${payload.topology?.mode || "?"} (${payload.topology?.source || "?"})`);
  if (payload.barLine) console.log(`  Bar        ${payload.barLine}`);
}

async function buildStatus({ live }) {
  if (live) refreshFocusList();

  const focusList = readJson(FOCUS_LIST);
  const sessions = countSessions(focusList);
  const topo = getTopology();

  const ssh = probeSsh();
  const openclaw = await probeOpenClaw();
  const tunnel = await probeTunnel();
  const bridge = probeBridgeDesk();

  let docker = {
    ok: null,
    available: false,
    up: 0,
    unhealthy: 0,
    total: 0,
    containers: [],
    reason: "skipped (SSH down)",
  };
  if (ssh.ok) {
    docker = probeDockerSummary();
  } else if (!sshReady()) {
    docker.reason = "no-remote-ssh-env";
  } else {
    docker.reason = ssh.reason || "ssh down";
  }

  const remoteOk = ssh.ok === true;
  const barLine = [
    `Hub: ${remoteOk ? "up" : "down"}`,
    sessions.imac.running > 0
      ? `${sessions.imac.running} run`
      : sessions.imac.total > 0
        ? `${sessions.imac.total} idle`
        : "idle",
    openclaw.reachable === true ? "OC✓" : openclaw.reachable === false ? "OC✗" : "OC?",
    bridge.ok ? "br✓" : "br✗",
    tunnel.ok === true ? "tun✓" : tunnel.ok === false ? "tun✗" : "tun?",
    dockerChip(docker),
  ].join(" · ");

  writeImacCachePatch({
    remoteOk,
    running: sessions.imac.running,
    total: sessions.imac.total,
    reason: ssh.reason || null,
    openclawReachable: openclaw.reachable,
    bridgeOk: bridge.ok,
    receiverOk: bridge.receiverOk,
    tunnelOk: tunnel.ok,
    dockerUp: docker.up,
    dockerUnhealthy: docker.unhealthy,
    dockerAvailable: docker.available,
    barLine,
    fetchedAt: new Date().toISOString(),
    remoteFetchedAt: new Date().toISOString(),
  });

  return {
    at: new Date().toISOString(),
    ssh,
    openclaw,
    bridge,
    sessions,
    tunnel,
    docker: {
      ok: docker.ok,
      available: docker.available,
      up: docker.up,
      unhealthy: docker.unhealthy,
      total: docker.total,
      reason: docker.reason || null,
    },
    topology: { mode: topo.mode, source: topo.source },
    barLine,
    focusListAt: focusList?.at || null,
  };
}

async function buildInfra() {
  const ssh = probeSsh();
  if (!ssh.ok) {
    return {
      at: new Date().toISOString(),
      ssh,
      ok: false,
      reason: ssh.reason || "Hub unreachable",
    };
  }
  const remote = runInfraRemote();
  if (!remote.ok) {
    // Fallback: local docker table via SSH docker ps
    const docker = probeDockerSummary();
    return {
      at: new Date().toISOString(),
      ssh,
      ok: false,
      reason: remote.reason,
      docker,
      fallback: true,
    };
  }
  const report = remote.report;
  // Prefer containers from extended JSON; else re-probe docker ps
  let docker = probeDockerSummary();
  if (report?.docker?.containers?.length) {
    docker = {
      ok: report.docker.ok,
      available: report.docker.available !== false,
      up: report.docker.containers.filter((c) => String(c.status || "").startsWith("Up")).length,
      unhealthy: report.docker.containers.filter((c) => !c.healthy).length,
      total: report.docker.containers.length,
      containers: report.docker.containers,
    };
  }
  writeImacCachePatch({
    dockerUp: docker.up,
    dockerUnhealthy: docker.unhealthy,
    dockerAvailable: docker.available,
    tunnelOk: report?.tunnel?.ok ?? null,
  });
  return {
    at: new Date().toISOString(),
    ssh,
    ok: Boolean(report?.overall),
    report,
    docker,
    subgraph: report?.subgraph || null,
    tunnel: report?.tunnel || null,
    log: report?.log || null,
  };
}

function printInfraHuman(payload) {
  const host = payload.ssh?.host || "hub";
  console.log(`Hub infra · ${host}`);
  if (!payload.ssh?.ok) {
    console.log(`  SSH down — ${payload.reason || payload.ssh?.reason || "unreachable"}`);
    return;
  }
  if (payload.fallback) {
    console.log(`  note: infra-monitor JSON failed — ${payload.reason}`);
    console.log("  showing docker ps fallback");
  } else {
    console.log(`  overall    ${payload.ok ? "OK" : "DEGRADED"}`);
    if (payload.subgraph) {
      console.log(
        `  subgraph   ${payload.subgraph.ok ? "ok" : "FAIL"}${payload.subgraph.block != null ? ` · block ${payload.subgraph.block}` : ""}`,
      );
    }
    if (payload.tunnel) {
      console.log(`  tunnel     ${payload.tunnel.ok ? "ok" : "DOWN"}`);
    }
    if (payload.log) console.log(`  log        ${payload.log}`);
  }
  printInfraTable(payload.docker);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`usage: hub-status.mjs [status] [--json] [--live] [--infra|infra]
  status   Hub dashboard (SSH, OpenClaw, mesh, tunnel, docker summary)
  --infra  Docker container table via iMac infra-monitor
  --live   refresh agent focus-list before dashboard
  --json   machine-readable`);
    process.exit(0);
  }

  if (opts.infra) {
    const payload = await buildInfra();
    if (opts.json) console.log(JSON.stringify(payload, null, 2));
    else printInfraHuman(payload);
    process.exit(payload.ssh?.ok === false ? 1 : payload.ok === false && !payload.fallback ? 1 : 0);
  }

  const payload = await buildStatus({ live: opts.live });
  if (opts.json) console.log(JSON.stringify(payload, null, 2));
  else printHuman(payload);
  process.exit(payload.ssh?.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
