#!/usr/bin/env node
/**
 * factory-window — the Factory pane (tmux work.1 center, same slot as the pstack dossier).
 *
 * Four views, switched with 1-4, Tab, or ← → (z zooms the pane to the whole window):
 *   Tree        the agent tree: orchestrator → Jev fork layer → work-tool dispatcher
 *               → the project's working bots, with the GLM on-call advisor beside it
 *   Bots        every bot assigned to the current project and its workflow —
 *               kanban lanes (backlog → todo → doing → review → done), the op it is
 *               running, what it is on now, a belt of in-flight work, unread mail —
 *               then the project-wide flow and the latest card moves
 *   Hub         the always-on Hub: SSH, OpenClaw gateway, Claude bridge, tunnel,
 *               Docker, sessions, and every desk on the tailnet with its bots
 *   Desk infra  this desk: doctor checks, tmux panes, local dispatch sessions,
 *               public subgraph tunnel
 *
 * Reads project-room files (sessions/pstack/<slug>/) and the existing status
 * scripts (hub-status, hub-roster, doctor, mesh-status, tunnel-health). Slow
 * probes run in the background and repaint when they land. Never writes files,
 * never spawns agents.
 *
 *   node scripts/factory-window.mjs [watch] [--view factory|hub|infra]
 *   node scripts/factory-window.mjs once [--view …]      single render (capture)
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { loadRoster, currentProjectSlug } from "./project-context.mjs";
import { factoryModel, roleLabels } from "./gotchi-factory.mjs";
import { resolveHeroColors } from "./collateral-resolve.mjs";
import { isMainModule } from "./is-main.mjs";
import { hubRequest } from "./chat-hub-client.mjs";
import { mergeTrees, treeSnapshotFrom } from "../services/gotchibot-api/tree.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PSTACK_ROOT = join(ROOT, "sessions", "pstack");
const WATCH_MS = Number(process.env.GOTCHIBOT_FACTORY_WATCH_MS || 3000);
const TICK_MS = 500;
const STALE_OP_MS = 24 * 3600 * 1000;

const VIEWS = [
  { key: "tree", label: "Tree" },
  { key: "factory", label: "Bots" },
  { key: "hub", label: "Hub" },
  { key: "infra", label: "Desk infra" },
];
const LANES = ["backlog", "todo", "doing", "review", "done"];
const LANE_TAG = { backlog: "b", todo: "t", doing: "d", review: "r", done: "✓" };

const ESC = "\x1b";
const c = {
  reset: `${ESC}[0m`,
  dim: `${ESC}[2m`,
  bold: `${ESC}[1m`,
  inverse: `${ESC}[7m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  red: `${ESC}[31m`,
  cyan: `${ESC}[36m`,
  gray: `${ESC}[90m`,
  pink: `${ESC}[38;5;212m`,
  rule: `${ESC}[38;5;240m`,
};

const args = process.argv.slice(2);
const wantOnce = args.includes("once") || args.includes("--once");
const isTty = Boolean(process.stdout.isTTY && process.stdin.isTTY);
const viewArg = args.includes("--view") ? args[args.indexOf("--view") + 1] : process.env.GOTCHIBOT_FACTORY_VIEW;

/* ---------- text helpers ---------- */

function visLen(s) {
  return String(s ?? "").replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Pad or cut to exactly `width` visible columns, keeping ANSI intact. */
function pad(str, width) {
  const s = String(str ?? "");
  const n = visLen(s);
  if (n <= width) return s + " ".repeat(width - n);
  let out = "";
  let vis = 0;
  for (let i = 0; i < s.length; ) {
    const m = s[i] === ESC ? s.slice(i).match(/^\x1b\[[0-9;]*m/) : null;
    if (m) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    if (vis >= width - 1) return `${out}…${c.reset}`;
    out += s[i];
    vis += 1;
    i += 1;
  }
  return out;
}

function trunc(s, n) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  if (n <= 0) return "";
  return t.length > n ? `${t.slice(0, Math.max(0, n - 1))}…` : t;
}

function ago(at) {
  const t = typeof at === "number" ? at : Date.parse(at || "");
  if (!Number.isFinite(t) || t <= 0) return "—";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function hexFg(hex) {
  const h = String(hex || "").replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(h)) return "";
  return `${ESC}[38;2;${parseInt(h.slice(0, 2), 16)};${parseInt(h.slice(2, 4), 16)};${parseInt(h.slice(4, 6), 16)}m`;
}

function mark(ok) {
  if (ok === true) return `${c.green}✓${c.reset}`;
  if (ok === false) return `${c.red}✗${c.reset}`;
  return `${c.yellow}?${c.reset}`;
}

/** Cut to at most `n` visible columns (no padding), keeping ANSI intact. */
function cut(str, n) {
  return visLen(str) <= n ? String(str ?? "") : pad(str, n);
}

/**
 * A dossier-style box, `width` columns wide:
 *   ┌─ title ──────────── note ─┐
 *   │ row                       │
 *   └───────────────────────────┘
 */
function panel(title, rows, width, { note = "", border = c.rule, titleTint = c.pink, minRows = 0 } = {}) {
  const inner = Math.max(8, width - 2);
  const noteW = note ? visLen(note) + 3 : 0;
  const t = cut(title, Math.max(1, inner - 3 - noteW));
  const fill = Math.max(0, inner - 3 - visLen(t) - noteW);
  const tail = note ? ` ${c.reset}${c.dim}${note}${c.reset}${border} ─` : "";
  const out = [`${border}┌─ ${c.reset}${titleTint}${c.bold}${t}${c.reset}${border} ${"─".repeat(fill)}${tail}┐${c.reset}`];
  const body = [...rows];
  while (body.length < minRows) body.push("");
  for (const row of body) out.push(`${border}│${c.reset} ${pad(row, inner - 2)} ${border}│${c.reset}`);
  out.push(`${border}└${"─".repeat(inner)}┘${c.reset}`);
  return out;
}

/** Lay boxes out two per row when the pane is wide enough; heights are evened out. */
function tiles(boxes, cols, colW) {
  if (!boxes.length) return [];
  if (cols < colW * 2 + 1) return boxes.flat();
  const out = [];
  for (let i = 0; i < boxes.length; i += 2) {
    const [a, b = []] = [boxes[i], boxes[i + 1]];
    for (let r = 0; r < Math.max(a.length, b.length); r++) out.push(`${a[r] ?? " ".repeat(colW)} ${b[r] ?? ""}`);
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

function dirs(path) {
  try {
    return readdirSync(path).filter((n) => statSync(join(path, n)).isDirectory());
  } catch {
    return [];
  }
}

/* ---------- factory data ---------- */

function loadUnits(slug) {
  let text = "";
  try {
    text = readFileSync(join(PSTACK_ROOT, slug, "units.tsv"), "utf8");
  } catch {
    return [];
  }
  const [head, ...rows] = text.split("\n").filter((l) => l.trim());
  if (!head) return [];
  const keys = head.split("\t");
  return rows.map((r) => Object.fromEntries(r.split("\t").map((v, i) => [keys[i], v])));
}

/** Project board + every desk board, merged by card id (newest update wins). */
function loadCards(slug) {
  const root = join(PSTACK_ROOT, slug);
  const byId = new Map();
  const add = (cards, desk = null) => {
    for (const card of Array.isArray(cards) ? cards : []) {
      if (!card?.id) continue;
      const prev = byId.get(card.id);
      const next = { ...card, owner: card.owner || card.desk || desk || null };
      if (!prev || Date.parse(next.updatedAt || 0) >= Date.parse(prev.updatedAt || 0)) byId.set(card.id, next);
    }
  };
  add(readJson(join(root, "kanban.json"))?.cards);
  for (const d of dirs(join(root, "desks"))) add(readJson(join(root, "desks", d, "kanban.json"))?.cards, d);
  return [...byId.values()];
}

function gotchiNames() {
  return readJson(join(ROOT, "sessions", ".gotchi-names.json"))?.names || {};
}

function nameFor(id, names) {
  const m = /^(?:owned|rental)-(\d+)$/.exec(id);
  return m ? names[m[1]]?.name || null : null;
}

const tintCache = new Map();
function tintFor(id) {
  if (!tintCache.has(id)) {
    let fg = "";
    try {
      fg = hexFg(resolveHeroColors({ id }, id)?.primary);
    } catch {}
    tintCache.set(id, fg);
  }
  return tintCache.get(id);
}

const RUNNING = /^(running|claimed|working|active|busy)$/i;

export function buildFactory() {
  const slug = currentProjectSlug();
  if (!slug) return { slug: null, reason: "no project selected" };
  if (!existsSync(join(PSTACK_ROOT, slug))) return { slug: null, reason: `${slug}: project room not found` };

  const roster = loadRoster(slug).heroes || [];
  const units = loadUnits(slug);
  const cards = loadCards(slug);
  const model = factoryModel(slug, roster);
  const machines = new Map(model.machines.map((m) => [m.heroId, m]));
  const roles = roleLabels();
  const names = gotchiNames();

  const ids = new Set([...roster, ...units.map((u) => u.hero), ...cards.map((k) => k.owner), ...machines.keys()].filter(Boolean));
  const bots = [...ids].map((id) => {
    const mine = cards.filter((k) => k.owner === id);
    const lanes = Object.fromEntries(LANES.map((l) => [l, 0]));
    for (const k of mine) lanes[LANES.includes(k.column) ? k.column : "backlog"] += 1;
    const ops = units.filter((u) => u.hero === id);
    const running = ops.filter((u) => RUNNING.test(u.state || ""));
    const m = machines.get(id);
    const byNewest = (a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0);
    const pick = (col) => mine.filter((k) => k.column === col).sort(byNewest)[0];
    const state = m?.rework
      ? "rework"
      : running.length || lanes.doing
        ? "working"
        : lanes.review
          ? "review"
          : lanes.todo || lanes.backlog
            ? "queued"
            : "idle";
    const op = running.sort(byNewest)[0] || null;
    const focus = pick("doing") || pick("review") || pick("todo") || pick("backlog") || null;
    return {
      id,
      name: nameFor(id, names),
      role: roles[id] || null,
      state,
      lanes,
      op,
      opStale: op ? Date.now() - Date.parse(op.updatedAt || 0) > STALE_OP_MS : false,
      opsDone: ops.filter((u) => u.state === "done").length,
      focus,
      inflight: running.length + lanes.doing + lanes.review + (m?.wip || 0),
      rework: m?.rework || 0,
      unread: m?.unread || 0,
      onRoster: roster.includes(id),
    };
  });
  const rank = { rework: 0, working: 1, review: 2, queued: 3, idle: 4 };
  bots.sort((a, b) => rank[a.state] - rank[b.state] || b.inflight - a.inflight || a.id.localeCompare(b.id));

  const totals = Object.fromEntries(LANES.map((l) => [l, cards.filter((k) => (LANES.includes(k.column) ? k.column : "backlog") === l).length]));
  const recent = [...cards].sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0)).slice(0, 6);
  return {
    slug,
    bots,
    totals,
    recent,
    ops: { running: units.filter((u) => RUNNING.test(u.state || "")).length, done: units.filter((u) => u.state === "done").length },
    tickets: model.items.filter((it) => it.kind === "ticket").length,
    sealed: roster.length > 0,
  };
}

/* ---------- background probes ---------- */

const PROBES = {
  hub: { argv: ["hub-status.mjs", "--json"], every: 30_000, timeout: 30_000, json: true },
  desks: { argv: ["hub-roster.mjs", "--json"], every: 30_000, timeout: 20_000, json: true },
  doctor: { argv: ["doctor.mjs"], every: 60_000, timeout: 30_000, json: false },
  mesh: { argv: ["mesh-status.mjs", "--json"], every: 30_000, timeout: 15_000, json: true },
  tunnel: { argv: ["tunnel-health.mjs", "--json"], every: 60_000, timeout: 15_000, json: true },
};
const VIEW_PROBES = { tree: [], factory: [], hub: ["hub", "desks"], infra: ["doctor", "mesh", "tunnel"] };
const probeState = Object.fromEntries(Object.keys(PROBES).map((k) => [k, { data: null, at: 0, busy: false, err: null }]));
let onProbe = () => {};

function runProbe(name, { sync = false } = {}) {
  const spec = PROBES[name];
  const st = probeState[name];
  if (st.busy) return;
  const done = (code, out, err) => {
    st.busy = false;
    st.at = Date.now();
    try {
      st.data = spec.json ? JSON.parse(out) : out;
      st.err = null;
    } catch {
      st.err = trunc(err || out || `exit ${code}`, 120);
    }
    onProbe(name);
  };
  const argv = [join(ROOT, "scripts", spec.argv[0]), ...spec.argv.slice(1)];
  if (sync) {
    const r = spawnSync(process.execPath, argv, { cwd: ROOT, encoding: "utf8", timeout: spec.timeout, maxBuffer: 8 << 20 });
    done(r.status, r.stdout || "", r.stderr || "");
    return;
  }
  st.busy = true;
  const child = spawn(process.execPath, argv, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const kill = setTimeout(() => child.kill("SIGTERM"), spec.timeout);
  child.on("close", (code) => {
    clearTimeout(kill);
    done(code, out, err);
  });
}

function probeNote(name) {
  const st = probeState[name];
  if (st.busy && !st.at) return "checking…";
  const age = st.at ? `checked ${ago(st.at)} ago` : "not checked";
  return st.busy ? `${age} · refreshing…` : age;
}

/* ---------- views ---------- */

function belt(bot, tick, width) {
  const cells = Array(width).fill(`${c.gray}─${c.reset}`);
  const n = Math.min(4, bot.inflight + bot.rework);
  for (let i = 0; i < n; i++) {
    const lane = (tick + i * Math.max(2, Math.floor(width / 4))) % width;
    cells[lane] = i < bot.rework ? `${c.yellow}↺${c.reset}` : `${c.cyan}▓${c.reset}`;
  }
  return cells.join("");
}

function laneStrip(lanes) {
  return LANES.map((l) => {
    const n = lanes[l];
    const tint = !n ? c.gray : l === "doing" ? c.cyan : l === "review" ? c.pink : l === "done" ? c.green : "";
    return `${tint}${LANE_TAG[l]}${n}${c.reset}`;
  }).join(" ");
}

const GLYPH = {
  rework: `${c.yellow}↺${c.reset}`,
  working: `${c.green}◉${c.reset}`,
  review: `${c.pink}◎${c.reset}`,
  queued: `${c.cyan}○${c.reset}`,
  idle: `${c.gray}·${c.reset}`,
};

function viewFactory(f, cols, tick) {
  if (!f.slug) {
    return [
      "",
      `  ${c.gray}${f.reason}${c.reset}`,
      `  ${c.gray}pick one: cockpit → Switch to another project, or gotchibot pstack dossier current <slug>${c.reset}`,
    ];
  }
  const count = (s) => f.bots.filter((b) => b.state === s).length;
  const tally = [
    [count("working"), "working", c.green],
    [count("review"), "in review", c.pink],
    [count("rework"), "rework", c.yellow],
    [count("queued"), "queued", c.cyan],
    [count("idle"), "idle", c.gray],
  ]
    .filter(([n]) => n)
    .map(([n, label, tint]) => `${tint}${n} ${label}${c.reset}`)
    .join(c.dim + " · " + c.reset);
  const t = f.totals;
  const flow = LANES.map((l) => `${c.dim}${l}${c.reset} ${c.bold}${t[l]}${c.reset}`).join(`${c.dim} ─▶ ${c.reset}`);
  const out = panel(
    `PROJECT · ${f.slug}`,
    [tally || `${c.gray}no bots${c.reset}`, flow, `${c.dim}cards  b backlog · t todo · d doing · r review · ✓ done${c.reset}`],
    cols,
    { note: `${f.bots.length} bots · ops ${f.ops.running} running / ${f.ops.done} done · ${f.sealed ? "roster sealed" : "roster open"}` },
  );

  const active = f.bots.filter((b) => b.state !== "idle");
  const idle = f.bots.filter((b) => b.state === "idle");
  const colW = Math.floor((cols - 1) / 2);
  const cardW = colW >= 38 ? colW : cols;
  out.push(...tiles(active.map((b) => botCard(b, cardW, tick)), cols, cardW));
  if (idle.length) out.push(...benchPanel(idle, cols));

  if (f.recent.length) {
    const rows = f.recent.map((k) => {
      const when = k.updatedAt ? `${ago(k.updatedAt)} ago` : "—";
      return `${c.dim}${when.padEnd(8)}${c.reset}${tintFor(k.owner || "")}${trunc(k.owner || "unowned", 18).padEnd(19)}${c.reset}${c.cyan}${String(k.column || "backlog").padEnd(8)}${c.reset}${k.title}`;
    });
    out.push(...panel("LATEST MOVES", rows, cols, { note: `tickets ${f.tickets}` }));
  }
  return out;
}

const STATE_LABEL = { rework: "rework", working: "working", review: "in review", queued: "queued", idle: "idle" };
const STATE_TINT = { rework: c.yellow, working: c.green, review: c.pink, queued: c.cyan, idle: c.gray };

function nowLine(b) {
  if (b.op) {
    const op = `${b.opStale ? c.yellow : c.green}op ${b.op.id}${c.reset}${c.dim} · ${b.op.state} ${ago(b.op.updatedAt)}${b.opStale ? " · stale?" : ""}${c.reset}`;
    return `▸ ${op}${b.focus ? `${c.dim} · ${c.reset}${b.focus.title}` : ""}`;
  }
  if (b.focus) return `▸ ${c.dim}${b.focus.column}${c.reset} ${b.focus.title}`;
  return `${c.gray}▸ nothing on the belt${c.reset}`;
}

/** One bot as a card, framed in its collateral color while it has work in flight. */
function botCard(b, w, tick) {
  const tint = tintFor(b.id);
  const inner = w - 4;
  const flags = [
    b.unread ? `${c.yellow}${b.unread} new${c.reset}` : "",
    b.opsDone ? `${c.dim}${b.opsDone} ops done${c.reset}` : "",
    b.onRoster ? "" : `${c.dim}off roster${c.reset}`,
  ]
    .filter(Boolean)
    .join(`${c.dim} · ${c.reset}`);
  const who = `${c.dim}${b.name ? `${b.id}${b.role ? ` · ${b.role}` : ""}` : b.role || "no role yet"}${c.reset}`;
  const row1 = flags ? `${pad(who, Math.max(8, inner - visLen(flags) - 1))} ${flags}` : who;
  const lanes = laneStrip(b.lanes);
  const row2 = `${lanes}  ${belt(b, tick, Math.max(6, inner - visLen(lanes) - 2))}`;
  return panel(`${GLYPH[b.state]} ${c.bold}${tint}${b.name || b.id}`, [row1, row2, nowLine(b)], w, {
    border: b.state !== "queued" && tint ? tint : c.rule,
    titleTint: "",
    note: `${STATE_TINT[b.state]}${STATE_LABEL[b.state]}`,
  });
}

/** Idle bots share one box so the cards above stay about work. */
function benchPanel(bots, cols) {
  const inner = cols - 4;
  const per = inner >= 90 ? 3 : inner >= 50 ? 2 : 1;
  const colW = Math.floor(inner / per);
  const rows = [];
  for (let i = 0; i < bots.length; i += per) {
    rows.push(
      bots
        .slice(i, i + per)
        .map((b) => `${pad(`${c.gray}·${c.reset} ${tintFor(b.id)}${b.name || b.id}${c.reset}${b.role ? ` ${c.dim}${b.role}${c.reset}` : ""}`, colW - 1)} `)
        .join(""),
    );
  }
  return panel(`BENCH · ${bots.length} idle`, rows, cols, { note: "nothing on the belt" });
}

function viewHub(cols) {
  const out = [];
  const h = probeState.hub.data;
  if (!h) {
    out.push(`${c.gray}${probeState.hub.err || "asking hub-status…"}${c.reset}`);
  } else {
    const row = (ok, label, detail) => out.push(`${mark(ok)} ${label.padEnd(10)} ${c.dim}${detail || ""}${c.reset}`);
    row(h.ssh?.ok, "SSH", h.ssh?.ok ? "reachable" : h.ssh?.reason);
    const oc = h.openclaw || {};
    const focus = oc.focus ? `focus ${oc.focus.mode} ${oc.focus.heroId || oc.focus.agentId || ""}` : "";
    row(oc.reachable, "OpenClaw", [oc.gateway, `${oc.agentCount ?? "?"} agents`, focus].filter(Boolean).join(" · "));
    const br = h.bridge || {};
    row(br.ok, "Bridge", [br.health, br.receiverOk ? "receiver up" : "receiver down"].filter(Boolean).join(" · "));
    row(h.tunnel?.ok, "Tunnel", h.tunnel?.detail);
    const dk = h.docker || {};
    row(dk.ok, "Docker", dk.available ? `${dk.up}/${dk.total} up · ${dk.unhealthy} unhealthy` : dk.reason || "unavailable");
    const s = h.sessions || {};
    out.push(`  ${"Sessions".padEnd(10)} ${c.dim}this Mac ${s.mbp?.running ?? 0} running / ${s.mbp?.total ?? 0} · Hub ${s.imac?.running ?? 0} / ${s.imac?.total ?? 0}${c.reset}`);
    if (!h.ssh?.ok && /abra/.test(String(h.ssh?.reason || ""))) {
      out.push(`${c.gray}Hub SSH needs the desk started under abra (the pane only sees what the desk env has).${c.reset}`);
    }
  }
  const down = h && [h.ssh?.ok, h.openclaw?.reachable, h.bridge?.ok, h.tunnel?.ok].some((ok) => ok === false);
  const hubBox = panel("HUB", out, cols, { note: probeNote("hub"), border: down ? c.yellow : c.rule });

  const d = probeState.desks.data;
  const tn = d?.tailnet;
  if (!d) return [...hubBox, ...panel("DESKS", [`${c.gray}${probeState.desks.err || "asking hub-roster…"}${c.reset}`], cols, { note: probeNote("desks") })];

  const cards = (d.desks || []).map((desk) => {
    const bots = Array.isArray(desk.bots) ? desk.bots : [];
    const busy = bots.filter((b) => /work|busy|running/i.test(String(b.heroStatus || ""))).length;
    const dot = desk.online ? `${c.green}●${c.reset}` : `${c.gray}○${c.reset}`;
    const host = String(desk.host || desk.ip || "?").replace(/^julius(?:['’]s|s)?[\s-]+/i, "");
    const rows = bots.length
      ? bots.map((b) => {
          const st = String(b.heroStatus || "idle");
          const g = /work|busy|running/i.test(st) ? GLYPH.working : GLYPH.idle;
          const orch = b.isOrch ? `${c.pink} orch${c.reset}` : "";
          const task = b.task ? `${c.dim} · ${b.task}${c.reset}` : "";
          return `${g} ${tintFor(b.id)}${b.name || b.id}${c.reset}${orch}${c.dim} · ${st}${c.reset}${task}`;
        })
      : [`${c.gray}no bots${c.reset}`];
    const why = desk.self ? "this desk" : desk.why || (desk.online ? "online" : "offline");
    return { self: desk.self, title: `${dot} ${host}`, rows, note: `${bots.length} bots${busy ? ` · ${busy} working` : ""} · ${why}`, online: desk.online };
  });
  const box = (k, w, minRows = 0) => panel(k.title, k.rows, w, { note: k.note, titleTint: k.online ? "" : c.gray, border: k.self ? c.cyan : c.rule, minRows });

  const desksHead = panel("DESKS", [tn ? `tailnet ${tn.online}/${tn.machines} online · ${tn.desks} desks` : "tailnet unknown"], cols, { note: probeNote("desks") });
  const self = cards.filter((k) => k.self).map((k) => box(k, cols));
  const others = cards.filter((k) => !k.self);
  const colW = Math.floor((cols - 1) / 2);
  const paired = [];
  if (colW >= 30) {
    for (let i = 0; i < others.length; i += 2) {
      const pair = others.slice(i, i + 2);
      const h = Math.max(...pair.map((k) => k.rows.length));
      paired.push(...pair.map((k) => box(k, colW, h)));
    }
  } else paired.push(...others.map((k) => box(k, cols)));
  return [...hubBox, ...desksHead, ...self.flat(), ...(colW >= 30 ? tiles(paired, cols, colW) : paired.flat())];
}

function tmuxPanes() {
  const sess = process.env.GOTCHIBOT_TMUX_SESSION || "gotchibot";
  const r = spawnSync("tmux", ["list-panes", "-t", `${sess}:work`, "-F", "#{pane_index}\t#{pane_width}x#{pane_height}\t#{pane_dead}\t#{pane_start_command}"], {
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [idx, size, dead, cmd] = l.split("\t");
      const script = (String(cmd).match(/\.\/scripts\/([\w.-]+)/) || [])[1] || trunc(cmd, 40);
      return { idx, size, dead: dead === "1", script };
    });
}

function viewInfra(cols) {
  const out = [];
  const doc = probeState.doctor.data;
  const checks = String(doc || "")
    .split("\n")
    .map((l) => l.match(/^(ok|warn|fail|tip)\s+(.*)$/))
    .filter(Boolean)
    .map(([, level, text]) => ({ level, text: process.env.HOME ? text.split(process.env.HOME).join("~") : text }));
  const n = (lv) => checks.filter((x) => x.level === lv).length;
  const checkRows = [];
  if (!checks.length) {
    checkRows.push(`${c.gray}${probeState.doctor.err || "running doctor…"}${c.reset}`);
  } else {
    checkRows.push(`${c.green}${n("ok")} ok${c.reset}${c.dim} · ${c.reset}${n("warn") ? c.yellow : c.gray}${n("warn")} warn${c.reset}${c.dim} · ${c.reset}${n("fail") ? c.red : c.gray}${n("fail")} fail${c.reset}`);
    const order = { fail: 0, warn: 1, ok: 2, tip: 3 };
    for (const x of [...checks].sort((a, b) => order[a.level] - order[b.level])) {
      const g = x.level === "fail" ? `${c.red}✗` : x.level === "warn" ? `${c.yellow}!` : x.level === "ok" ? `${c.green}✓` : `${c.gray}·`;
      checkRows.push(`${g}${c.reset} ${x.level === "ok" || x.level === "tip" ? c.dim : ""}${x.text}${c.reset}`);
    }
  }
  out.push(...panel("CHECKS", checkRows, cols, { note: probeNote("doctor"), border: n("fail") ? c.red : n("warn") ? c.yellow : c.rule }));

  const panes = tmuxPanes();
  const paneRows = !panes
    ? [`${c.gray}no desk tmux session${c.reset}`]
    : panes.map((p) => `${p.dead ? `${c.red}✗` : `${c.green}●`}${c.reset} work.${p.idx} ${c.dim}${p.size.padEnd(7)}${c.reset} ${p.script}`);

  const mesh = probeState.mesh.data;
  const local = mesh?.hosts?.local;
  const sessRows = [];
  if (!local) {
    sessRows.push(`${c.gray}${probeState.mesh.err || "reading mesh cache…"}${c.reset}`);
  } else {
    sessRows.push(`${local.label || "this desk"} ${c.dim}${local.total} total${c.reset}`);
    for (const [k, v] of Object.entries(local.byStatus || {})) sessRows.push(`${k === "failed" ? c.red : k === "running" ? c.green : c.dim}${String(v).padStart(4)} ${k}${c.reset}`);
    sessRows.push(`${c.dim}peer ${mesh.remoteReachable ? "reachable" : "not reachable from here"}${c.reset}`);
  }
  const colW = Math.floor((cols - 1) / 2);
  if (colW >= 34) {
    const h = Math.max(paneRows.length, sessRows.length);
    out.push(...tiles([panel("PANES", paneRows, colW, { note: "tmux", minRows: h }), panel("SESSIONS", sessRows, colW, { note: probeNote("mesh"), minRows: h })], cols, colW));
  } else {
    out.push(...panel("PANES", paneRows, cols, { note: "tmux" }), ...panel("SESSIONS", sessRows, cols, { note: probeNote("mesh") }));
  }

  const tun = probeState.tunnel.data;
  const tunRows = [];
  if (!tun) {
    tunRows.push(`${c.gray}${probeState.tunnel.err || "probing…"}${c.reset}`);
  } else {
    const p = tun.public || {};
    const keyless = !p.ok && tun.ok;
    const m = keyless ? `${c.yellow}!${c.reset}` : mark(p.ok);
    tunRows.push(`${m} ${tun.gateway || "subgraph"} ${c.dim}${p.status ?? "—"} · ${p.latencyMs ?? "?"}ms${p.block ? ` · block ${p.block}` : ""}${c.reset}`);
    if (keyless) tunRows.push(`  ${c.dim}tunnel up · proxy wants a key — reopen Factory (prefix F twice) and unlock abra${c.reset}`);
    else if (!p.ok && p.error) tunRows.push(`  ${c.dim}${p.error}${c.reset}`);
  }
  out.push(...panel("TUNNEL", tunRows, cols, { note: probeNote("tunnel") }));
  return out;
}

/* ---------- tree view ---------- */

const TREE = {
  orch: `${ESC}[38;5;208m`,
  jev: `${ESC}[38;5;114m`,
  tools: `${ESC}[38;5;110m`,
  advisor: `${ESC}[38;5;183m`,
};
/** Jev answers at or above this confidence run in code; below it they go up to the orchestrator. */
const SHARP = 0.75;
const SPARK = "▁▂▃▄▅▆▇█";

function readEnvFile(path) {
  try {
    return Object.fromEntries(
      readFileSync(path, "utf8")
        .split("\n")
        .map((l) => l.match(/^(\w+)=(.*)$/))
        .filter(Boolean)
        .map((m) => [m[1], m[2]]),
    );
  } catch {
    return null;
  }
}

function readJsonl(path, max = 2000) {
  try {
    return readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .slice(-max)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function buildTree() {
  const S = join(ROOT, "sessions");
  const focus = readJson(join(S, ".focus.json")) || {};
  const names = gotchiNames();
  const models = readJson(join(ROOT, "config", "models.auto.json")) || {};
  let agentPin = null;
  try {
    agentPin = (readFileSync(join(ROOT, ".opencode", "agents", "gotchi.md"), "utf8").match(/^model:\s*(\S+)/m) || [])[1] || null;
  } catch {}
  let chatPin = null;
  try {
    chatPin = readFileSync(join(S, ".chat-model"), "utf8").trim() || null;
  } catch {}
  const model = chatPin || agentPin || readJson(join(ROOT, "opencode.json"))?.model || "opencode/big-pickle";
  const subModel = (models.subagentPrefer || [])[0] || models.subagentFallback || "opencode/big-pickle";
  const advisorModel = models.advisor || "opencode-go/glm-5.3";

  const runs = [];
  let entries = [];
  try {
    entries = readdirSync(S);
  } catch {}
  for (const n of entries) {
    if (!/^[csx]\d{8}/.test(n)) continue;
    const env = readEnvFile(join(S, n, "state.env"));
    if (!env) continue;
    const kind = env.provider === "cursor-cli" ? "cursor" : env.provider === "codex-cli" ? "codex" : n.startsWith("s") ? "dispatch" : null;
    if (kind) runs.push({ kind, status: env.status || "?", started: Date.parse(env.started || "") || 0 });
  }

  const claudeCalls = readJsonl(join(S, "claude-inbox.jsonl")).length;
  const oncall = readJsonl(join(S, ".oncall-ledger.jsonl"));
  const last = oncall[oncall.length - 1] || null;
  const lastText = last?.ok
    ? String(last.a || "")
        .split("\n")
        .map((l) => l.trim())
        .find(Boolean) || null
    : null;

  const ledger = readJsonl(join(S, ".jev-ledger.jsonl"));
  const byId = new Map();
  let forks = 0;
  let sharp = 0;
  for (const e of ledger) {
    for (const [id, a] of Object.entries(e.answers || {})) {
      forks += 1;
      const conf = Number(a?.confidence);
      const x = byId.get(id) || { id, n: 0, sum: 0, known: 0 };
      x.n += 1;
      if (Number.isFinite(conf)) {
        x.sum += conf;
        x.known += 1;
        if (conf >= SHARP) sharp += 1;
      }
      byId.set(id, x);
    }
  }

  return {
    orch: { id: focus.heroId || null, name: nameFor(focus.heroId || "", names), mode: focus.mode || "orch", model },
    runs,
    subModel,
    claudeCalls,
    advisor: {
      model: advisorModel,
      goKey: Boolean(process.env.OPENCODE_API_KEY?.trim()),
      calls: oncall.length,
      day: oncall.filter((x) => Date.now() - Date.parse(x.at || 0) < 86400_000).length,
      lastAt: last?.at || null,
      lastOk: last ? Boolean(last.ok) : null,
      lastText,
      reportsTo: last?.reportsTo || null,
    },
    jev: {
      forks,
      sharp,
      split: forks - sharp,
      top: [...byId.values()].sort((a, b) => b.n - a.n).slice(0, 3).map((x) => ({ id: x.id, n: x.n, avg: x.known ? x.sum / x.known : null })),
      byId: [...byId.values()],
    },
  };
}

/** Dashed box; content centered unless `left`. */
function dbox(lines, width, color, { left = false } = {}) {
  const inner = Math.max(4, width - 2);
  const out = [`${color}┌${"╌".repeat(inner)}┐${c.reset}`];
  for (const line of lines) {
    const t = cut(line, inner - 2);
    const lead = left ? 1 : Math.max(1, Math.floor((inner - visLen(t)) / 2));
    out.push(`${color}╎${c.reset}${" ".repeat(lead)}${t}${" ".repeat(Math.max(0, inner - lead - visLen(t)))}${color}╎${c.reset}`);
  }
  out.push(`${color}└${"╌".repeat(inner)}┘${c.reset}`);
  return out;
}

function spread(leftText, rightText, width) {
  return `${leftText}${" ".repeat(Math.max(1, width - visLen(leftText) - visLen(rightText)))}${rightText}`;
}

function meter(v, width, color) {
  const on = Math.max(0, Math.min(width, Math.round(v * width)));
  return `${color}${"█".repeat(on)}${c.reset}${c.gray}${"▒".repeat(width - on)}${c.reset}`;
}

function sparkline(times, buckets = 12, span = 86400_000) {
  const now = Date.now();
  const counts = Array(buckets).fill(0);
  for (const t of times) {
    const age = now - t;
    if (age < 0 || age >= span) continue;
    counts[buckets - 1 - Math.floor(age / (span / buckets))] += 1;
  }
  const max = Math.max(...counts);
  return counts.map((n) => (n ? SPARK[Math.min(SPARK.length - 1, Math.ceil((n / max) * (SPARK.length - 1)))] : " ")).join("");
}

function prettyModel(id) {
  return String(id || "")
    .replace(/^[\w-]+\//, "")
    .replace(/^glm-/i, "GLM ")
    .replace(/^kimi-/i, "Kimi ");
}

function advisorPanel(a, width) {
  const inner = width - 4;
  const keyTxt = a.goKey ? `${c.green}✓ go key${c.reset}` : `${c.yellow}✗ needs abra${c.reset}`;
  const reply = a.lastText
    ? `${c.bold}» ${a.lastText}${c.reset}`
    : a.lastOk === false
      ? `${c.red}» last call failed${c.reset}`
      : `${c.gray}» nothing yet${c.reset}`;
  const lines = [
    `${c.bold}${prettyModel(a.model)} · on call${c.reset}`,
    `${TREE.advisor}/oncall${c.reset}`,
    "",
    `${c.dim}orch calls it for:${c.reset}`,
    "· hard logic",
    "· contested calls",
    "",
    `${c.dim}last reply ${a.lastAt ? `${ago(a.lastAt)} ago` : "never"}${c.reset}`,
    reply,
    a.reportsTo ? `${c.dim}reports to ${a.reportsTo}${c.reset}` : "",
    "",
    spread("calls", `${c.green}${a.calls}${c.reset}`, inner),
    spread("last 24h", `${c.green}${a.day}${c.reset}`, inner),
    spread("opencode go", keyTxt, inner),
    "",
    `${c.dim}read-only · never edits${c.reset}`,
    `${c.dim}orch applies advice${c.reset}`,
  ];
  const centered = new Set([0, 1]);
  const inner2 = width - 2;
  const out = [`${TREE.advisor}┌${"╌".repeat(inner2)}┐${c.reset}`];
  lines.forEach((l, i) => {
    const t = cut(l, inner);
    const lead = centered.has(i) ? Math.max(1, Math.floor((inner2 - visLen(t)) / 2)) : 1;
    out.push(`${TREE.advisor}╎${c.reset}${" ".repeat(lead)}${t}${" ".repeat(Math.max(0, inner2 - lead - visLen(t)))}${TREE.advisor}╎${c.reset}`);
  });
  out.push(`${TREE.advisor}└${"╌".repeat(inner2)}┘${c.reset}`);
  return out;
}

function workerBox(b, w) {
  const tint = tintFor(b.id) || TREE.tools;
  const task = b.op ? `op ${b.op.id}${b.opStale ? " · stale?" : ""}` : b.focus ? b.focus.title : "nothing on the belt";
  return dbox(
    [
      `${c.bold}${tint}${b.name || b.id}${c.reset}`,
      `${c.dim}${b.role || b.id}${c.reset}${b.desk ? ` ${TREE.tools}@${b.desk}${c.reset}` : ""}`,
      "",
      `${GLYPH[b.state]} ${STATE_TINT[b.state]}${STATE_LABEL[b.state]}${c.reset}`,
      `${c.dim}${task}${c.reset}`,
    ],
    w,
    b.state === "queued" ? c.rule : tint,
  );
}

function syncLine(desks) {
  if (sync.err) return `${c.yellow}sync off · ${sync.err}${c.reset}`;
  if (!sync.pulledAt) return `${c.gray}syncing desks…${c.reset}`;
  const others = desks.map((d) => {
    const age = Date.now() - Date.parse(d.pushedAt || 0);
    return `${age > 3 * 60_000 ? c.gray : c.green}${d.name}${c.reset} ${c.dim}${ago(d.pushedAt)}${c.reset}`;
  });
  return `${c.dim}desks${c.reset} ${c.green}this${c.reset}${others.length ? ` · ${others.join(" · ")}` : `${c.dim} · no other desk pushed yet${c.reset}`}`;
}

function viewTree(tLocal, f, cols) {
  const m = mergeTrees(tLocal, f, sync.remotes, { sharp: SHARP });
  const t = m.tree;
  const shortModel = String(t.orch.model).replace(/^[\w-]+\//, "");
  const legend = [
    [TREE.orch, `orchestrator · ${shortModel}`],
    [TREE.jev, "jev · forks"],
    [TREE.tools, "work tools"],
    [TREE.advisor, `on call · ${String(t.advisor.model).replace(/^[\w-]+\//, "")}`],
  ]
    .map(([col, l]) => `${col}■${c.reset} ${c.dim}${l}${c.reset}`)
    .join("   ");
  const out = [`${" ".repeat(Math.max(0, Math.floor((cols - visLen(legend)) / 2)))}${legend}`, ""];

  const S = cols >= 110 ? 30 : cols >= 80 ? 26 : 0;
  const T = S ? cols - S - 2 : cols;
  const cx = Math.floor(T / 2);
  const at = (x, s) => `${" ".repeat(Math.max(0, x))}${s}`;
  const tree = [];

  const bots = m.bots;
  const busy = bots.filter((b) => b.state !== "idle").length;
  const load = bots.length ? Math.round((busy / bots.length) * 4) : 0;
  const ow = Math.min(T - 2, 44);
  const oOff = Math.floor((T - ow) / 2);
  const orchBox = dbox(
    [
      `${TREE.orch}${c.bold}${t.orch.name || t.orch.id || "orchestrator"}${c.reset}`,
      `${c.bold}main session${c.reset}`,
      `${c.dim}load${c.reset} ${TREE.orch}${"█ ".repeat(load)}${c.reset}${c.gray}${"▒ ".repeat(4 - load)}${c.reset}${TREE.orch}${busy}/${bots.length} busy${c.reset}`,
      `${c.dim}plans + decides · ${shortModel}${c.reset}`,
    ],
    ow,
    TREE.orch,
  );
  orchBox.forEach((l, i) => tree.push(i === 2 && S ? `${TREE.advisor}${"┄".repeat(Math.max(0, oOff - 2))}◉${c.reset} ${l}` : at(oOff, l)));
  tree.push(at(cx, `${TREE.orch}│${c.reset}`), at(cx, `${TREE.jev}▼${c.reset}`));

  const jw = Math.min(T - 2, 72);
  const jOff = Math.floor((T - jw) / 2);
  const jin = jw - 4;
  const jevLines = [spread(`${TREE.jev}${c.bold}JEV · fork layer${c.reset}`, `${c.dim}forks${c.reset}  ${TREE.jev}${c.bold}${t.jev.forks.toLocaleString()}${c.reset}`, jin)];
  if (t.jev.top.length) {
    const bw = Math.max(6, jin - 16 - 13);
    for (const q of t.jev.top) {
      const v = q.avg ?? 0;
      const verdict = q.avg == null ? `${c.gray}  —${c.reset}` : `${TREE.jev}${v.toFixed(2)}${c.reset} ${v >= SHARP ? `${TREE.jev}sharp` : `${c.yellow}split`}${c.reset}`;
      jevLines.push(`${trunc(q.id.replace(/[_-]/g, " "), 15).padEnd(16)}${meter(v, bw, TREE.jev)} ${verdict}`);
    }
  } else {
    jevLines.push("", `${c.gray}no forks logged yet · gotchibot jev ask …${c.reset}`, "");
  }
  jevLines.push(spread(`${TREE.jev}sharp ${t.jev.sharp} → runs in code${c.reset}`, `${c.yellow}split ${t.jev.split} → orch${c.reset}`, jin));
  dbox(jevLines, jw, TREE.jev, { left: true }).forEach((l) => tree.push(at(jOff, l)));
  tree.push(at(cx, `${TREE.jev}·${c.reset}`), at(cx, `${TREE.tools}▼${c.reset}`));

  const n = (k) => t.runs.filter((r) => r.kind === k).length;
  // A run still marked running after 6h almost always died without closing its state.
  const live = t.runs.filter((r) => r.status === "running" && Date.now() - r.started < 6 * 3600_000).length;
  const stale = t.runs.filter((r) => r.status === "running").length - live;
  const lastStart = Math.max(0, ...t.runs.map((r) => r.started));
  const dw = Math.min(T - 2, 72);
  dbox(
    [
      spread(`${TREE.tools}${c.bold}WORK TOOLS · DISPATCHER${c.reset}`, `${c.dim}subs on${c.reset} ${TREE.tools}${String(t.subModel).replace(/^[\w-]+\//, "")}${c.reset}`, dw - 4),
      `${c.bold}cursor${c.reset} ${n("cursor")} ${c.gray}→${c.reset} ${c.bold}codex${c.reset} ${n("codex")} ${c.gray}→${c.reset} ${c.bold}claude${c.reset} ${t.claudeCalls}   ${c.dim}dispatch${c.reset} ${n("dispatch")}  ${live ? c.green : c.dim}${live} running${c.reset}${stale ? `${c.yellow} · ${stale} stale?${c.reset}` : ""}`,
      `${c.dim}24h${c.reset} ${TREE.tools}[${c.reset}${TREE.jev}${sparkline(t.runs.map((r) => r.started))}${c.reset}${TREE.tools}]${c.reset} ${c.dim}last ${lastStart ? `${ago(lastStart)} ago` : "—"}${c.reset}`,
      syncLine(m.desks),
    ],
    dw,
    TREE.tools,
  ).forEach((l) => tree.push(at(Math.floor((T - dw) / 2), l)));

  const side = S ? advisorPanel(t.advisor, S) : [];
  for (let i = 0; i < Math.max(tree.length, side.length); i++) out.push(S ? `${pad(side[i] ?? "", S)}  ${tree[i] ?? ""}` : tree[i] ?? "");

  const workers = bots.filter((b) => b.state !== "idle");
  const dcx = (S ? S + 2 : 0) + cx;
  if (!workers.length) {
    out.push(at(dcx, `${TREE.tools}│${c.reset}`));
    const w = Math.min(cols, 40);
    dbox([`${c.gray}no bots on the belt${c.reset}`, `${c.dim}${f.slug ? `${bots.length} on the bench` : f.reason}${c.reset}`], w, c.rule).forEach((l) =>
      out.push(at(Math.max(0, dcx - Math.floor(w / 2)), l)),
    );
    return out;
  }
  const per = Math.max(1, Math.min(workers.length, Math.floor((cols + 1) / 21)));
  const ww = Math.floor((cols - (per - 1)) / per);
  const centers = workers.slice(0, per).map((_, i) => i * (ww + 1) + Math.floor(ww / 2));
  const bus = Array(cols).fill(" ");
  const lo = Math.min(centers[0], dcx);
  const hi = Math.max(centers[centers.length - 1], dcx);
  // up/down/left/right → box-drawing joint
  const JOINT = { "0011": "─", "0111": "┬", "1011": "┴", "1111": "┼", "0101": "┌", "0110": "┐", "1001": "└", "1010": "┘", "1101": "├", "1110": "┤", "1100": "│" };
  for (let x = lo; x <= hi; x++) {
    const key = `${+(x === dcx)}${+centers.includes(x)}${+(x > lo)}${+(x < hi)}`;
    bus[x] = JOINT[key] || "─";
  }
  out.push(at(dcx, `${TREE.tools}│${c.reset}`));
  out.push(`${TREE.tools}${bus.join("").trimEnd()}${c.reset}`);
  const arrows = Array(cols).fill(" ");
  for (const x of centers) arrows[x] = "▼";
  out.push(`${TREE.tools}${arrows.join("").trimEnd()}${c.reset}`);
  for (let i = 0; i < workers.length; i += per) {
    const row = workers.slice(i, i + per).map((b) => workerBox(b, ww));
    for (let r = 0; r < row[0].length; r++) out.push(row.map((box) => box[r]).join(" "));
  }
  const idle = bots.length - workers.length;
  if (idle) out.push("", `${c.dim}  bench · ${idle} idle — press 2 for every bot${c.reset}`);
  return out;
}

/* ---------- screen ---------- */

let tabHits = [];

function header(view, cols, slug) {
  let x = 1;
  tabHits = [];
  const tabs = VIEWS.map((v, i) => {
    const label = ` ${i + 1} ${v.label} `;
    tabHits.push({ key: v.key, x0: x, x1: x + label.length });
    x += label.length + 1;
    return v.key === view ? `${c.inverse}${c.bold}${label}${c.reset}` : `${c.dim}${label}${c.reset}`;
  }).join(" ");
  const title = `${c.bold}FACTORY${c.reset}${slug ? `${c.dim} · ${slug}${c.reset}` : ""}`;
  const gap = cols - 1 - x - visLen(title);
  return gap > 1 ? ` ${tabs}${" ".repeat(gap)}${title}` : ` ${tabs}`;
}

const FOOTER = "1-4 Tab ←→ view · j/k scroll · z zoom · r refresh · c cockpit";

function render(state) {
  const cols = process.stdout.columns || Number(process.env.COLUMNS) || 80;
  const rows = process.stdout.rows || Number(process.env.LINES) || 40;
  const body =
    state.view === "tree"
      ? viewTree(state.tree, state.factory, cols)
      : state.view === "hub"
        ? viewHub(cols)
        : state.view === "infra"
          ? viewInfra(cols)
          : viewFactory(state.factory, cols, state.tick);
  const bodyH = Math.max(1, rows - 3);
  const maxScroll = Math.max(0, body.length - bodyH);
  state.scroll = Math.max(0, Math.min(state.scroll, maxScroll));
  const shown = body.slice(state.scroll, state.scroll + bodyH);
  while (shown.length < bodyH) shown.push("");
  const more = maxScroll ? ` · ${state.scroll}/${maxScroll}` : "";
  const lines = [
    pad(header(state.view, cols, state.factory?.slug), cols),
    `${c.rule}${"─".repeat(cols)}${c.reset}`,
    ...shown.map((l) => pad(l, cols)),
    pad(`${c.dim} ${FOOTER}${more}${c.reset}`, cols),
  ];
  process.stdout.write(`${ESC}[?25l${ESC}[H${lines.join("\n")}${ESC}[J`);
}

/* ---------- desk wiring ---------- */

function markSelf() {
  if (!process.env.TMUX || !process.env.TMUX_PANE) return;
  const set = (...kv) => spawnSync("tmux", ["set-option", "-p", "-t", process.env.TMUX_PANE, ...kv], { stdio: "ignore" });
  // Same marker as the dossier: tmux hands this pane its own keys and mouse.
  set("@gotchibot-pstack-dossier", "1");
  set("pane-border-format", " #{?pane_active,●, }Factory ");
}

function leaveTo(target) {
  const cmd = target === "orch" ? "leave-pstack-orch" : target === "user" ? "leave-pstack-user" : "leave-pstack-cockpit";
  spawnSync("bash", [join(ROOT, "scripts", "orchestrator-layout.sh"), cmd], { cwd: ROOT, env: process.env, stdio: "ignore" });
  process.exit(0);
}

function initialView() {
  return VIEWS.some((v) => v.key === viewArg) ? viewArg : "tree";
}

function refreshData(state) {
  state.factory = buildFactory();
  state.tree = buildTree();
  return state;
}

/* ---------- cross-desk sync (Hub tree snapshots) ---------- */

const SYNC_MS = Number(process.env.GOTCHIBOT_TREE_SYNC_MS || 10_000);
const sync = { remotes: [], pulledAt: 0, pushedAt: 0, lastHash: null, err: null, busy: false };

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("hub timeout")), ms))]);
}

async function syncTree(state) {
  if (sync.busy || !state.tree) return;
  sync.busy = true;
  try {
    const snap = treeSnapshotFrom(state.tree, state.factory);
    const { collectedAt: _at, ...rest } = snap;
    const hash = JSON.stringify(rest);
    // Re-push an unchanged tree once a minute so other desks can tell this one is alive.
    if (hash !== sync.lastHash || Date.now() - sync.pushedAt > 60_000) {
      await withTimeout(hubRequest("POST", "/api/gotchibot/tree/push", { body: snap }), 8000);
      sync.lastHash = hash;
      sync.pushedAt = Date.now();
    }
    const res = await withTimeout(hubRequest("GET", "/api/gotchibot/tree"), 8000);
    sync.remotes = (res.desks || []).filter((d) => d.deskId !== res.self);
    sync.pulledAt = Date.now();
    sync.err = null;
  } catch (e) {
    const msg = String(e?.message || e).split("\n")[0];
    sync.err = e?.status === 404 ? "hub needs the tree update" : msg.slice(0, 60);
  } finally {
    sync.busy = false;
  }
}

async function runOnce() {
  const state = refreshData({ view: initialView(), scroll: 0, tick: 0 });
  for (const p of VIEW_PROBES[state.view]) runProbe(p, { sync: true });
  if (state.view === "tree") await syncTree(state);
  render(state);
  process.stdout.write(`${ESC}[?25h${c.reset}\n`);
}

function runWatch() {
  markSelf();
  const state = refreshData({ view: initialView(), scroll: 0, tick: 0 });
  const paint = () => {
    try {
      render(state);
    } catch {}
  };
  const due = () => {
    for (const p of VIEW_PROBES[state.view]) {
      const st = probeState[p];
      if (!st.busy && Date.now() - st.at >= PROBES[p].every) runProbe(p);
    }
  };
  onProbe = () => paint();

  const setView = (key) => {
    if (key === state.view) return;
    state.view = key;
    state.scroll = 0;
    due();
    paint();
  };
  const step = (dir) => {
    const i = VIEWS.findIndex((v) => v.key === state.view);
    setView(VIEWS[(i + dir + VIEWS.length) % VIEWS.length].key);
  };

  process.stdout.write(`${ESC}[2J`);
  due();
  paint();

  const dataTimer = setInterval(() => {
    try {
      refreshData(state);
    } catch {}
    due();
    paint();
  }, WATCH_MS);
  const syncTimer = setInterval(() => void syncTree(state).then(paint), SYNC_MS);
  void syncTree(state).then(paint);
  // The belt only moves on the Factory view; other views repaint on data.
  const tickTimer = setInterval(() => {
    if (state.view !== "factory") return;
    state.tick += 1;
    paint();
  }, TICK_MS);
  process.stdout.on("resize", paint);
  process.on("SIGUSR1", () => {
    refreshData(state);
    paint();
  });

  const cleanup = () => {
    clearInterval(dataTimer);
    clearInterval(syncTimer);
    clearInterval(tickTimer);
    process.stdout.write(`${ESC}[?1006l${ESC}[?1000l${ESC}[?25h${c.reset}\n`);
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  if (!isTty) return;

  process.stdout.write(`${ESC}[?1000h${ESC}[?1006h`);
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  const scrollBy = (n) => {
    state.scroll = Math.max(0, state.scroll + n);
    paint();
  };
  process.stdin.on("data", (chunk) => {
    const re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
    let m;
    while ((m = re.exec(chunk.toString("binary")))) {
      const [btn, x, y] = [Number(m[1]), Number(m[2]) - 1, Number(m[3]) - 1];
      if (m[4] !== "M") continue;
      if (btn === 64) scrollBy(-3);
      else if (btn === 65) scrollBy(3);
      else if (btn === 0 && y === 0) {
        const hit = tabHits.find((t) => x >= t.x0 && x < t.x1);
        if (hit) setView(hit.key);
      }
    }
  });
  process.stdin.on("keypress", (str, key) => {
    if (!key) return;
    const rows = process.stdout.rows || 40;
    if (key.ctrl && key.name === "c") {
      cleanup();
      process.exit(0);
    }
    if (key.name === "c" || key.name === "escape" || key.name === "q") {
      cleanup();
      leaveTo("cockpit");
    }
    if (key.name === "o") {
      cleanup();
      leaveTo("orch");
    }
    if (/^[1-9]$/.test(str || "") && VIEWS[Number(str) - 1]) setView(VIEWS[Number(str) - 1].key);
    else if (key.name === "z" && process.env.TMUX_PANE) spawnSync("tmux", ["resize-pane", "-Z", "-t", process.env.TMUX_PANE], { stdio: "ignore" });
    else if (key.name === "tab") step(key.shift ? -1 : 1);
    else if (key.name === "right" || key.name === "l") step(1);
    else if (key.name === "left" || key.name === "h") step(-1);
    else if (key.name === "j" || key.name === "down") scrollBy(1);
    else if (key.name === "k" || key.name === "up") scrollBy(-1);
    else if (key.name === "pagedown" || key.name === "space" || key.name === "f") scrollBy(rows - 4);
    else if (key.name === "pageup" || key.name === "b") scrollBy(-(rows - 4));
    else if (key.name === "g") scrollBy(key.shift ? 1e6 : -1e6);
    else if (key.name === "r") {
      for (const p of VIEW_PROBES[state.view]) probeState[p].at = 0;
      refreshData(state);
      due();
      paint();
    }
  });
}

if (isMainModule(import.meta.url)) {
  if (args.includes("-h") || args.includes("--help")) {
    console.log("usage: factory-window.mjs [watch|once] [--view tree|factory|hub|infra]");
  } else if (wantOnce) {
    runOnce();
  } else {
    runWatch();
  }
}
