#!/usr/bin/env node
/**
 * gotchi-factory — the belt view of one project, for the pstack dossier pane.
 *
 * Machines are gotchi heroes, belts are handoffs, belt items are tickets (work)
 * and mailbox messages (comms). A ticket's lifecycle IS a belt:
 *
 *   open → claimed → submitted → accepted | rework → closed
 *
 * so a piece spawns at its sender, sits in the machine that claimed it, and
 * moves on when the owner submits it. `rework` loops back down the same belt.
 *
 * Reads local project-room files only. Never writes, never spawns, no network.
 *
 *   node scripts/gotchi-factory.mjs                 # render the current project
 *   node scripts/gotchi-factory.mjs --project slug
 *   node scripts/gotchi-factory.mjs --json
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STAGE_OWNER, jobSignals } from "./project-tickets.mjs";
import { projectRoles } from "./project-context.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TICKET_STATUS = new Set(["open", "claimed", "submitted", "accepted", "rework", "closed"]);

/** Lifecycle position, used for the progress bar. Never invents a percentage. */
const STEP = { open: 0, claimed: 1, rework: 1, submitted: 3, accepted: 4, closed: 4 };

/**
 * Which side of a machine a ticket sits on.
 * rework dominates: a bounced piece needs owner attention before new work.
 */
export function machineState(held, bounced = []) {
  if (bounced.length) return "rework";
  if (held.some((t) => t.status === "claimed" || t.status === "submitted")) return "working";
  return "idle";
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function jsonDir(path) {
  try {
    return readdirSync(path).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
}

/** heroId → roleId → playbook title, so a machine reads as "Art Director". */
export function roleLabels() {
  const roles = projectRoles();
  if (!roles) return {};
  const playbooks = readJson(join(ROOT, "config/agent-role-playbooks.json")) || {};
  const out = {};
  for (const [heroId, roleId] of Object.entries(roles)) out[heroId] = playbooks[roleId]?.title || roleId;
  return out;
}

function roleIds() {
  return readJson(join(ROOT, "config/agent-roles.json")) || {};
}

/** Open jobs, limbo recomputed from ticket age so the pane does not wait for digest. */
export function readJobs(root, tickets, now = Date.now()) {
  const out = [];
  for (const name of jsonDir(join(root, "jobs"))) {
    const j = readJson(join(root, "jobs", name));
    if (!j?.id || j.stage === "reported") continue;
    const sig = jobSignals(j, tickets, now);
    out.push({
      id: String(j.id),
      stage: j.stage,
      owner: STAGE_OWNER[j.stage] || j.owner || null,
      title: String(j.title || j.id).replace(/\s+/g, " ").trim().slice(0, 80),
      limbo: sig.limbo,
      limboTickets: sig.limboTickets,
      tickets: Array.isArray(j.tickets) ? j.tickets.map(String) : [],
      updatedAt: j.updatedAt || null,
    });
  }
  const heat = (j) => (j.stage === "rework" ? 0 : j.limbo ? 1 : 2);
  out.sort((a, b) => heat(a) - heat(b) || String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return out.slice(0, 8);
}

function readTickets(root) {
  const dir = join(root, "tickets");
  const index = readJson(join(dir, "index.json"));
  const merged = new Map();
  for (const t of Array.isArray(index?.tickets) ? index.tickets : []) {
    if (t?.id) merged.set(String(t.id), { ...(merged.get(String(t.id)) || {}), ...t });
  }
  for (const name of jsonDir(dir)) {
    const t = readJson(join(dir, name));
    if (t?.id) merged.set(String(t.id), { ...(merged.get(String(t.id)) || {}), ...t });
  }
  const out = [];
  for (const t of merged.values()) {
    out.push({
      id: String(t.id),
      title: t.title || t.acceptance || t.id,
      from: t.from ?? null,
      to: t.to ?? null,
      status: TICKET_STATUS.has(t.status) ? t.status : "open",
      acceptance: t.acceptance ?? null,
      jobId: t.jobId ?? null,
      claimer: t.claimer ?? null,
      createdAt: t.createdAt ?? null,
      updatedAt: t.updatedAt ?? t.at ?? null,
    });
  }
  return out;
}

function readMail(root) {
  const desks = join(root, "desks");
  let names = [];
  try {
    names = readdirSync(desks);
  } catch {
    return [];
  }
  const out = [];
  for (const heroId of names) {
    const desk = join(desks, heroId);
    const boxes = [
      ["in", join(desk, "mailbox", "inbox.json")],
      ["out", join(desk, "mailbox", "sent.json")],
    ];
    for (const [dir, path] of boxes) {
      const body = readJson(path);
      const items = Array.isArray(body) ? body : Array.isArray(body?.messages) ? body.messages : [];
      for (const m of items) {
        if (!m?.id) continue;
        out.push({
          id: String(m.id),
          hero: heroId,
          dir,
          from: m.from ?? null,
          to: m.to ?? null,
          subject: m.subject || m.snippet || "(no subject)",
          read: m.read === true,
          at: m.at ?? m.receivedAt ?? m.sentAt ?? null,
        });
      }
    }
  }
  return out;
}

/** The whole belt model for one project. Never throws. */
export function factoryModel(slug, roster = [], projectRoles = null) {
  if (!slug) return { slug: null, reason: "no project selected", machines: [], items: [], jobs: [], stats: {} };
  const root = join(ROOT, "sessions", "pstack", slug);
  if (!existsSync(root)) return { slug: null, reason: `${slug}: project room not found`, machines: [], items: [], jobs: [], stats: {} };

  const tickets = readTickets(root);
  const mail = readMail(root);
  const jobs = readJobs(root, tickets);
  const roles = roleLabels();
  const byRole = projectRoles
    ? Object.fromEntries(Object.entries(projectRoles).filter(([, role]) => role))
    : roleIds();

  const heroes = new Set();
  for (const entry of roster) {
    // roster may be hero ids or { heroId } objects
    const id = typeof entry === "string" ? entry : entry?.heroId ?? entry?.id ?? entry?.hero;
    if (id) heroes.add(String(id));
  }
  for (const t of tickets) {
    if (t.to) heroes.add(t.to);
    if (t.from) heroes.add(t.from);
  }
  for (const m of mail) {
    if (m.from) heroes.add(m.from);
    if (m.to) heroes.add(m.to);
  }
  for (const job of jobs) {
    for (const [heroId, roleId] of Object.entries(byRole)) {
      if (roleId === job.owner) heroes.add(heroId);
    }
  }

  const machines = [...heroes]
    .map((heroId) => {
      const held = tickets.filter((t) => t.to === heroId);
      const sent = tickets.filter((t) => t.from === heroId);
      // rework lands back on the author: a piece bounced by review is their problem again
      const bounced = sent.filter((t) => t.status === "rework");
      const doing = held.filter((t) => t.status === "claimed" || t.status === "submitted");
      const steps = [...held, ...bounced].map((t) => STEP[t.status] ?? 0);
      const roleId = byRole[heroId] || null;
      const roleLabel = projectRoles ? roleId : roles[heroId] || null;
      const holds = (job) =>
        tickets.some(
          (t) =>
            (job.tickets.includes(t.id) || t.jobId === job.id) &&
            (t.to === heroId || t.claimer === heroId || t.from === heroId),
        );
      const blocking = jobs.filter((job) => job.owner === roleId || ((job.stage === "rework" || job.limbo) && holds(job)));
      const hot = (job) => (job.stage === "rework" ? 0 : job.limbo ? 1 : 2);
      blocking.sort((a, b) => hot(a) - hot(b));
      const job = blocking[0] || null;
      return {
        heroId,
        role: roleLabel,
        roleId,
        state: machineState(held, bounced),
        wip: doing.length + bounced.length,
        in: held.length,
        out: sent.length,
        step: steps.length ? Math.max(...steps) : 0,
        rework: bounced.length,
        unread: mail.filter((m) => m.hero === heroId && m.dir === "in" && !m.read).length,
        jobStage: job?.stage || null,
        jobLimbo: !!job?.limbo,
      };
    })
    // Only heroes with work on the belt are machines. A full cartridge roster
    // with no tickets would otherwise render as 20 idle rows. A hero the job
    // is waiting on still shows, so the stage has a machine.
    .filter((m) => m.in || m.out || m.rework || m.unread || m.wip || m.jobStage)
    .sort(
      (a, b) =>
        (a.state === "rework" || a.jobStage === "rework" || a.jobLimbo ? -1 : 0) -
          (b.state === "rework" || b.jobStage === "rework" || b.jobLimbo ? -1 : 0) ||
        b.wip - a.wip ||
        a.heroId.localeCompare(b.heroId),
    );

  const items = [
    ...tickets.map((t) => ({ kind: "ticket", id: t.id, label: t.title, from: t.from, to: t.to, status: t.status, step: STEP[t.status] ?? 0 })),
    ...mail.map((m) => ({ kind: "mail", id: m.id, label: m.subject, from: m.from ?? m.hero, to: m.to, dir: m.dir, status: m.read ? "closed" : "open", step: m.read ? 4 : 1 })),
  ];

  const working = machines.filter((m) => m.state === "working");
  const rework = machines.filter((m) => m.state === "rework");
  const bottleneck = [...rework, ...working].sort((a, b) => b.wip - a.wip || b.in - a.in)[0] || null;

  return {
    slug,
    roles,
    jobs,
    machines,
    items,
    stats: {
      wip: machines.reduce((n, m) => n + m.wip, 0),
      working: machines.filter((m) => m.state === "working").length,
      rework: rework.length,
      busy: machines.filter((m) => m.state !== "idle" || m.wip > 0).length,
      idle: machines.filter((m) => m.state === "idle" && m.wip === 0).length,
      bottleneck: bottleneck?.heroId ?? null,
    },
  };
}

/* ---------- render ---------- */

const ESC = "\x1b[";
const col = {
  reset: `${ESC}0m`,
  dim: `${ESC}2m`,
  bold: `${ESC}1m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  red: `${ESC}31m`,
  grey: `${ESC}90m`,
  cyan: `${ESC}36m`,
};

const GLYPH = {
  track: "─",
  item: "▓",
  loop: "↺",
  working: "◉",
  idle: "○",
  on: "█",
  off: "░",
};

function visLen(s) {
  return String(s ?? "").replace(/\x1b\[[0-9;]*m/g, "").length;
}

function fit(s, n) {
  const str = String(s ?? "");
  if (n <= 0) return "";
  if (visLen(str) <= n) return str;
  return `${str.slice(0, Math.max(0, n - 1))}…`;
}

/** Belt cells for a machine: work routed to it, or bounced back for rework. */
export function beltCells(machineId, items, tick, width) {
  if (width <= 0) return [];
  const cells = Array(width).fill(" ");
  const mine = items.filter((it) => (it.to === machineId && it.status !== "rework") || (it.from === machineId && it.status === "rework")).slice(0, 4);
  for (const [i, it] of mine.entries()) {
    const lane = (tick + i * 3) % Math.max(1, width);
    cells[lane] = it.status === "rework" ? "loop" : it.kind === "mail" ? "mail" : "item";
  }
  return cells;
}

/**
 * The factory band body: one line per machine + a note line.
 * Rows are plain text — the pane's packFullWidthPanel adds the box frame.
 */
export function factoryBand(model, { cols = 80, tick = 0, height = 8, color = true } = {}) {
  const c = color ? col : new Proxy({}, { get: () => "" });
  const inner = Math.max(10, cols - 4);
  const out = [];
  if (!model?.slug) {
    return [`  ${c.grey}${fit(model?.reason || "no project selected", inner - 2)}${c.reset}`, `  ${c.grey}select a project · cockpit → Select new project${c.reset}`];
  }
  const s = model.stats;
  const head = `wip ${s.wip} · ${s.busy ?? 0} busy · ${s.rework} rework · ${s.idle} idle`;
  out.push(`  ${c.bold}${fit(model.slug, 18)}${c.reset} ${c.dim}${head}${c.reset}`);

  const nameW = 18;
  const body = Math.max(1, height - 3);
  for (const m of model.machines.slice(0, body - 1)) {
    // a machine with rework attention is busy even if it never reached working
    const busy = m.state !== "idle" || m.wip > 0;
    const glyph = busy ? GLYPH.working : GLYPH.idle;
    const tint = m.state === "rework" ? c.yellow : busy ? c.green : c.grey;
    const bar = GLYPH.on.repeat(m.step) + GLYPH.off.repeat(4 - m.step);
    const beltW = Math.max(6, Math.min(24, inner - nameW - 22));
    const cells = beltCells(m.heroId, model.items, tick, beltW);
    const belt = cells
      .map((x) => (x === "item" ? c.cyan + GLYPH.item : x === "mail" ? c.dim + GLYPH.item : x === "loop" ? c.yellow + GLYPH.loop : c.grey + GLYPH.track) + c.reset)
      .join("");
    const label = `${glyph} ${fit(m.heroId, nameW - 2)}`;
    const stage = m.jobStage ? `${m.jobStage}${m.jobLimbo ? " limbo" : ""}` : m.role || m.state;
    const tail = `${c.dim}${bar} ${fit(stage, inner - nameW - beltW - 8)}${m.unread ? ` · ${c.yellow}${m.unread} new${c.reset}` : ""}${c.reset}`;
    out.push(`  ${tint}${label}${c.reset} ${belt} ${tail}`);
  }
  if (s.rework) {
    out.push(`  ${c.yellow}${GLYPH.loop} rework loops back down the same belt${c.reset} ${c.dim}· ${s.bottleneck || "—"} is the bottleneck${c.reset}`);
  } else if (!model.items.length) {
    out.push(`  ${c.grey}belts empty · no open work on this project${c.reset}`);
  }
  return out;
}

/* ---------- cli ---------- */

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const argv = process.argv.slice(2);
  const slugArg = argv.includes("--project") ? argv[argv.indexOf("--project") + 1] : null;
  let slug = slugArg;
  if (!slug) {
    try {
      const { currentProjectSlug } = await import("./project-context.mjs");
      slug = currentProjectSlug();
    } catch {
      slug = null;
    }
  }
  let model = factoryModel(slug);
  if (slug) {
    try {
      const { loadRoster } = await import("./project-context.mjs");
      const rows = loadRoster(slug).heroes || [];
      const ids = rows.map((h) => (typeof h === "string" ? h : h?.id)).filter(Boolean);
      const projectRoles = Object.fromEntries(
        rows.filter((h) => h && typeof h === "object" && h.role).map((h) => [h.id, h.role]),
      );
      model = factoryModel(slug, ids, projectRoles);
    } catch {
      model = factoryModel(slug);
    }
  }
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(model, null, 2)}\n`);
  } else {
    const cols = process.stdout.columns || Number(process.env.COLUMNS) || 80;
    process.stdout.write(`${factoryBand(model, { cols, color: !process.env.NO_COLOR, tick: Math.floor(Date.now() / 1000) }).join("\n")}\n`);
  }
}
