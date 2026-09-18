#!/usr/bin/env node
/**
 * pstack-window — JA2-style CURRENT STATUS / merc dossier pane (tmux work.1 center).
 *
 * Layout: HEADER · OPS|DOSSIER (boxed) · TEAM · Gotchis grid · FOOTER (OVERALL %)
 * SoT: sessions/pstack/<slug>/{dossier.json,units.tsv,ledger.tsv,decisions.tsv,briefs/}
 * Slug: currentProjectSlug() — never silently fall back to another project's dossier.
 *
 * DOSSIER portrait slot: dossier.fields.coverImage (path relative to
 * sessions/pstack/<slug>/ or repo root) renders via chafa when present;
 * otherwise the selected unit's gotchi ASCII. dossier.fields.pmHero shows in
 * the DOSSIER header when set.
 *
 *   node scripts/pstack-window.mjs watch            (interactive when stdin is a tty)
 *   node scripts/pstack-window.mjs once             single render (debug / capture)
 *   node scripts/pstack-window.mjs --interactive    force interactive keys
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import readline from "node:readline";
import { resolveHeroColors } from "./collateral-resolve.mjs";
import { renderKanbanAscii } from "./gotchi-art.mjs";
import { loadRoster, currentProjectSlug } from "./project-context.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PSTACK_ROOT = join(ROOT, "sessions", "pstack");
const POLICY = join(ROOT, "config", "pstack-dossier-policy.json");

const WATCH_MS = Number(process.env.GOTCHIBOT_PSTACK_WATCH_MS || 3000);
const ROSTER_S = Number(process.env.GOTCHIBOT_PSTACK_ROSTER_S || 15);
const ART_W = 12;
const ART_H = 9;
const MIN_DETAIL_H = 20;

const ESC = "\x1b";
const c = {
  reset: `${ESC}[0m`,
  dim: `${ESC}[2m`,
  bold: `${ESC}[1m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  cyan: `${ESC}[36m`,
  white: `${ESC}[37m`,
  gray: `${ESC}[90m`,
  border: `${ESC}[38;5;240m`,
  pink: `${ESC}[38;5;212m`,
  orange: `${ESC}[38;5;208m`,
  gold: `${ESC}[38;5;220m`,
};

const args = process.argv.slice(2);
const wantOnce = args.includes("--once") || args.includes("once");
const wantInteractive = args.includes("--interactive") || args.includes("--tui");
const isTty = Boolean(process.stdout.isTTY && process.stdin.isTTY);

/** Last paint: 0-based screen row where Gotchis header starts; term rows. */
let lastGridStartRow = -1;
let lastRows = 24;

/** Honor COLUMNS/LINES env when stdout is piped (once/capture); live TTY wins. */
function termSize() {
  const cols = process.stdout.columns || Number(process.env.COLUMNS) || 72;
  const rows = process.stdout.rows || Number(process.env.LINES) || 40;
  return { cols, rows };
}

/* ---------- tiny helpers ---------- */

function trunc(s, n) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (!t) return "—";
  return t.length > n ? `${t.slice(0, Math.max(0, n - 1))}…` : t;
}

function visLen(str) {
  return String(str || "").replace(/\x1b\[[0-9;]*m/g, "").length;
}

function padVis(str, width) {
  const s = String(str || "");
  const n = visLen(s);
  if (n >= width) return s;
  return s + " ".repeat(width - n);
}

function pad(str, width) {
  const s = String(str);
  const n = visLen(s);
  if (n <= width) return s + " ".repeat(width - n);
  let out = "";
  let vis = 0;
  const limit = Math.max(0, width - 1);
  for (let i = 0; i < s.length; ) {
    if (s[i] === "\x1b" && s[i + 1] === "[") {
      const m = s.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (vis >= limit) {
      out += `…${c.reset}`;
      break;
    }
    out += s[i];
    vis += 1;
    i += 1;
  }
  return out;
}

function readJsonSafe(path, fallback = null) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function formatPt(isoOrMs) {
  try {
    const d = new Date(isoOrMs);
    if (Number.isNaN(d.getTime())) return "—";
    return (
      d.toLocaleString("en-US", {
        timeZone: "America/Los_Angeles",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }) + " PT"
    );
  } catch {
    return "—";
  }
}

/** MM-DD HH:MM for ledger rows. */
function tsShort(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mi = String(d.getUTCMinutes()).padStart(2, "0");
    return `${mm}-${dd} ${hh}:${mi}`;
  } catch {
    return "—";
  }
}

/** s20260916-105038-47170 → 105038-47170 */
function sessionShort(session) {
  const s = String(session || "").trim();
  if (!s) return "—";
  const parts = s.split("-");
  if (parts.length >= 2) return parts.slice(-2).join("-");
  return trunc(s, 16);
}

function unitStateColor(state) {
  const s = String(state || "").toLowerCase();
  if (s === "running") return c.green;
  if (s === "planned" || s === "abandoned") return c.gray;
  if (s === "spawned") return c.cyan;
  if (s === "done") return c.white;
  if (s === "needs-verify" || s === "failed") return c.yellow;
  return c.white;
}

/* ---------- data sources ---------- */

/** Slug from project-context only — never pick another project's dossier. */
function currentSlug() {
  return currentProjectSlug() || "";
}

function dossierExists(slug) {
  return Boolean(slug && existsSync(join(PSTACK_ROOT, slug, "dossier.json")));
}

function loadPolicy() {
  return readJsonSafe(POLICY, { fields: [] });
}

function loadDossier(slug) {
  if (!slug) return null;
  return readJsonSafe(join(PSTACK_ROOT, slug, "dossier.json"), null);
}

function parseTsv(text) {
  const lines = String(text || "").split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const header = lines[0].split("\t").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split("\t");
    const row = {};
    header.forEach((h, i) => {
      row[h] = (cells[i] || "").trim();
    });
    return row;
  });
}

function loadUnits(slug) {
  if (!slug) return [];
  const p = join(PSTACK_ROOT, slug, "units.tsv");
  if (!existsSync(p)) return [];
  try {
    return parseTsv(readFileSync(p, "utf8"));
  } catch {
    return [];
  }
}

function loadLedger(slug) {
  if (!slug) return [];
  const p = join(PSTACK_ROOT, slug, "ledger.tsv");
  if (!existsSync(p)) return [];
  try {
    return parseTsv(readFileSync(p, "utf8"));
  } catch {
    return [];
  }
}

function loadDecisions(slug) {
  if (!slug) return [];
  const p = join(PSTACK_ROOT, slug, "decisions.tsv");
  if (!existsSync(p)) return [];
  try {
    return parseTsv(readFileSync(p, "utf8"));
  } catch {
    return [];
  }
}

function loadBrief(slug, unit) {
  if (!slug || !unit?.brief) return "";
  const p = join(ROOT, unit.brief);
  if (!existsSync(p)) return "";
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/* ---------- cover image (DOSSIER portrait slot) ---------- */

/**
 * Resolve dossier.fields.coverImage to an existing file. Tried in order:
 * sessions/pstack/<slug>/<path> then <repo-root>/<path>. Returns null when
 * unset or missing (caller falls back to the unit gotchi ASCII).
 */
function resolveCoverImage(slug, coverImagePath) {
  if (!slug || !coverImagePath) return null;
  const candidates = [join(PSTACK_ROOT, slug, coverImagePath), join(ROOT, coverImagePath)];
  for (const p of candidates) {
    try {
      if (existsSync(p) && statSync(p).isFile()) return p;
    } catch {
      /* keep trying */
    }
  }
  return null;
}

/**
 * Render the cover image as ANSI symbol art via chafa (already on the iMac/MBP).
 * Returns up to `h` lines; null when chafa is missing or fails.
 */
function renderCoverImage(path, w, h) {
  const r = spawnSync(
    "chafa",
    ["--format", "symbols", "--size", `${w}x${h}`, "--colors", "256", "--animate", "off", path],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  if (r.status !== 0 || !r.stdout) return null;
  // Strip chafa's cursor show/hide (DECTCEM) so the pane cursor stays put.
  const clean = r.stdout.replace(/\x1b\[\?25[hl]/g, "").replace(/\r?\n$/, "");
  return clean.split(/\r?\n/).slice(0, h);
}

/** Simple bordered placeholder box (path label) when chafa is unavailable. */
function coverPlaceholderLines(path, w, h) {
  const name = trunc(basename(path || ""), Math.max(3, w - 4));
  const inner = Math.max(1, w - 2);
  const lines = [];
  lines.push(`${c.border}${"─".repeat(inner)}${c.reset}`);
  const mid = Math.max(0, Math.floor((h - 2) / 2));
  for (let i = 0; i < Math.max(0, h - 2); i++) {
    if (i === mid) {
      const padL = Math.max(0, Math.floor((inner - visLen(name)) / 2));
      const padR = Math.max(0, inner - padL - visLen(name));
      lines.push(`${c.border}│${c.reset}${" ".repeat(padL)}${c.dim}${name}${c.reset}${" ".repeat(padR)}${c.border}│${c.reset}`);
    } else {
      lines.push(`${c.border}│${c.reset}${" ".repeat(inner)}${c.border}│${c.reset}`);
    }
  }
  lines.push(`${c.border}${"─".repeat(inner)}${c.reset}`);
  return lines.slice(0, h);
}

/**
 * Parse the desk map out of dossier.fields.units text (RUNTIME one-liner only).
 */
function parseDesks(unitsText) {
  const out = [];
  for (const raw of String(unitsText || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^desk-([a-z0-9-]+):\s*(.*)$/i);
    if (!m) continue;
    const id = `desk-${m[1]}`;
    let rest = m[2];
    const tagM = rest.match(/\[(staffed|backlog|npc)\]\s*$/i);
    const tag = tagM ? tagM[1].toLowerCase() : "backlog";
    if (tagM) rest = rest.slice(0, tagM.index).trim();
    const arrow = rest.indexOf("→");
    let desc = rest;
    let assign = "";
    if (arrow >= 0) {
      desc = rest.slice(0, arrow).trim();
      assign = rest.slice(arrow + 1).trim();
    }
    const hero = (assign.match(/(?:owned-\d+|starter-[a-z0-9-]+)/i) || [])[0] || null;
    out.push({ id, desc, assign, tag, hero });
  }
  return out;
}

function loadProjectRoster(slug) {
  const r = loadRoster(slug);
  const sealed = Array.isArray(r.heroes) && r.heroes.length > 0;
  return { heroes: sealed ? r.heroes.map(String) : [], sealed };
}

/** Units-only selectable list. */
function buildSelectables(units) {
  return (units || []).map((u) => ({ kind: "unit", unit: u }));
}

function fetchRoster() {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts/agent-focus.mjs"), "list", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || "").trim() || `exit ${r.status}`;
    throw new Error(`agent-focus list --json failed: ${err}`);
  }
  const parsed = JSON.parse((r.stdout || "").trim());
  return Array.isArray(parsed?.numbered) ? parsed.numbered.filter((e) => e.kind === "hero") : [];
}

function loadRoleCatalog() {
  const roles = readJsonSafe(join(ROOT, "config/agent-roles.json"), {}) || {};
  const playbooks = readJsonSafe(join(ROOT, "config/agent-role-playbooks.json"), {}) || {};
  return { roles, playbooks };
}

const artCache = new Map();

function artForHero(hero) {
  const traits = Array.isArray(hero.traits)
    ? hero.traits
    : Array.isArray(hero.modifiedTraits)
      ? hero.modifiedTraits
      : null;
  const traitsKey = traits ? traits.join(",") : "";
  const key = `${hero.id}|${hero.collateral || ""}|${traitsKey}`;
  if (artCache.has(key)) return artCache.get(key);
  const colors =
    resolveHeroColors({ id: hero.id, collateral: hero.collateral, hauntId: hero.hauntId }, hero.id) ||
    null;
  const art = renderKanbanAscii(colors, { useColor: true });
  const lines = art.split("\n").slice(0, ART_H);
  artCache.set(key, lines);
  return lines;
}

function statusShort(status) {
  const s = String(status || "available").toLowerCase();
  if (s === "working" || s === "active") return "work";
  if (s === "available") return "free";
  if (s === "assigned" || s === "watching") return "asgn";
  if (s === "idle") return "idle";
  if (s === "failed" || s === "error") return "fail";
  return s.slice(0, 4);
}

function statusColor(status) {
  const s = String(status || "").toLowerCase();
  if (s === "working" || s === "active") return c.green;
  if (s === "assigned" || s === "watching") return c.yellow;
  if (s === "failed" || s === "error") return c.yellow;
  if (s === "idle") return c.gray;
  return c.white;
}

function shortId(id) {
  const s = String(id || "");
  return s.replace(/^starter-/, "").replace(/^owned-/, "");
}

/* ---------- JA2 box chrome ---------- */

function boxTop(title, innerW) {
  const t = trunc(String(title || "").trim() || " ", Math.max(1, innerW - 3));
  const used = 3 + visLen(t); // "─ " + title + " "
  const fill = Math.max(0, innerW - used);
  return `${c.border}┌─ ${c.reset}${c.pink}${c.bold}${t}${c.reset}${c.border} ${"─".repeat(fill)}┐${c.reset}`;
}

function boxMid(title, innerW) {
  const t = trunc(String(title || "").trim() || " ", Math.max(1, innerW - 3));
  const used = 3 + visLen(t);
  const fill = Math.max(0, innerW - used);
  return `${c.border}├─ ${c.reset}${c.pink}${c.bold}${t}${c.reset}${c.border} ${"─".repeat(fill)}┤${c.reset}`;
}

function boxRow(content, innerW) {
  const body = pad(String(content ?? ""), innerW);
  return `${c.border}│${c.reset}${body}${c.border}│${c.reset}`;
}

function boxBottom(innerW) {
  return `${c.border}└${"─".repeat(innerW)}┘${c.reset}`;
}

function briefLabel(brief) {
  const s = String(brief || "").replace(/\\/g, "/").trim();
  if (!s) return "—";
  const parts = s.split("/").filter(Boolean);
  if (parts.length >= 2) return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  return parts[parts.length - 1] || "—";
}

function countUnitStates(units) {
  const counts = { planned: 0, running: 0, done: 0, failed: 0, total: units.length };
  for (const u of units) {
    const s = String(u.state || "").toLowerCase();
    if (s === "planned") counts.planned++;
    else if (s === "running") counts.running++;
    else if (s === "done") counts.done++;
    else if (s === "failed") counts.failed++;
  }
  return counts;
}

function buildEmptyDetailLines(slug, _rightW) {
  const lines = [];
  if (!slug) {
    lines.push(`  ${c.yellow}no project selected${c.reset}`);
    lines.push(`  ${c.dim}gotchibot pstack dossier current <slug>${c.reset}`);
  } else {
    lines.push(`  ${c.yellow}no pstack dossier for ${slug}${c.reset}`);
    lines.push(`  ${c.dim}gotchibot pstack dossier new ${slug} --goal "…"${c.reset}`);
  }
  return lines;
}

function pickBriefHeads(briefText) {
  const wanted = ["GOAL", "SCOPE", "VERIFY", "ACCEPTANCE"];
  const found = {};
  const lines = String(briefText || "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    for (const head of wanted) {
      if (found[head]) continue;
      const re = new RegExp(`^${head}\\b\\s*(.*)$`, "i");
      const m = t.match(re);
      if (!m) continue;
      let text = (m[1] || "").trim();
      if (!text) {
        for (let j = i + 1; j < lines.length; j++) {
          const n = lines[j].trim();
          if (!n) continue;
          if (/^(GOAL|SCOPE|VERIFY|ACCEPTANCE|FORBIDDEN|TIMEBOX|REPORT|CONTEXT|ROLE|MODEL_HINT|PREFER_HERO|STANDING)\b/i.test(n)) break;
          text = n;
          break;
        }
      }
      found[head] = { head, text };
    }
  }
  return wanted.filter((h) => found[h]).map((h) => found[h]);
}

function buildOpsRows({
  units = [],
  desks = [],
  ledger = [],
  decisions = [],
  dossier = null,
  roster = [],
  leftW,
  opsInnerH,
  cronAgents = [],
}) {
  const counts = countUnitStates(units || []);
  const staffed = (desks || []).filter((d) => d.tag === "staffed").length;
  const backlog = (desks || []).filter((d) => d.tag === "backlog").length;
  const content = [];
  const kv = (label, value) => `  ${c.dim}${padVis(label, 10)}${c.reset}${value}`;

  // PROGRAM (+ pm/cover kv). Separate PM/COVER/PROGRESS headers need ~23 rows;
  // panelsH clamp keeps opsInnerH≤22, so share the PROGRAM header.
  const progVal =
    `${trunc(String(dossier?.fields?.playbook || "—"), 8)} · ` +
    `${trunc(String(dossier?.status || "—"), 8)} · ` +
    `${trunc(String(dossier?.fields?.host || "—"), 6)} · ` +
    `${tsShort(dossier?.updatedAt)}`;
  const pmHero = String(dossier?.fields?.pmHero || "").trim();
  let pmVal;
  if (pmHero) {
    const pmH = (roster || []).find((h) => h.id === pmHero);
    const fleetStatus = pmH
      ? `${statusColor(pmH.status)}${statusShort(pmH.status)}${c.reset}`
      : `${c.dim}—${c.reset}`;
    pmVal = `${shortId(pmHero)} · ${trunc(String(dossier?.fields?.pmRole || "—"), 12)} · ${fleetStatus}`;
  } else {
    pmVal = `${c.dim}(unassigned)${c.reset}`;
  }
  const cover = String(dossier?.fields?.coverImage || "").trim();
  const coverVal = cover
    ? `${c.dim}${trunc(basename(cover), Math.max(6, leftW - 14))}${c.reset}`
    : `${c.dim}missing${c.reset}`;

  content.push(`${c.bold}PROGRAM${c.reset}`);
  content.push(kv("playbook", progVal));
  content.push(kv("pm", pmVal));
  content.push(kv("cover", coverVal));

  content.push(`${c.bold}UNITS${c.reset}`);
  // Two dense rows (≤26 vis) so LEDGER still fits at opsInnerH≈17
  content.push(
    `  ${c.dim}total${c.reset} ${c.gold}${counts.total}${c.reset} ${c.dim}· plan${c.reset} ${c.gray}${counts.planned}${c.reset} ${c.dim}· run${c.reset} ${c.green}${counts.running}${c.reset}`,
  );
  content.push(
    `  ${c.dim}done${c.reset} ${c.white}${counts.done}${c.reset} ${c.dim}· fail${c.reset} ${c.yellow}${counts.failed}${c.reset}`,
  );

  const pct = counts.total ? Math.round((counts.done / counts.total) * 100) : 0;
  const filled = counts.total ? Math.round((pct / 100) * 8) : 0;
  const clamped = Math.max(0, Math.min(8, filled));
  const bar =
    `${c.gold}${"█".repeat(clamped)}${c.reset}${c.dim}${"░".repeat(8 - clamped)}${c.reset}`;
  content.push(
    kv(
      "progress",
      `${c.gold}${counts.done}${c.reset}/${c.gold}${counts.total}${c.reset} done · ${c.gold}${pct}%${c.reset} ${bar}`,
    ),
  );

  content.push(`${c.bold}AI-CRON${c.reset}`);
  const nCron = (cronAgents || []).length;
  if (!nCron) {
    content.push(`  ${c.dim}(none in SoT)${c.reset}`);
  } else {
    const active = cronAgents.filter((a) => String(a.status).toLowerCase() === "active").length;
    content.push(kv("jobs", `${c.gold}${nCron}${c.reset}${c.dim} · active ${c.reset}${c.green}${active}${c.reset}`));
    for (const a of cronAgents.slice(0, 2)) {
      content.push(
        `  ${c.dim}${trunc(a.schedule || "—", 10)}${c.reset} ${trunc(a.name, Math.max(6, leftW - 16))}`,
      );
    }
  }

  content.push(`${c.bold}DESKS${c.reset}`);
  content.push(kv("staffed", `${c.gold}${staffed}${c.reset}`));
  content.push(kv("backlog", `${c.dim}${backlog}${c.reset}`));

  content.push(`${c.bold}DECISIONS${c.reset}`);
  const decRows = (decisions || []).slice(-2);
  if (!decRows.length) {
    content.push(`  ${c.dim}(no decisions)${c.reset}`);
  } else {
    for (const r of decRows) {
      content.push(
        `  ${c.dim}${trunc(String(r.phase || "—"), 10)}${c.reset} · ${trunc(String(r.decision || ""), Math.max(6, leftW - 16))}`,
      );
    }
  }

  content.push(`${c.bold}LEDGER${c.reset}`);
  const ledRows = (ledger || []).slice(-2);
  if (!ledRows.length) {
    content.push(`  ${c.dim}(no ledger)${c.reset}`);
  } else {
    for (const r of ledRows) {
      content.push(
        `  ${tsShort(r.ts)} ${trunc(String(r.unit || "—"), 12)} · ${trunc(String(r.verdict || "—"), 12)} · ${trunc(String(r.note || ""), Math.max(6, leftW - 22))}`,
      );
    }
  }

  // TOP-FIRST truncation — keep PROGRAM…DESKS; let DECISIONS/LEDGER shrink
  let body = content.length > opsInnerH ? content.slice(0, opsInnerH) : content.slice();
  while (body.length < opsInnerH) body.push("");
  return body.slice(0, opsInnerH);
}


/* ---------- ai-cron-site (dossier-ai-cron-site pane) ---------- */
/** Home SoT for remembered jobs (partner data-ai-cron-site; we only render). */
const CRON402_JOBS = join(process.env.HOME || "", ".cron402", "jobs.json");

/**
 * Normalize one agent row to the locked UI contract.
 * agentId ← jobId; name ← means|description; lastRuns from fires.
 */
function normalizeCronAgent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const agentId = String(raw.agentId || raw.jobId || "").trim();
  if (!agentId) return null;
  const name = String(raw.name || raw.means || raw.description || raw.url || agentId).trim();
  const schedule = String(raw.schedule || "").trim();
  const status = String(raw.status || "active").trim();
  const fires = raw.lastRuns || raw.executions || raw.fires || [];
  const lastRuns = (Array.isArray(fires) ? fires : []).slice(0, 5).map((f, i) => {
    if (!f || typeof f !== "object") return null;
    const ok = f.ok === true || f.ok === 1 || f.status === "success";
    const fail = f.ok === false || f.ok === 0 || f.status === "fail" || f.status === "error";
    const runAt = f.startedAt || f.runAt || null;
    const runAtIso = typeof runAt === "number" ? new Date(runAt).toISOString() : runAt;
    return {
      id: String(f.id || f.runAt || i),
      startedAt: runAtIso,
      finishedAt: f.finishedAt || null,
      status: ok ? "success" : fail ? "fail" : String(f.status || "unknown"),
      logSnippet: f.logSnippet || f.error || null,
      logPath: f.logPath || null,
      statusCode: f.statusCode ?? null,
      durationMs: f.durationMs ?? null,
    };
  }).filter(Boolean);
  return { agentId, name, schedule, status, lastRuns, credits: raw.credits ?? null };
}

function loadCronAgentsFromSot() {
  const raw = readJsonSafe(CRON402_JOBS, null);
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeCronAgent).filter(Boolean);
}

/**
 * Prefer optional dossier.cron snapshot, then partner module if present,
 * else read-only SoT ~/.cron402/jobs.json. Never invent rows.
 */
function loadCronAgents(slug, dossier) {
  const snap = dossier?.cron;
  if (Array.isArray(snap) && snap.length) {
    return snap.map(normalizeCronAgent).filter(Boolean);
  }
  if (snap && Array.isArray(snap.agents) && snap.agents.length) {
    return snap.agents.map(normalizeCronAgent).filter(Boolean);
  }
  // Partner fetch path (data-ai-cron-site) — sync require via createRequire not available;
  // optional sibling file sessions/pstack/<slug>/cron.json written by data layer.
  if (slug) {
    const side = readJsonSafe(join(PSTACK_ROOT, slug, "cron.json"), null);
    if (Array.isArray(side)) return side.map(normalizeCronAgent).filter(Boolean);
    if (side && Array.isArray(side.agents)) {
      return side.agents.map(normalizeCronAgent).filter(Boolean);
    }
  }
  return loadCronAgentsFromSot();
}

function cronStatusColor(status) {
  const s = String(status || "").toLowerCase();
  if (s === "active" || s === "ok" || s === "success" || s === "running") return c.green;
  if (s === "paused" || s === "idle") return c.yellow;
  if (s === "exhausted" || s === "fail" || s === "error" || s === "deleted") return c.orange;
  return c.dim;
}

function buildAiCronRows(agents, rightW) {
  const rows = ["__MID_AI_CRON__"];
  if (!agents.length) {
    rows.push(`  ${c.dim}(no ai-cron-site jobs — SoT ~/.cron402/jobs.json)${c.reset}`);
    return rows;
  }
  const max = 6;
  for (const a of agents.slice(0, max)) {
    const st = cronStatusColor(a.status);
    const sched = a.schedule || "—";
    const label = trunc(a.name, Math.max(8, rightW - 28));
    const idShort = trunc(a.agentId, 8);
    rows.push(
      `  ${st}${padVis(a.status || "?", 9)}${c.reset} ${c.dim}${idShort}${c.reset} ${sched} ${label}`,
    );
    const run = a.lastRuns?.[0];
    if (run) {
      const rs = cronStatusColor(run.status);
      const when = tsShort(run.startedAt || run.finishedAt);
      const snip = run.logSnippet ? trunc(String(run.logSnippet), Math.max(6, rightW - 22)) : "";
      rows.push(
        `    ${c.dim}last${c.reset} ${rs}${run.status}${c.reset} ${when}${snip ? ` ${c.dim}${snip}${c.reset}` : ""}`,
      );
    }
  }
  if (agents.length > max) {
    rows.push(`  ${c.dim}(+${agents.length - max} more)${c.reset}`);
  }
  return rows;
}


function buildDossierContentRows({
  empty,
  slug,
  dossier,
  unit,
  units,
  roster,
  rightW,
  cronAgents = [],
}) {
  if (empty) return buildEmptyDetailLines(slug, rightW);

  const rows = [];
  const heroObj =
    unit?.hero && Array.isArray(roster)
      ? roster.find((h) => h.id === unit.hero) || { id: unit.hero }
      : null;
  // Portrait slot: coverImage (chafa / placeholder box) wins; else unit gotchi ASCII.
  let portrait = null;
  const coverPath = resolveCoverImage(slug, dossier?.fields?.coverImage);
  if (coverPath) {
    portrait = renderCoverImage(coverPath, ART_W, ART_H) || coverPlaceholderLines(coverPath, ART_W, ART_H);
  } else if (heroObj) {
    portrait = artForHero(heroObj);
  }
  const art = portrait;
  const kvW = 9;
  const kvCol = 14; // portrait 12 + 2 spaces
  const kvInner = Math.max(8, rightW - kvCol);

  const fleetHero = unit?.hero && Array.isArray(roster) ? roster.find((h) => h.id === unit.hero) : null;
  const fleetVal = fleetHero
    ? `${statusColor(fleetHero.status)}${statusShort(fleetHero.status)}${c.reset}`
    : "—";

  const stats = unit
    ? [
        [`ROLE`, unit.role || "—"],
        [`STATE`, `${unitStateColor(unit.state)}${unit.state || "planned"}${c.reset}`],
        [`HERO`, trunc(unit.hero || "—", Math.max(6, kvInner - 1))],
        [`SESSION`, sessionShort(unit.session)],
        [`BRIEF`, trunc(briefLabel(unit.brief), Math.max(6, kvInner - 1))],
        [`FLEET`, fleetVal],
      ]
    : [];

  for (let i = 0; i < ART_H; i++) {
    let left;
    if (art && art[i] != null) {
      left = padVis(art[i], 12);
    } else {
      left = padVis(i === Math.floor(ART_H / 2) ? `${c.dim}(no hero)${c.reset}` : "", 12);
    }
    const kv = stats[i];
    let right = "";
    if (kv) {
      right = `${c.dim}${padVis(kv[0], kvW)}${c.reset}${kv[1]}`;
    }
    rows.push(`${left}  ${right}`);
  }
  // shortId under portrait
  const sid = unit?.hero ? shortId(unit.hero) : "";
  const under = sid ? `${c.dim}${padVis((" ".repeat(Math.max(0, Math.floor((12 - visLen(sid)) / 2))) + sid).slice(0, 12), 12)}${c.reset}` : padVis("", 12);
  rows.push(`${under}  `);

  for (const r of buildAiCronRows(cronAgents, rightW)) rows.push(r);

  rows.push("__MID_MISSION__");
  const briefText = unit ? loadBrief(slug, unit) : "";
  const heads = pickBriefHeads(briefText);
  if (heads.length) {
    for (const h of heads.slice(0, 4)) {
      rows.push(
        `  ${c.yellow}${h.head}${c.reset} ${trunc(h.text || "", Math.max(8, rightW - 14))}`,
      );
    }
  } else {
    const goal = String(dossier?.fields?.goal || "").trim();
    if (goal) {
      rows.push(`  ${c.yellow}GOAL${c.reset} ${trunc(goal, Math.max(8, rightW - 14))}`);
    } else {
      rows.push(`  ${c.dim}(no brief yet)${c.reset}`);
    }
  }

  rows.push("__MID_ACCEPTANCE__");
  const acceptBrief = heads.find((h) => h.head.toUpperCase() === "ACCEPTANCE");
  const acceptField = String(dossier?.fields?.acceptance || "").trim();
  if (acceptField) {
    for (const line of acceptField.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 2)) {
      rows.push(`  ${trunc(line, Math.max(8, rightW - 4))}`);
    }
  } else if (acceptBrief?.text) {
    rows.push(`  ${trunc(acceptBrief.text, Math.max(8, rightW - 4))}`);
  } else {
    rows.push(`  ${c.dim}(no acceptance)${c.reset}`);
  }

  const counts = countUnitStates(units || []);
  const pct = counts.total ? Math.round((counts.done / counts.total) * 100) : 0;
  rows.push("__PROGRESS__");
  rows.push(
    `  ${c.gold}${c.bold}PROGRESS${c.reset} ${c.gold}${c.bold}${counts.done}${c.reset}/${c.gold}${c.bold}${counts.total}${c.reset} done · ${c.gold}${c.bold}${pct}%${c.reset}`,
  );
  return rows;
}

function packDossierPanel(contentRows, rightW, opsH, detailScroll, titleBase) {
  const innerH = Math.max(1, opsH - 2); // top+bottom borders
  const expanded = [];
  let progressRow = null;
  let takeProgress = false;
  for (const row of contentRows) {
    if (row === "__MID_MISSION__") expanded.push({ mid: "MISSION" });
    else if (row === "__MID_ACCEPTANCE__") expanded.push({ mid: "ACCEPTANCE" });
    else if (row === "__MID_AI_CRON__") expanded.push({ mid: "AI-CRON" });
    else if (row === "__PROGRESS__") takeProgress = true;
    else if (takeProgress) {
      progressRow = { text: row };
      takeProgress = false;
    } else expanded.push({ text: row });
  }
  // Pin PROGRESS as the last visible content row (JA2 overall feel); scroll the rest
  const sticky = progressRow ? 1 : 0;
  const scrollH = Math.max(1, innerH - sticky);
  const maxScroll = Math.max(0, expanded.length - scrollH);
  const ds = Math.min(Math.max(0, detailScroll || 0), maxScroll);
  const slice = expanded.slice(ds, ds + scrollH);
  while (slice.length < scrollH) slice.push({ text: "" });
  if (progressRow) slice.push(progressRow);

  const title =
    maxScroll > 0 ? `${titleBase} · scroll ${ds}/${maxScroll}` : titleBase;
  const out = [boxTop(title, rightW)];
  for (const item of slice) {
    if (item.mid) out.push(boxMid(item.mid, rightW));
    else out.push(boxRow(item.text, rightW));
  }
  // Ensure exact opsH lines
  while (out.length < opsH - 1) out.push(boxRow("", rightW));
  if (out.length > opsH - 1) out.length = opsH - 1;
  out.push(boxBottom(rightW));
  return { lines: out, maxScroll, ds };
}

function packOpsPanel(contentRows, leftW, opsH) {
  const innerH = Math.max(1, opsH - 2);
  const body = contentRows.slice(0, innerH);
  while (body.length < innerH) body.push("");
  const out = [boxTop("OPS", leftW)];
  for (const row of body) out.push(boxRow(row, leftW));
  out.push(boxBottom(leftW));
  return out;
}

function buildTeamLines(units, sel, empty, cols) {
  const innerW = Math.max(8, cols - 2);
  const out = [boxTop("TEAM", innerW)];
  if (empty) {
    out.push(boxRow(`  ${c.dim}(no project selected)${c.reset}`, innerW));
  } else if (!units.length) {
    out.push(
      boxRow(
        `  ${c.dim}(no units — gotchibot pstack unit add <slug> --role worker --goal "…")${c.reset}`,
        innerW,
      ),
    );
  } else {
    const len = units.length;
    const win = Math.min(4, len);
    let windowStart = 0;
    if (len > 4) {
      windowStart = Math.max(0, Math.min(sel - 3, len - 4));
    }
    for (let i = 0; i < win; i++) {
      const idx = windowStart + i;
      const u = units[idx];
      const isSel = sel === idx;
      const marker = isSel ? `${c.yellow}${c.bold}▸${c.reset}` : " ";
      const idBit = isSel ? `${c.bold}${u.id}${c.reset}` : u.id;
      const st = unitStateColor(u.state);
      out.push(
        boxRow(
          `  ${marker} ${idBit} · ${u.role || "—"} · ${st}${u.state || "planned"}${c.reset} · ${shortId(u.hero)} · ${sessionShort(u.session)}`,
          innerW,
        ),
      );
    }
  }
  out.push(boxBottom(innerW));
  return out;
}

/* ---------- gotchi thumb grid ---------- */

function buildGridLines(heroes, innerW, page, gridRows) {
  const out = [];
  if (!heroes.length) {
    out.push(`${c.dim}(no heroes on cartridge)${c.reset}`);
    return { lines: out, pages: 1, perPage: 0, cols: 0, pg: 0 };
  }
  let cols = Math.max(1, Math.floor((innerW + 1) / (ART_W + 1)));
  let cellW = Math.max(ART_W, Math.floor(innerW / cols));
  while (cols > 1 && cols * cellW + (cols - 1) > innerW) {
    cols -= 1;
    cellW = Math.max(ART_W, Math.floor(innerW / cols));
  }
  const perPage = Math.max(1, cols * gridRows);
  const pages = Math.max(1, Math.ceil(heroes.length / perPage));
  const pg = Math.min(Math.max(0, page || 0), pages - 1);
  const slice = heroes.slice(pg * perPage, pg * perPage + perPage);
  const rows = Math.ceil(slice.length / cols);

  const { roles } = loadRoleCatalog();
  const cells = slice.map((h) => {
    const art = artForHero(h) || [];
    const role = roles[h.id] || null;
    const roleTitle = role?.title || null;
    const task = h.agentTask || null;
    const label2 =
      roleTitle || (task && task !== h.id ? task : null) || (role ? h.id : null) || "—";
    return {
      id: h.id,
      status: String(h.status || "available").toLowerCase(),
      art,
      label1: `${statusColor(h.status)}${pad(statusShort(h.status), 5)}${c.reset}${trunc(shortId(h.id), Math.max(4, cellW - 7))}`,
      label2: `${c.dim}${trunc(label2, Math.max(4, cellW - 1))}${c.reset}`,
    };
  });

  for (let r = 0; r < rows; r++) {
    const rowCells = cells.slice(r * cols, r * cols + cols);
    for (let a = 0; a < ART_H; a++) {
      const line = rowCells.map((cell) => padVis(cell.art[a] || "", cellW)).join(" ");
      out.push(pad(line, innerW));
    }
    for (let l = 0; l < 2; l++) {
      const line = rowCells.map((cell) => padVis(l === 0 ? cell.label1 : cell.label2, cellW)).join(" ");
      out.push(pad(line, innerW));
    }
  }
  return { lines: out, pages, perPage, cols, pg };
}

/**
 * Prefer heroes BOUND TO UNITS (running first), deduped, present in cartridge roster.
 * Else project roster / cartridge fallback.
 */
function pickGridHeroes(units, cartridgeRoster, projectRoster) {
  const byId = new Map(cartridgeRoster.map((h) => [h.id, h]));
  const seen = new Set();
  const ordered = [];
  const running = units.filter((u) => String(u.state || "").toLowerCase() === "running");
  const rest = units.filter((u) => String(u.state || "").toLowerCase() !== "running");
  for (const u of [...running, ...rest]) {
    const id = String(u.hero || "").trim();
    if (!id || seen.has(id) || !byId.has(id)) continue;
    seen.add(id);
    ordered.push(byId.get(id));
  }
  if (ordered.length) {
    return { heroes: ordered, label: "Unit heroes", projectScope: true };
  }
  if (projectRoster.sealed) {
    const matched = projectRoster.heroes.filter((id) => byId.has(id)).map((id) => byId.get(id));
    if (matched.length) {
      return { heroes: matched, label: "project roster", projectScope: true };
    }
  }
  return { heroes: cartridgeRoster, label: "cartridge", projectScope: false };
}

/* ---------- render ---------- */

function render({
  dossier,
  slug,
  units,
  desks,
  ledger,
  decisions,
  gridHeroes,
  gridLabel,
  empty,
  sel,
  term,
  page,
  detailScroll,
  roster,
  cronAgents = [],
}) {
  const cols = Math.max(30, term.cols);
  const rowsN = Math.max(14, term.rows);
  const headerH = 1;
  const footerH = 2;
  const bodyH = Math.max(1, rowsN - headerH - footerH);

  const unitList = units || [];
  let teamH = Math.max(1, (unitList.length ? Math.min(unitList.length, 4) : 1) + 2);
  let gridRows = 2;
  let gridH = gridRows * (ART_H + 2) + 1;
  let panelsH = bodyH - gridH - teamH;
  if (panelsH < 12) {
    gridRows = 1;
    gridH = gridRows * (ART_H + 2) + 1;
    panelsH = bodyH - gridH - teamH;
  }
  // Prefer panels in [8,24] when space allows; never go negative / never steal footer
  if (panelsH >= 8) {
    panelsH = Math.min(24, panelsH);
  } else {
    // Shrink grid further conceptually by capping grid view later; keep panels ≥1
    panelsH = Math.max(1, bodyH - teamH - 1); // leave at least 1 for grid header
    gridH = Math.max(1, bodyH - teamH - panelsH);
    gridRows = 1;
  }
  const opsH = Math.max(1, panelsH);

  const leftW = Math.max(20, Math.min(26, Math.round(cols * 0.32)));
  const leftPanelW = leftW + 2;
  const gap = 1;
  const rightPanelW = Math.max(18, cols - leftPanelW - gap);
  const rightW = Math.max(12, rightPanelW - 2);

  const lines = [];

  // a) HEADER
  let header;
  if (empty) {
    header = `${c.pink}${c.bold}CURRENT STATUS${c.reset}${c.dim} · ${slug || "no project"}${c.reset}`;
  } else {
    const title = dossier?.fields?.title || slug || "no project";
    const playbook = dossier?.fields?.playbook || "—";
    const status = dossier?.status || "—";
    header =
      `${c.pink}${c.bold}CURRENT STATUS${c.reset} ${c.bold}${title}${c.reset}` +
      `${c.dim} · ${slug} · ${playbook} · ${status} · updated ${formatPt(dossier?.updatedAt)}${c.reset}`;
  }
  lines.push(pad(header, cols));

  const selectables = empty ? [] : buildSelectables(unitList);
  const selItem = selectables[sel] || null;
  const selUnit = selItem?.unit || null;
  const unitId = selUnit?.id || "program";

  // b+c) OPS | DOSSIER
  const opsInnerH = Math.max(1, opsH - 2);
  const opsBody = empty
    ? (() => {
        const b = [`  ${c.dim}(no dossier)${c.reset}`];
        while (b.length < opsInnerH) b.push("");
        return b;
      })()
    : buildOpsRows({
        units: unitList,
        desks: desks || [],
        ledger: ledger || [],
        decisions: decisions || [],
        dossier,
        roster: roster || [],
        leftW,
        opsInnerH,
        cronAgents: cronAgents || [],
      });
  const opsLines = packOpsPanel(opsBody, leftW, opsH);

  const dossierRows = buildDossierContentRows({
    empty,
    slug,
    dossier,
    unit: selUnit,
    units: unitList,
    roster: roster || [],
    rightW,
    cronAgents: cronAgents || [],
  });
  const dossierPacked = packDossierPanel(
    dossierRows,
    rightW,
    opsH,
    detailScroll,
    `DOSSIER · ${unitId}${dossier?.fields?.pmHero ? ` · PM ${shortId(dossier.fields.pmHero)}` : ""}`,
  );

  const panelRows = Math.max(opsLines.length, dossierPacked.lines.length);
  for (let i = 0; i < panelRows; i++) {
    const L = opsLines[i] || pad("", leftPanelW);
    const R = dossierPacked.lines[i] || pad("", rightPanelW);
    lines.push(pad(`${padVis(L, leftPanelW)} ${padVis(R, rightPanelW)}`, cols));
  }

  // d) TEAM
  const teamLines = buildTeamLines(unitList, sel || 0, empty, cols);
  const teamBudget = Math.min(Math.max(1, teamH), teamLines.length);
  for (let i = 0; i < teamBudget; i++) {
    lines.push(pad(teamLines[i] || "", cols));
  }

  // e) GOTCHIS grid — fill remaining body after panels+team, never eat footer
  const afterPanelsTeam = 1 + panelRows + teamBudget;
  lastGridStartRow = afterPanelsTeam;
  lastRows = rowsN;
  const gridBudget = Math.max(1, rowsN - footerH - afterPanelsTeam);
  const gridInnerW = cols - 1;
  const grid = buildGridLines(gridHeroes || [], gridInnerW, page || 0, gridRows);
  const pageLabel = grid.pages > 1 ? ` · page ${grid.pg + 1}/${grid.pages}` : "";
  const gridHeader = `${c.cyan}Gotchis${c.reset} ${c.dim}| ${gridLabel || "cartridge"} · ${(gridHeroes || []).length} heroes${pageLabel} · refresh ${ROSTER_S}s${c.reset}`;
  const gridViewH = Math.max(0, gridBudget - 1);
  lines.push(pad(gridHeader, cols));
  for (let y = 0; y < gridViewH; y++) {
    lines.push(pad(grid.lines[y] || "", cols));
  }

  // f) FOOTER — always last 2 lines
  const counts = countUnitStates(unitList);
  const pct = counts.total ? Math.round((counts.done / counts.total) * 100) : 0;
  // Trim overflow before footer (keep header+panels+team preference)
  while (lines.length > rowsN - footerH) lines.pop();
  while (lines.length < rowsN - footerH) lines.push(pad("", cols));
  lines.push(
    pad(
      `${c.dim}j/k select · h/l page grid · u/d scroll dossier · wheel pages grid / scrolls dossier · q quit${c.reset}`,
      cols,
    ),
  );
  // OVERALL first (always visible); leave path shortened (no ./scripts/).
  // At ≥72 cols allow 3-col overflow so the leave hint is not ellipsis-truncated.
  // Narrower panes: pad() keeps OVERALL and trims the leave tail.
  {
    const foot2 = `${c.gold}${c.bold}OVERALL ${pct}% done (${counts.done}/${counts.total})${c.reset}${c.dim} · leave: orchestrator-layout.sh leave-pstack-dossier${c.reset}`;
    const n = visLen(foot2);
    if (n <= cols) lines.push(foot2 + " ".repeat(cols - n));
    else if (cols >= 72) lines.push(foot2);
    else lines.push(pad(foot2, cols));
  }

  process.stdout.write(`${ESC}[?25l${ESC}[H${ESC}[J`);
  process.stdout.write(lines.join("\n"));
}

/* ---------- state + watch ---------- */

function buildState() {
  const slug = currentSlug();
  const hasDossier = dossierExists(slug);
  const empty = !hasDossier;
  const dossier = hasDossier ? loadDossier(slug) : null;
  const cronAgents = loadCronAgents(slug, dossier);
  const units = hasDossier ? loadUnits(slug) : [];
  const ledger = hasDossier ? loadLedger(slug) : [];
  const decisions = hasDossier ? loadDecisions(slug) : [];
  const desks = hasDossier ? parseDesks(dossier?.fields?.units || "") : [];
  const pr = loadProjectRoster(slug);
  let roster = [];
  try {
    roster = fetchRoster();
  } catch {
    roster = [];
  }
  const picked = pickGridHeroes(units, roster, pr);
  return {
    slug,
    dossier,
    units,
    desks,
    ledger,
    decisions,
    empty,
    roster,
    cronAgents,
    gridHeroes: picked.heroes,
    gridLabel: picked.label,
    projectScope: picked.projectScope,
    at: new Date().toISOString(),
  };
}

function fingerprint(state) {
  const slug = state.slug;
  let fp = `${slug}|${state.empty ? "empty" : "ok"}|${state.roster.length}|${state.at}`;
  if (slug && !state.empty) {
    for (const f of ["dossier.json", "units.tsv", "ledger.tsv", "decisions.tsv", "roster.json"]) {
      try {
        fp += `|${statSync(join(PSTACK_ROOT, slug, f)).mtimeMs}`;
      } catch {}
    }
  }
  return fp;
}

function markSelf() {
  if (!process.env.TMUX || !process.env.TMUX_PANE) return;
  spawnSync("tmux", ["set-option", "-p", "-t", process.env.TMUX_PANE, "@gotchibot-pstack-dossier", "1"], {
    stdio: "ignore",
  });
  spawnSync(
    "tmux",
    ["set-option", "-p", "-t", process.env.TMUX_PANE, "pane-border-format", " pstack · dossier "],
    { stdio: "ignore" },
  );
  spawnSync("tmux", ["set-option", "-p", "-t", process.env.TMUX_PANE, "pane-scrollbars", "off"], {
    stdio: "ignore",
  });
}

function runWatch() {
  markSelf();
  let state = buildState();
  let sel = 0;
  let page = 0;
  let detailScroll = 0;
  let lastFp = fingerprint(state);
  let lastRosterTick = Date.now();
  const term = termSize();

  const paint = () => {
    const selectables = buildSelectables(state.units || []);
    const selIdx = selectables.length ? Math.min(sel, selectables.length - 1) : -1;
    render({ ...state, sel: selIdx, page, detailScroll, term });
  };

  const refresh = () => {
    state = buildState();
    const selectables = buildSelectables(state.units || []);
    if (selectables.length) sel = Math.min(sel, selectables.length - 1);
    else sel = 0;
    paint();
  };

  const onResize = () => {
    Object.assign(term, termSize());
    paint();
  };
  process.stdout.on("resize", onResize);

  const onUsr1 = () => {
    try {
      refresh();
    } catch {}
  };
  process.on("SIGUSR1", onUsr1);

  paint();

  const timer = setInterval(() => {
    try {
      const next = buildState();
      const fp = fingerprint(next);
      const rosterDue = Date.now() - lastRosterTick >= ROSTER_S * 1000;
      if (fp !== lastFp || rosterDue) {
        state = next;
        lastFp = fp;
        lastRosterTick = Date.now();
        const selectables = buildSelectables(state.units || []);
        if (selectables.length) sel = Math.min(sel, selectables.length - 1);
        else sel = 0;
        paint();
      }
    } catch {}
  }, WATCH_MS);

  const cleanup = () => {
    clearInterval(timer);
    process.stdout.removeListener("resize", onResize);
    process.removeListener("SIGUSR1", onUsr1);
    process.stdout.write(`${ESC}[?1006l${ESC}[?1000l${ESC}[?25h${ESC}[0m\n`);
  };

  if (isTty) {
    // X10 + SGR mouse so wheel reaches the pane (tmux send-keys -M).
    process.stdout.write(`${ESC}[?1000h${ESC}[?1006h`);
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    const scrollDetail = (delta) => {
      detailScroll = Math.max(0, detailScroll + delta);
      paint();
    };
    const handleWheel = (btn, _x, y) => {
      // btn 64 = wheel up, 65 = wheel down (X10 / SGR)
      if (btn !== 64 && btn !== 65) return;
      const gridY =
        lastGridStartRow >= 0 ? lastGridStartRow : Math.max(0, Math.floor(lastRows * 0.7));
      if (y >= gridY) {
        page = Math.max(0, page + (btn === 64 ? -1 : 1));
        paint();
      } else {
        scrollDetail(btn === 64 ? -3 : 3);
      }
    };
    process.stdin.on("data", (chunk) => {
      const s = chunk.toString("binary");
      // SGR: CSI < btn ; x ; y M/m  (x/y 1-based → 0-based)
      const sgrRe = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
      let m;
      while ((m = sgrRe.exec(s))) {
        const btn = Number(m[1]);
        const mx = Number(m[2]) - 1;
        const my = Number(m[3]) - 1;
        if (m[4] === "M") handleWheel(btn, mx, my);
      }
      // X10: ESC [ M btn x y  (each +32; x/y already 0-based)
      for (let i = 0; i + 6 <= s.length; i++) {
        if (s.slice(i, i + 3) !== "\x1b[M") continue;
        const btn = s.charCodeAt(i + 3) - 32;
        const mx = s.charCodeAt(i + 4) - 32;
        const my = s.charCodeAt(i + 5) - 32;
        handleWheel(btn, mx, my);
      }
    });
    process.stdin.on("keypress", (str, key) => {
      if (!key) return;
      if ((key.ctrl && key.name === "c") || key.name === "q" || key.name === "escape") {
        cleanup();
        process.exit(0);
      }
      const n = (state.units || []).length;
      if (key.name === "j" || key.name === "down") {
        if (n) {
          sel = Math.min(n - 1, sel + 1);
          detailScroll = 0;
          paint();
        }
      } else if (key.name === "k" || key.name === "up") {
        if (n) {
          sel = Math.max(0, sel - 1);
          detailScroll = 0;
          paint();
        }
      } else if (
        key.name === "h" ||
        key.name === "l" ||
        key.name === "[" ||
        key.name === "]" ||
        key.name === "left" ||
        key.name === "right"
      ) {
        const dir = ["h", "[", "left"].includes(key.name) ? -1 : 1;
        page = Math.max(0, page + dir);
        paint();
      } else if (key.name === "u") {
        scrollDetail(-3);
      } else if (key.name === "d") {
        scrollDetail(3);
      }
    });
  }

  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
}

function runOnce() {
  markSelf();
  const state = buildState();
  const term = termSize();
  render({ ...state, sel: 0, page: 0, detailScroll: 0, term });
  process.stdout.write(`${ESC}[?25h${ESC}[0m\n`);
}

function usage() {
  console.log(`usage:
  pstack-window watch            # interactive when stdin is a tty (j/k select · h/l page · u/d scroll · wheel pages grid / scrolls dossier · q quit); --interactive forces it
  pstack-window once             # single render (debug / capture)
  pstack-window --interactive    # force interactive keys even if not obvious

SoT: sessions/pstack/<slug>/{dossier.json,units.tsv,ledger.tsv,decisions.tsv,briefs/}
Slug: currentProjectSlug() — never falls back to another dossier
`);
}

function main() {
  if (args.includes("-h") || args.includes("--help")) {
    usage();
    process.exit(0);
  }
  if (wantOnce) {
    runOnce();
    return;
  }
  if (args.includes("watch") || args.includes("--watch") || wantInteractive || !args.length) {
    runWatch();
    return;
  }
  usage();
  process.exit(2);
}

main();
