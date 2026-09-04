#!/usr/bin/env node
/**
 * Hub agent monitor — tmux tiled truth board (not the chat/avatar layout).
 *
 * Shows live agent / Claude-job / bridge state so Desk "running" theater
 * cannot hide a dead Hub Claude pane.
 *
 *   node scripts/hub-agent-monitor.mjs snapshot [--json]
 *   node scripts/hub-agent-monitor.mjs dashboard [--json]
 *   node scripts/hub-agent-monitor.mjs print
 *   node scripts/hub-agent-monitor.mjs watch [--interval 2]
 *   node scripts/hub-agent-monitor.mjs open [--attach] [--slots N] [--force]
 *   node scripts/hub-agent-monitor.mjs pane [--slot overview|openclaw|bridge|N]
 *   node scripts/hub-agent-monitor.mjs kill
 *
 * Prefer: ./scripts/gotchibot hub dashboard | hub monitor
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SESS = "gotchibot-hubmon";
const JOBS_DIR = join(ROOT, "var/claude-jobs");
const FOCUS = join(ROOT, "sessions/.focus.json");
const SESSIONS = join(ROOT, "sessions");

function usage() {
  console.error(`usage:
  hub-agent-monitor.mjs snapshot [--json]
  hub-agent-monitor.mjs dashboard [--json]
  hub-agent-monitor.mjs print
  hub-agent-monitor.mjs watch [--interval SEC]
  hub-agent-monitor.mjs open [--attach] [--slots N] [--force]
  hub-agent-monitor.mjs pane [--slot overview|openclaw|bridge|N] [--interval SEC]
  hub-agent-monitor.mjs kill

Prefer: ./scripts/gotchibot hub dashboard | hub monitor`);
  process.exit(2);
}

function loadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function listClaudeJobs() {
  if (!existsSync(JOBS_DIR)) return [];
  const out = [];
  for (const f of readdirSync(JOBS_DIR)) {
    if (!f.endsWith(".json") || f === "events.jsonl") continue;
    const j = loadJson(join(JOBS_DIR, f));
    if (!j?.id) continue;
    out.push({
      id: j.id,
      status: j.status || "?",
      ok: j.ok,
      reportsTo: j.meta?.reportsTo || j.meta?.heroId || extractReportsTo(j.prompt),
      promptPreview: String(j.prompt || "")
        .replace(/\s+/g, " ")
        .replace(/^\[GotchiBot[^\]]*\]\s*/i, "")
        .slice(0, 120),
      createdAt: j.createdAt,
      updatedAt: j.updatedAt || j.resultAt,
    });
  }
  out.sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
  return out;
}

function extractReportsTo(prompt) {
  const m = String(prompt || "").match(/reports_to[=:\s]+([a-z0-9._-]+)/i);
  return m ? m[1] : null;
}

function listDispatchSessions() {
  if (!existsSync(SESSIONS)) return [];
  const out = [];
  for (const name of readdirSync(SESSIONS)) {
    if (!name.startsWith("s") && !name.startsWith("session")) continue;
    const dir = join(SESSIONS, name);
    const st = loadEnv(join(dir, "state.env"));
    if (!st) continue;
    const status = st.status || "?";
    if (!/running|pending|starting|queued/i.test(status) && !st.hero) continue;
    out.push({
      id: name,
      status,
      hero: st.hero || st.GOTCHIBOT_HERO_ID || st.heroId || null,
      model: st.model || null,
      started: st.started || st.startedAt || null,
      host: st.host || "local",
    });
  }
  return out;
}

function loadEnv(path) {
  if (!existsSync(path)) return null;
  const o = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) o[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return o;
}

function probeBridge() {
  const cfg = loadJson(join(ROOT, "config/hub-bridge.json")) || {};
  const url =
    process.env.GOTCHIBOT_HUB_BRIDGE_URL ||
    cfg.url ||
    `http://${cfg.host || "localhost"}:${cfg.bridgePort || 45678}${cfg.bridgePath || "/prompt"}`;
  const health = String(url).replace(/\/prompt\/?$/, "/health");
  const r = spawnSync("curl", ["-sf", "--max-time", "2", "-w", "\n%{http_code}", health], {
    encoding: "utf8",
  });
  const raw = String(r.stdout || "").trim();
  const lines = raw.split("\n");
  const code = lines.length > 1 ? lines.pop() : "";
  const body = lines.join("\n").slice(0, 120);
  return {
    ok: r.status === 0,
    health,
    url: String(url),
    httpCode: code || null,
    body,
    fix: "abra run gotchibot -- ./scripts/gotchibot hub bridge-ensure",
  };
}

function probeReceiver() {
  const r = spawnSync(
    "curl",
    ["-sf", "--max-time", "2", "http://127.0.0.1:45679/health"],
    { encoding: "utf8" },
  );
  return { ok: r.status === 0, body: String(r.stdout || "").trim().slice(0, 80), port: 45679 };
}

function probeOpenClaw() {
  let gateway = "http://127.0.0.1:18789";
  const envUrl =
    process.env.OPENCLAW_GATEWAY_URL?.trim() ||
    process.env.GOTCHIBOT_OPENCLAW_URL?.trim() ||
    "";
  if (envUrl) {
    gateway = envUrl.replace(/\/$/, "");
  } else {
    const file =
      loadJson(join(ROOT, "sessions/.openclaw-gateway.json")) ||
      loadJson(join(ROOT, "config/openclaw-gateway.json"));
    if (file?.url) gateway = String(file.url).replace(/\/$/, "");
    else if (file?.host) {
      gateway = `http://${file.host}:${file.port || 18789}`;
    } else if (process.env.REMOTE_HOST || process.env.GOTCHIBOT_REMOTE_HOST) {
      const h = process.env.REMOTE_HOST || process.env.GOTCHIBOT_REMOTE_HOST;
      gateway = `http://${h}:18789`;
    }
  }
  const healthz = `${gateway}/healthz`;
  const r = spawnSync("curl", ["-sf", "--max-time", "2", "-w", "\n%{http_code}", healthz], {
    encoding: "utf8",
  });
  const raw = String(r.stdout || "").trim();
  const lines = raw.split("\n");
  const code = lines.length > 1 ? lines.pop() : "";
  return {
    ok: r.status === 0,
    gateway,
    healthz,
    httpCode: code || null,
    body: lines.join("\n").slice(0, 80),
    fix: "abra run gotchibot -- ./scripts/gotchibot hub restart-gateway",
  };
}

export function snapshot() {
  const jobs = listClaudeJobs();
  const byStatus = {};
  for (const j of jobs) {
    byStatus[j.status] = (byStatus[j.status] || 0) + 1;
  }
  const focus = loadJson(FOCUS) || {};
  const sessions = listDispatchSessions();
  const bridge = probeBridge();
  const receiver = probeReceiver();
  const openclaw = probeOpenClaw();
  const tiles = buildTiles({ jobs, sessions, focus, bridge, receiver, openclaw });
  const infraOk = Boolean(bridge.ok && openclaw.ok);
  return {
    at: new Date().toISOString(),
    dashboard: {
      openclaw: mark(openclaw.ok),
      bridge: mark(bridge.ok),
      receiver: mark(receiver.ok),
      overall: infraOk ? "healthy" : "degraded",
    },
    openclaw,
    bridge,
    receiver,
    focus: {
      mode: focus.mode || "orch",
      heroId: focus.heroId || null,
      sessionId: focus.sessionId || null,
      host: focus.host || null,
    },
    jobs: { counts: byStatus, recent: jobs.slice(0, 12) },
    sessions,
    tiles,
    truth: {
      deskCanLie: true,
      note: !openclaw.ok
        ? "OpenClaw gateway DOWN (OC✗) — Hub fleet unreachable"
        : !bridge.ok
          ? "VS Code bridge DOWN — Desk may show agents running while Hub Claude is idle"
          : "Gateway + bridge up — Claude pane path reachable",
    },
  };
}

function mark(ok) {
  return ok ? "UP" : "DOWN";
}

function buildTiles({ jobs, sessions, focus, bridge, receiver, openclaw }) {
  const tiles = [
    {
      kind: "dashboard",
      title: "HUB DASHBOARD",
      lines: [
        `OpenClaw  ${openclaw.ok ? "✓ UP" : "✗ DOWN"}  ${openclaw.gateway}`,
        `Bridge    ${bridge.ok ? "✓ UP" : "✗ DOWN"}  ${bridge.health}`,
        `Receiver  ${receiver.ok ? "✓" : "✗"} Desk :${receiver.port}`,
        `Focus     ${focus.mode === "sub" ? `SUB ${focus.heroId || "?"}` : "ORCH"}`,
        `Jobs      ${summarizeCounts(jobs)}`,
        `Sessions  ${sessions.length} tracked`,
        !openclaw.ok
          ? `FIX gateway: ${openclaw.fix}`
          : !bridge.ok
            ? `FIX bridge: ${bridge.fix}`
            : "Infra OK — watch agent tiles for work",
      ],
    },
    {
      kind: "openclaw",
      title: "OPENCLAW GATEWAY",
      lines: [
        `status   ${openclaw.ok ? "✓ UP (OC✓)" : "✗ DOWN (OC✗)"}`,
        `url      ${openclaw.gateway}`,
        `healthz  ${openclaw.healthz}`,
        `http     ${openclaw.httpCode || (openclaw.ok ? "200" : "fail")}`,
        openclaw.ok ? "Fleet chat / spawn path reachable" : `FIX: ${openclaw.fix}`,
      ],
    },
    {
      kind: "bridge",
      title: "VS CODE BRIDGE",
      lines: [
        `status   ${bridge.ok ? "✓ UP" : "✗ DOWN"}`,
        `health   ${bridge.health}`,
        `prompt   ${bridge.url}`,
        `recv     Desk :${receiver.port} ${receiver.ok ? "✓" : "✗"}`,
        bridge.ok
          ? "Claude pane /submit path reachable"
          : `FIX: ${bridge.fix}`,
      ],
    },
  ];

  const pending = jobs.filter((j) => j.status === "pending");
  const ready = jobs.filter((j) => j.status === "ready").slice(0, 4);
  const runningSess = sessions.filter((s) => /running|pending|starting/i.test(s.status));

  for (const j of pending) {
    tiles.push({
      kind: "claude-job",
      title: `PENDING ${j.id}`,
      hero: j.reportsTo,
      lines: [
        `status  pending (Hub accepted / waiting result)`,
        `hero    ${j.reportsTo || "—"}`,
        `prompt  ${j.promptPreview || "—"}`,
        `since   ${j.createdAt || "—"}`,
        bridge.ok
          ? "If Hub Claude pane is empty → paste/UI path failed; check bridge log"
          : "Bridge down — this job cannot reach Claude pane",
      ],
    });
  }

  for (const s of runningSess) {
    tiles.push({
      kind: "session",
      title: `SESS ${s.id}`,
      hero: s.hero,
      lines: [
        `status  ${s.status}`,
        `hero    ${s.hero || "—"}`,
        `host    ${s.host || "—"}`,
        `model   ${s.model || "—"}`,
        `started ${s.started || "—"}`,
        "Desk 'running' ≠ Hub Claude activity unless bridge+pane alive",
      ],
    });
  }

  for (const j of ready) {
    tiles.push({
      kind: "claude-job",
      title: `READY ${j.id}`,
      hero: j.reportsTo,
      lines: [
        `status  ready  ok=${j.ok}`,
        `hero    ${j.reportsTo || "—"}`,
        `prompt  ${j.promptPreview || "—"}`,
        `at      ${j.updatedAt || "—"}`,
        "Collect: ./scripts/gotchibot claude-collect " + j.id,
      ],
    });
  }

  while (tiles.length < 6) {
    tiles.push({
      kind: "idle",
      title: "IDLE SLOT",
      lines: ["(no pending job / running session)", "waiting for spawn or claude_submit"],
    });
  }

  return tiles;
}

function summarizeCounts(jobs) {
  const c = {};
  for (const j of jobs) c[j.status] = (c[j.status] || 0) + 1;
  return Object.entries(c)
    .map(([k, v]) => `${k}:${v}`)
    .join(" ") || "none";
}

function renderTile(tile, { width = 48 } = {}) {
  const w = Math.max(24, width);
  const bar = "─".repeat(w);
  const lines = [
    `┌${bar}┐`,
    `│ ${pad(tile.title, w - 2)} │`,
    `├${bar}┤`,
    ...tile.lines.map((l) => `│ ${pad(truncate(l, w - 2), w - 2)} │`),
    `└${bar}┘`,
  ];
  return lines.join("\n");
}

function pad(s, n) {
  s = String(s);
  if (s.length >= n) return s.slice(0, n);
  return s + " ".repeat(n - s.length);
}

function truncate(s, n) {
  s = String(s);
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function printBoard(snap, { slot } = {}) {
  const tiles = snap.tiles || [];
  if (slot === "overview" || slot === "dashboard" || slot === 0 || slot === "0") {
    console.clear?.();
    console.log(renderTile(tiles[0], { width: 58 }));
    if (tiles[1]) console.log("\n" + renderTile(tiles[1], { width: 58 }));
    if (tiles[2]) console.log("\n" + renderTile(tiles[2], { width: 58 }));
    console.log(`\n  ${snap.at}  |  ${snap.truth.note}`);
    return;
  }
  if (slot === "openclaw" || slot === "gateway") {
    console.clear?.();
    console.log(renderTile(tiles.find((t) => t.kind === "openclaw") || tiles[1], { width: 58 }));
    return;
  }
  if (slot === "bridge") {
    console.clear?.();
    console.log(renderTile(tiles.find((t) => t.kind === "bridge") || tiles[2], { width: 58 }));
    return;
  }
  if (slot != null && slot !== "") {
    const i = Number(slot);
    const t = tiles[i] || tiles[0];
    console.clear?.();
    console.log(renderTile(t, { width: 56 }));
    console.log(`\n  slot ${i}/${tiles.length - 1}  ${snap.at}`);
    return;
  }
  console.clear?.();
  console.log(`gotchibot-hubmon  ${snap.at}  [${snap.dashboard?.overall || "?"}]`);
  console.log(
    `  OC ${snap.dashboard?.openclaw || "?"} · bridge ${snap.dashboard?.bridge || "?"} · recv ${snap.dashboard?.receiver || "?"}`,
  );
  console.log(snap.truth.note);
  console.log("");
  for (const t of tiles.slice(0, 9)) {
    console.log(renderTile(t, { width: 52 }));
    console.log("");
  }
}

function printDashboard(snap) {
  console.clear?.();
  console.log(`Hub dashboard · ${snap.at}`);
  console.log(`  overall   ${snap.dashboard?.overall || "?"}`);
  console.log("");
  for (const t of (snap.tiles || []).filter((x) =>
    ["dashboard", "openclaw", "bridge"].includes(x.kind),
  )) {
    console.log(renderTile(t, { width: 58 }));
    console.log("");
  }
  console.log(snap.truth.note);
}

function tmux(...args) {
  return spawnSync("tmux", args, { encoding: "utf8" });
}

function hasSession() {
  return tmux("has-session", "-t", SESS).status === 0;
}

function openMonitor({ attach = false, slots = 6, force = false } = {}) {
  const n = Math.max(4, Math.min(12, Number(slots) || 6));
  const self = join(ROOT, "scripts/hub-agent-monitor.mjs");
  const node = process.execPath;

  if (hasSession() && force) {
    tmux("kill-session", "-t", SESS);
  }

  if (hasSession()) {
    tmux("set-option", "-t", SESS, "status-style", "bg=green,fg=black");
    if (attach) {
      spawnSync("tmux", ["attach-session", "-t", SESS], { stdio: "inherit" });
    } else {
      console.log(
        JSON.stringify({
          ok: true,
          session: SESS,
          existed: true,
          attach: `tmux attach -t ${SESS}`,
        }),
      );
    }
    return;
  }

  // Create session with overview pane
  let r = tmux(
    "new-session",
    "-d",
    "-s",
    SESS,
    "-n",
    "agents",
    "-x",
    "200",
    "-y",
    "50",
    node,
    self,
    "pane",
    "--slot",
    "overview",
    "--interval",
    "2",
  );
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout || "tmux new-session failed");
    process.exit(1);
  }

  // Split into a wall: left column overview-tall, right grid of slots
  // Build n-1 additional panes
  for (let i = 1; i < n; i++) {
    const target = i === 1 ? `${SESS}:agents.0` : `${SESS}:agents.${i - 1}`;
    const split = i % 2 === 1 ? "-h" : "-v";
    tmux(
      "split-window",
      split,
      "-t",
      `${SESS}:agents`,
      node,
      self,
      "pane",
      "--slot",
      String(i),
      "--interval",
      "2",
    );
  }

  tmux("select-layout", "-t", `${SESS}:agents`, "tiled");
  tmux("set-option", "-t", SESS, "status", "on");
  tmux("set-option", "-t", SESS, "status-style", "bg=green,fg=black");
  tmux("set-option", "-t", SESS, "status-left", "[hubmon] ");
  tmux("set-option", "-t", SESS, "status-right", "OC+bridge+jobs  %H:%M %d-%b");
  tmux("set-option", "-t", SESS, "mouse", "on");

  const out = {
    ok: true,
    session: SESS,
    panes: n,
    attach: `tmux attach -t ${SESS}`,
    note: "Tiled hub dashboard — OpenClaw gateway + VS Code bridge + agent jobs",
  };
  if (attach) {
    spawnSync("tmux", ["attach-session", "-t", SESS], { stdio: "inherit" });
  } else {
    console.log(JSON.stringify(out, null, 2));
  }
}

function killMonitor() {
  if (!hasSession()) {
    console.log(JSON.stringify({ ok: true, killed: false, reason: "no-session" }));
    return;
  }
  tmux("kill-session", "-t", SESS);
  console.log(JSON.stringify({ ok: true, killed: true, session: SESS }));
}

function runPane({ slot = "overview", interval = 2 } = {}) {
  const sec = Math.max(1, Number(interval) || 2);
  const loop = () => {
    try {
      const snap = snapshot();
      printBoard(snap, { slot });
    } catch (e) {
      console.clear?.();
      console.log("hubmon pane error:", e?.message || e);
    }
  };
  loop();
  setInterval(loop, sec * 1000);
  // keep alive
  createInterface({ input: process.stdin }).on("close", () => process.exit(0));
}

function runWatch(interval = 2) {
  const sec = Math.max(1, Number(interval) || 2);
  const loop = () => {
    printBoard(snapshot());
  };
  loop();
  setInterval(loop, sec * 1000);
}

const args = process.argv.slice(2);
const cmd = args[0] || "print";
const flags = {};
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === "--json") flags.json = true;
  else if (a === "--attach") flags.attach = true;
  else if (a === "--force") flags.force = true;
  else if (a === "--slots") flags.slots = Number(args[++i]);
  else if (a === "--slot") flags.slot = args[++i];
  else if (a === "--interval") flags.interval = Number(args[++i]);
  else if (a === "-h" || a === "--help") usage();
}

if (cmd === "snapshot") {
  const s = snapshot();
  console.log(JSON.stringify(s, null, 2));
} else if (cmd === "dashboard") {
  const s = snapshot();
  if (flags.json) console.log(JSON.stringify({
    at: s.at,
    dashboard: s.dashboard,
    openclaw: s.openclaw,
    bridge: s.bridge,
    receiver: s.receiver,
    truth: s.truth,
  }, null, 2));
  else printDashboard(s);
} else if (cmd === "print") {
  printBoard(snapshot());
} else if (cmd === "watch") {
  runWatch(flags.interval);
} else if (cmd === "open") {
  openMonitor({ attach: flags.attach, slots: flags.slots, force: flags.force });
} else if (cmd === "pane") {
  runPane({ slot: flags.slot ?? "overview", interval: flags.interval });
} else if (cmd === "kill") {
  killMonitor();
} else {
  usage();
}
