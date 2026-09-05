#!/usr/bin/env node
/**
 * Hub roster — who is on this desk, who is on the other desks, and how many
 * desks are on the tailnet at all.
 *
 *   node scripts/hub-roster.mjs [--json] [--live] [--all]
 *
 * `hub status` answers "is the hub healthy". This answers "who is working, and
 * where" — the roster it never printed.
 *
 * A desk is a machine running GotchiBot. Tailscale knows every machine on the
 * tailnet; probing the OpenClaw gateway and SSH ports says which of them are
 * actually desks rather than a phone, or a laptop that has been shut since
 * August. A bot is placed on the desk where its session actually runs, not
 * where its hero is minted — heroes live on the cartridge, work lives on a
 * desk. Default view is cached (fast); --live re-runs the SSH roster scan.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { connect } from "node:net";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";
import { loadAgentMap, orchestratorHeroId, gatewayUrl } from "./openclaw-fleet.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = `${ROOT}/sessions`;
const FOCUS_LIST = `${SESSIONS}/.focus-list.json`;
const HERO_STATE = `${SESSIONS}/.hero-agent-state.json`;
const FOCUS = `${SESSIONS}/.focus.json`;

const GATEWAY_PORT = Number(process.env.GOTCHIBOT_GATEWAY_PORT || 18789);
const SSH_PORT = 22;
const PROBE_MS = 700;

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[38;5;245m",
  head: "\x1b[38;5;184m",
  brand: "\x1b[38;5;141m",
  run: "\x1b[38;5;120m",
  idle: "\x1b[38;5;240m",
  warn: "\x1b[38;5;214m",
  off: "\x1b[38;5;238m",
  fail: "\x1b[38;5;203m",
};

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function pad(s, w) {
  const t = String(s ?? "");
  return t.length >= w ? t.slice(0, w) : t + " ".repeat(w - t.length);
}

function short(s, w) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= w ? t : `${t.slice(0, w - 1)}…`;
}

/**
 * Sub-agent prompts are wrapped in a persona preamble before the real ask.
 * The task line should show the ask, not the boilerplate.
 */
function taskText(raw) {
  let t = String(raw || "").trim();
  if (!t) return "";
  const marker = t.indexOf("User message:");
  if (marker !== -1) t = t.slice(marker + "User message:".length);
  t = t.replace(/^You are [\w.-]+\.\s*(Speak in first person[^.]*\.)?\s*/i, "");
  t = t.replace(/You are this gotchi, not a narrator and not the orchestrator\.?/i, "");
  return t.replace(/\s+/g, " ").trim();
}

/* ── tailnet ────────────────────────────────────────────────────────────── */

function tailscaleStatus() {
  const r = spawnSync("tailscale", ["status", "--json"], { encoding: "utf8", timeout: 6000 });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

function machineFrom(node, isSelf = false) {
  return {
    host: node?.HostName || node?.DNSName?.split(".")[0] || "?",
    ip: (node?.TailscaleIPs || [])[0] || null,
    os: node?.OS || "?",
    online: isSelf ? true : !!node?.Online,
    lastSeen: node?.LastSeen && !String(node.LastSeen).startsWith("0001") ? node.LastSeen : null,
    self: isSelf,
  };
}

function readTailnet() {
  const st = tailscaleStatus();
  if (!st) return { ok: false, machines: [] };
  const machines = [machineFrom(st.Self, true)];
  for (const peer of Object.values(st.Peer || {})) machines.push(machineFrom(peer));
  return { ok: true, machines };
}

/** A phone on the tailnet is not a desk; don't probe it, don't count it. */
function couldBeDesk(m) {
  const os = String(m.os).toLowerCase();
  return os.includes("macos") || os.includes("linux") || os.includes("windows");
}

function probePort(host, port, timeoutMs = PROBE_MS) {
  return new Promise((done) => {
    if (!host) return done(false);
    const sock = connect({ host, port });
    const finish = (ok) => {
      sock.destroy();
      done(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
  });
}

/** Which online machines actually answer as a GotchiBot desk. */
async function classifyDesks(machines) {
  const gwHost = (() => {
    try {
      return new URL(gatewayUrl()).hostname;
    } catch {
      return null;
    }
  })();
  return Promise.all(
    machines.map(async (m) => {
      if (m.self) return { ...m, desk: true, gateway: null, ssh: null, why: "this desk" };
      if (!m.online || !couldBeDesk(m)) {
        return { ...m, desk: false, gateway: false, ssh: false, why: m.online ? `${m.os} device` : "offline" };
      }
      const [gateway, ssh] = await Promise.all([probePort(m.ip, GATEWAY_PORT), probePort(m.ip, SSH_PORT)]);
      const isGatewayHost = !!gwHost && (gwHost === m.ip || gwHost.toLowerCase().startsWith(String(m.host).toLowerCase()));
      const desk = gateway || ssh || isGatewayHost;
      return {
        ...m,
        desk,
        gateway,
        ssh,
        why: desk ? [gateway && "gateway✓", ssh && "ssh✓"].filter(Boolean).join(" · ") || "known host" : "no gotchibot ports",
      };
    }),
  );
}

/* ── bots ───────────────────────────────────────────────────────────────── */

function refreshRoster() {
  spawnSync(process.execPath, [`${ROOT}/scripts/agent-focus.mjs`, "list", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
  });
}

const DESK_KEYS = ["local", "imac"];

/**
 * Heroes are minted on the cartridge; work happens in sessions, and each
 * session knows which desk it ran on. Place every bot by its newest session
 * per desk, and keep heroes with no session anywhere in their own bucket
 * instead of pretending they sit on the machine you happen to be typing at.
 */
function readBots() {
  const heroState = readJson(HERO_STATE, {}) || {};
  const focusList = readJson(FOCUS_LIST, {}) || {};
  const map = loadAgentMap() || {};
  const orch = orchestratorHeroId();
  const entries = focusList.entries || [];
  const sessions = entries.filter((e) => e.kind === "session");

  // `gotchi` and friends are aliases onto a real hero — one bot, not two.
  const ids = new Set([
    ...Object.keys(heroState),
    ...Object.entries(map.agents || {})
      .filter(([, m]) => !m.aliasOf)
      .map(([id]) => id),
    ...entries.filter((e) => e.kind === "hero").map((e) => e.id),
  ]);

  const heroRow = new Map(entries.filter((e) => e.kind === "hero").map((e) => [e.id, e]));
  const bots = [];

  for (const id of ids) {
    const st = heroState[id] || {};
    const row = heroRow.get(id) || {};
    const mapped = (map.agents || {})[id] || {};
    const perDesk = {};
    for (const desk of DESK_KEYS) {
      const mine = sessions
        .filter((s) => s.hero === id && (s.host || "local") === desk)
        .sort((a, b) => String(b.id).localeCompare(String(a.id)));
      const running = mine.find((s) => s.status === "running");
      const newest = running || mine[0] || null;
      perDesk[desk] = newest
        ? { id: newest.id, status: newest.status, model: newest.model || null, started: newest.started || null, count: mine.length }
        : null;
    }
    bots.push({
      id,
      name: mapped.name || null,
      collateral: st.collateral || mapped.collateral || null,
      isOrch: id === orch,
      heroStatus: st.status || row.status || "unknown",
      task: taskText(st.task || row.agentTask || ""),
      onFleet: !!mapped.heroId || !!(map.agents || {})[id],
      sessions: perDesk,
      sessionCount: DESK_KEYS.reduce((n, d) => n + (perDesk[d]?.count || 0), 0),
    });
  }

  bots.sort((a, b) => {
    const rank = (x) => (x.isOrch ? 0 : DESK_KEYS.some((d) => x.sessions[d]?.status === "running") ? 1 : x.sessionCount ? 2 : 3);
    return rank(a) - rank(b) || String(a.id).localeCompare(String(b.id));
  });

  return { bots, sessions, cachedAt: focusList.at || null, remoteOk: focusList.remote?.ok ?? null };
}

function deskSessionCounts(sessions, desk) {
  const rows = sessions.filter((s) => (s.host || "local") === desk);
  return { running: rows.filter((s) => s.status === "running").length, total: rows.length };
}

/* ── assemble ───────────────────────────────────────────────────────────── */

export async function buildRoster({ live = false } = {}) {
  if (live) refreshRoster();
  const tailnet = readTailnet();
  const machines = await classifyDesks(tailnet.machines);
  const { bots, sessions, cachedAt, remoteOk } = readBots();
  const focus = readJson(FOCUS, {}) || {};
  const localHost = hostname().replace(/\.local$/, "");
  const self = machines.find((m) => m.self);

  const deskRows = machines
    .filter((m) => m.desk)
    .map((m) => {
      const which = m.self ? "local" : "imac";
      const on = bots
        .filter((b) => b.sessions[which])
        .map((b) => ({ ...b, session: b.sessions[which] }));
      return {
        ...m,
        which,
        label: m.self ? `${m.host || localHost} · this desk` : m.host,
        bots: on,
        running: on.filter((b) => b.session.status === "running").length,
        sessions: deskSessionCounts(sessions, which),
      };
    });

  const unplaced = bots.filter((b) => !b.sessionCount);

  return {
    at: new Date().toISOString(),
    rosterCachedAt: cachedAt,
    tailnet: {
      ok: tailnet.ok,
      machines: machines.length,
      online: machines.filter((m) => m.online).length,
      desks: deskRows.length,
      notDesks: machines
        .filter((m) => !m.desk)
        .map((m) => ({ host: m.host, os: m.os, why: m.why, lastSeen: m.lastSeen })),
    },
    focus: { mode: focus.mode || null, heroId: focus.heroId || null },
    gateway: gatewayUrl(),
    remoteScanOk: remoteOk,
    self: self ? { host: self.host, ip: self.ip } : { host: localHost, ip: null },
    desks: deskRows,
    bots,
    cartridgeOnly: unplaced.map((b) => ({ id: b.id, status: b.heroStatus, collateral: b.collateral })),
  };
}

/* ── print ──────────────────────────────────────────────────────────────── */

function sessionChip(status) {
  if (status === "running") return `${C.run}●${C.reset}`;
  if (status === "failed") return `${C.fail}○${C.reset}`;
  return `${C.idle}○${C.reset}`;
}

function printHuman(p, { all = false } = {}) {
  const t = p.tailnet;
  const working = p.desks.reduce((n, d) => n + d.running, 0);
  console.log(
    `${C.head}Hub roster${C.reset}  ${t.desks} desk${t.desks === 1 ? "" : "s"} · ${p.bots.length} bots · ${working} running` +
      (t.ok ? `${C.dim}  (tailnet ${t.online}/${t.machines} machines online)${C.reset}` : `${C.dim}  (tailscale unavailable)${C.reset}`),
  );

  for (const d of p.desks) {
    const via = d.self ? `focus ${p.focus.mode || "?"} · ${p.focus.heroId || "?"}` : d.why;
    console.log("");
    console.log(`${C.brand}▌${C.reset} ${C.head}${d.label}${C.reset}  ${C.dim}${d.ip || ""} · ${via}${C.reset}`);
    console.log(
      `  ${C.dim}${d.bots.length} bot${d.bots.length === 1 ? "" : "s"} · ${d.running} running · ` +
        `sessions ${d.sessions.running} run / ${d.sessions.total} total${C.reset}`,
    );
    const show = all ? d.bots : d.bots.filter((b) => b.session.status === "running" || b.isOrch).slice(0, 8);
    if (!show.length) {
      console.log(`  ${C.dim}(nothing running here — --all lists past sessions)${C.reset}`);
      continue;
    }
    for (const b of show) {
      const tag = b.isOrch ? `${C.brand}orch${C.reset}` : `${C.dim}sub ${C.reset}`;
      console.log(
        `  ${sessionChip(b.session.status)} ${pad(b.id, 20)} ${tag} ${pad(b.session.status, 8)} ` +
          `${C.dim}${pad(b.session.id, 23)}${short(b.task && b.task !== b.session.id ? b.task : b.session.model || "", 38)}${C.reset}`,
      );
    }
    const hidden = d.bots.length - show.length;
    if (hidden > 0) console.log(`  ${C.dim}+${hidden} with older sessions here — --all${C.reset}`);
  }

  if (p.cartridgeOnly.length) {
    console.log("");
    console.log(`${C.dim}On the cartridge, no session on any desk${C.reset}`);
    console.log(
      `  ${C.dim}${p.cartridgeOnly.map((b) => `${b.id} (${b.status})`).join(" · ")}${C.reset}`,
    );
  }

  const off = t.notDesks || [];
  if (off.length) {
    console.log("");
    console.log(`${C.off}Not a desk${C.reset}`);
    for (const m of off) {
      console.log(
        `  ${C.off}· ${pad(m.host, 24)} ${pad(m.os, 7)} ${m.why}${m.lastSeen ? ` · last seen ${m.lastSeen.slice(0, 10)}` : ""}${C.reset}`,
      );
    }
  }

  if (p.remoteScanOk === false) {
    console.log("");
    console.log(`${C.warn}remote scan stale — refresh: ./scripts/gotchibot hub roster --live${C.reset}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const payload = await buildRoster({ live: args.includes("--live") });
  if (args.includes("--json")) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  printHuman(payload, { all: args.includes("--all") });
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e?.message || e);
    process.exit(1);
  });
}
