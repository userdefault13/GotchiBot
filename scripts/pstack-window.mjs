#!/usr/bin/env node
/**
 * pstack-window — JA2-style CURRENT STATUS / merc dossier pane (tmux work.1 center).
 *
 * Layout: HEADER · OPS|DOSSIER · TEAM · INBOX · AI-CRON · Gotchis · FOOTER
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
import { loadBox, listMessages } from "./bot-inbox.mjs";

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
let lastCockpitBtn = null; // [{ key, x0, x1, y }, ...] footer nav hitboxes
let lastDossierScroll = 0;
let lastDossierMaxScroll = 0;

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

/** Right-edge glyph for a dossier body row (replaces the closing │). */
function boxRowScroll(content, innerW, edge) {
  const body = pad(String(content ?? ""), innerW);
  return `${c.border}│${c.reset}${body}${edge}`;
}

function boxMidScroll(title, innerW, edge) {
  const t = trunc(String(title || "").trim() || " ", Math.max(1, innerW - 3));
  const used = 3 + visLen(t);
  const fill = Math.max(0, innerW - used);
  return `${c.border}├─ ${c.reset}${c.pink}${c.bold}${t}${c.reset}${c.border} ${"─".repeat(fill)}${c.reset}${edge}`;
}

/**
 * Vertical scrollbar track for the DOSSIER pane body.
 * trackH = visible body rows (excluding top/bottom borders).
 * Returns one glyph string per row (already colored).
 */
function dossierScrollTrack(trackH, ds, maxScroll, viewH) {
  const h = Math.max(1, trackH | 0);
  const plain = `${c.border}│${c.reset}`;
  if (maxScroll <= 0) {
    return Array.from({ length: h }, () => plain);
  }
  const content = maxScroll + Math.max(1, viewH);
  const thumbH = Math.max(1, Math.min(h, Math.round((viewH / content) * h) || 1));
  const maxTop = Math.max(0, h - thumbH);
  const thumbTop = maxScroll <= 0 ? 0 : Math.round((ds / maxScroll) * maxTop);
  const track = `${c.dim}░${c.reset}`;
  const thumb = `${c.gold}█${c.reset}`;
  const out = [];
  for (let i = 0; i < h; i++) {
    out.push(i >= thumbTop && i < thumbTop + thumbH ? thumb : track);
  }
  // tip markers when not at ends
  if (ds > 0 && out[0] === track) out[0] = `${c.pink}▲${c.reset}`;
  if (ds < maxScroll && out[h - 1] === track) out[h - 1] = `${c.pink}▼${c.reset}`;
  return out;
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
  inboxMessages = [],
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

  content.push(`${c.bold}INBOX${c.reset}`);
  const inboxMsgs = inboxMessages || [];
  const nInbox = inboxMsgs.length;
  const nUnread = inboxMsgs.filter((m) => !m.readAt).length;
  const nPkm = inboxMsgs.filter((m) => isPkmNote(m)).length;
  if (!nInbox) {
    content.push(`  ${c.dim}(empty)${c.reset}`);
  } else {
    content.push(
      kv(
        "msgs",
        `${c.gold}${nInbox}${c.reset}` +
          (nUnread ? `${c.dim} · ${c.reset}${c.yellow}${nUnread} unread${c.reset}` : `${c.dim} · all read${c.reset}`) +
          (nPkm ? `${c.dim} · ${c.reset}${c.orange}${nPkm} pkm${c.reset}` : ""),
      ),
    );
    const sorted = [...inboxMsgs].sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
    for (const m of sorted.slice(0, 2)) {
      const mark = m.readAt ? " " : `${c.yellow}•${c.reset}`;
      content.push(
        `  ${mark}${c.dim}${trunc(String(m.kind || "?"), 6)}${c.reset} ${trunc(String(m.subject || ""), Math.max(6, leftW - 14))}`,
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



/* ---------- bot inbox (dossier pane) ---------- */
function loadInboxMessages(_slug) {
  try {
    if (typeof listMessages === "function") {
      return listMessages({}) || [];
    }
  } catch {
    /* fall through */
  }
  try {
    const box = loadBox("inbox");
    return Array.isArray(box?.messages) ? box.messages : [];
  } catch {
    return [];
  }
}

function inboxKindColor(kind) {
  const k = String(kind || "").toLowerCase();
  if (k === "alert") return c.orange;
  if (k === "ask") return c.yellow;
  if (k === "report") return c.cyan;
  return c.dim;
}


function isPkmNote(msg) {
  const sub = String(msg?.subject || "");
  const body = String(msg?.body || "");
  const m1 = sub.match(/pkm:(delegated|submitted|reviewed)\b/i);
  if (m1) return m1[1].toLowerCase();
  const m2 = body.match(/\bevent:\s*(delegated|submitted|reviewed)\b/i);
  if (m2) return m2[1].toLowerCase();
  return null;
}

function buildInboxRows(messages, rightW) {
  const rows = ["__MID_INBOX__"];
  const msgs = Array.isArray(messages) ? messages : [];
  if (!msgs.length) {
    rows.push(`  ${c.dim}(inbox empty — gotchibot inbox send)${c.reset}`);
    return rows;
  }
  // newest first
  const sorted = [...msgs].sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
  const unread = sorted.filter((m) => !m.readAt).length;
  rows.push(
    `  ${c.dim}${msgs.length} msg${msgs.length === 1 ? "" : "s"}${c.reset}` +
      (unread ? ` · ${c.yellow}${unread} unread${c.reset}` : ` · ${c.dim}all read${c.reset}`),
  );
  const max = 5;
  for (const m of sorted.slice(0, max)) {
    const unreadMark = m.readAt ? " " : `${c.yellow}•${c.reset}`;
    const pkm = isPkmNote(m);
    const kind = pkm ? c.orange : inboxKindColor(m.kind);
    const kindLabel = pkm ? `pkm:${pkm}`.slice(0, 10) : String(m.kind || "?").slice(0, 6);
    const from = trunc(String(m.from || "?"), 10);
    const rawSubj = String(m.subject || m.body || "(no subject)").replace(/^pkm:(delegated|submitted|reviewed)\s*[—\-]\s*/i, "");
    const subj = trunc(rawSubj, Math.max(8, rightW - (pkm ? 34 : 28)));
    const when = tsShort(m.ts);
    rows.push(
      `  ${unreadMark}${kind}${padVis(kindLabel, 10)}${c.reset} ${c.dim}${from}${c.reset} ${subj} ${c.dim}${when}${c.reset}`,
    );
  }
  if (sorted.length > max) {
    rows.push(`  ${c.dim}(+${sorted.length - max} more)${c.reset}`);
  }
  return rows;
}

/** Full-width boxed panel between TEAM and Gotchis. */
function packFullWidthPanel(title, bodyRows, cols, maxH) {
  const innerW = Math.max(8, cols - 2);
  const budget = Math.max(3, maxH || 8);
  const inner = Math.max(1, budget - 2);
  const body = (bodyRows || []).slice(0, inner);
  while (body.length < Math.min(1, inner)) body.push("");
  const out = [boxTop(title, innerW)];
  for (const row of body) out.push(boxRow(row, innerW));
  while (out.length < budget - 1) out.push(boxRow("", innerW));
  if (out.length > budget - 1) out.length = budget - 1;
  out.push(boxBottom(innerW));
  return out.slice(0, budget);
}

/**
 * INBOX section (TEAM → Gotchis): richer scope — kind, from, subject, body preview.
 */
function buildInboxPanelBody(messages, cols) {
  const innerW = Math.max(20, cols - 4);
  const rows = [];
  const msgs = Array.isArray(messages) ? messages : [];
  if (!msgs.length) {
    rows.push(`  ${c.dim}(inbox empty — gotchibot inbox send)${c.reset}`);
    rows.push(`  ${c.dim}scope${c.reset} project bot mail · PKM notes · asks/reports`);
    return rows;
  }
  const sorted = [...msgs].sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
  const unread = sorted.filter((m) => !m.readAt).length;
  const nPkm = sorted.filter((m) => isPkmNote(m)).length;
  rows.push(
    `  ${c.gold}${msgs.length}${c.reset} msg${msgs.length === 1 ? "" : "s"}` +
      (unread ? ` · ${c.yellow}${unread} unread${c.reset}` : ` · ${c.dim}all read${c.reset}`) +
      (nPkm ? ` · ${c.orange}${nPkm} pkm${c.reset}` : "") +
      `  ${c.dim}scope: delegation / submit / review + fyi${c.reset}`,
  );
  const max = 6;
  for (const m of sorted.slice(0, max)) {
    const unreadMark = m.readAt ? " " : `${c.yellow}•${c.reset}`;
    const pkm = isPkmNote(m);
    const kind = pkm ? c.orange : inboxKindColor(m.kind);
    const kindLabel = pkm ? `pkm:${pkm}` : String(m.kind || "?");
    const from = trunc(String(m.from || "?"), 12);
    const to = m.to ? trunc(String(m.to), 10) : "";
    const rawSubj = String(m.subject || "(no subject)").replace(
      /^pkm:(delegated|submitted|reviewed)\s*[—\-]\s*/i,
      "",
    );
    const when = tsShort(m.ts);
    rows.push(
      `  ${unreadMark}${kind}${padVis(trunc(kindLabel, 12), 12)}${c.reset} ` +
        `${c.dim}${from}${c.reset}${to ? `${c.dim}→${to}${c.reset}` : ""} ` +
        `${trunc(rawSubj, Math.max(10, innerW - 36))} ${c.dim}${when}${c.reset}`,
    );
    const body = String(m.body || "")
      .replace(/\s+/g, " ")
      .trim();
    if (body) {
      const preview = body.replace(/^pkm:(delegated|submitted|reviewed)\s*[—\-]\s*/i, "");
      rows.push(`    ${c.dim}scope${c.reset} ${trunc(preview, Math.max(12, innerW - 10))}`);
    }
  }
  if (sorted.length > max) {
    rows.push(`  ${c.dim}(+${sorted.length - max} more — gotchibot inbox)${c.reset}`);
  }
  return rows;
}

/**
 * AI-CRON section under INBOX: schedule, means/name, status, last run + log scope.
 */
function buildAiCronPanelBody(agents, cols) {
  const innerW = Math.max(20, cols - 4);
  const rows = [];
  const list = Array.isArray(agents) ? agents : [];
  if (!list.length) {
    rows.push(`  ${c.dim}(no ai-cron-site jobs — SoT ~/.cron402/jobs.json)${c.reset}`);
    rows.push(`  ${c.dim}scope${c.reset} scheduled agents · last runs · credits`);
    return rows;
  }
  const active = list.filter((a) => String(a.status).toLowerCase() === "active").length;
  rows.push(
    `  ${c.gold}${list.length}${c.reset} job${list.length === 1 ? "" : "s"} · ` +
      `${c.green}${active} active${c.reset}` +
      `  ${c.dim}scope: cron402 SoT · schedule · lastRuns${c.reset}`,
  );
  const max = 5;
  for (const a of list.slice(0, max)) {
    const st = cronStatusColor(a.status);
    const sched = a.schedule || "—";
    const name = trunc(a.name || a.agentId || "—", Math.max(10, innerW - 34));
    const idShort = trunc(a.agentId || "—", 10);
    rows.push(
      `  ${st}${padVis(trunc(a.status || "?", 9), 9)}${c.reset} ` +
        `${c.dim}${padVis(idShort, 10)}${c.reset} ${c.cyan}${padVis(trunc(sched, 12), 12)}${c.reset} ${name}`,
    );
    const run = a.lastRuns?.[0];
    if (run) {
      const rs = cronStatusColor(run.status);
      const when = tsShort(run.startedAt || run.finishedAt);
      const snip = run.logSnippet ? trunc(String(run.logSnippet).replace(/\s+/g, " "), Math.max(8, innerW - 28)) : "";
      const dur = run.durationMs != null ? `${run.durationMs}ms` : "";
      rows.push(
        `    ${c.dim}last${c.reset} ${rs}${run.status}${c.reset} ${when}` +
          (dur ? ` ${c.dim}${dur}${c.reset}` : "") +
          (snip ? ` ${c.dim}${snip}${c.reset}` : ""),
      );
    } else {
      rows.push(`    ${c.dim}last — no runs yet${c.reset}`);
    }
    if (a.credits != null) {
      rows.push(`    ${c.dim}credits${c.reset} ${a.credits}`);
    }
  }
  if (list.length > max) {
    rows.push(`  ${c.dim}(+${list.length - max} more jobs)${c.reset}`);
  }
  return rows;
}


/** One TEAM op's portrait + ROLE/STATE/… + brief heads (no shared inbox/cron). */
function buildUnitDetailRows({
  slug,
  dossier,
  unit,
  roster,
  rightW,
  selected = false,
  useCover = false,
}) {
  const rows = [];
  if (!unit) return rows;

  const heroObj =
    unit?.hero && Array.isArray(roster)
      ? roster.find((h) => h.id === unit.hero) || { id: unit.hero }
      : null;
  let portrait = null;
  if (useCover) {
    const coverPath = resolveCoverImage(slug, dossier?.fields?.coverImage);
    if (coverPath) {
      portrait =
        renderCoverImage(coverPath, ART_W, ART_H) ||
        coverPlaceholderLines(coverPath, ART_W, ART_H);
    }
  }
  if (!portrait && heroObj) portrait = artForHero(heroObj);

  const kvW = 9;
  const kvCol = 14;
  const kvInner = Math.max(8, rightW - kvCol);
  const fleetHero =
    unit?.hero && Array.isArray(roster) ? roster.find((h) => h.id === unit.hero) : null;
  const fleetVal = fleetHero
    ? `${statusColor(fleetHero.status)}${statusShort(fleetHero.status)}${c.reset}`
    : "—";
  const stats = [
    [`ROLE`, unit.role || "—"],
    [`STATE`, `${unitStateColor(unit.state)}${unit.state || "planned"}${c.reset}`],
    [`HERO`, trunc(unit.hero || "—", Math.max(6, kvInner - 1))],
    [`SESSION`, sessionShort(unit.session)],
    [`BRIEF`, trunc(briefLabel(unit.brief), Math.max(6, kvInner - 1))],
    [`FLEET`, fleetVal],
  ];

  for (let i = 0; i < ART_H; i++) {
    let left;
    if (portrait && portrait[i] != null) left = padVis(portrait[i], 12);
    else left = padVis(i === Math.floor(ART_H / 2) ? `${c.dim}(no hero)${c.reset}` : "", 12);
    const kv = stats[i];
    const right = kv ? `${c.dim}${padVis(kv[0], kvW)}${c.reset}${kv[1]}` : "";
    rows.push(`${left}  ${right}`);
  }
  const sid = unit.hero ? shortId(unit.hero) : "";
  const under = sid
    ? `${c.dim}${padVis(
        (" ".repeat(Math.max(0, Math.floor((12 - visLen(sid)) / 2))) + sid).slice(0, 12),
        12,
      )}${c.reset}`
    : padVis("", 12);
  rows.push(`${under}  `);

  rows.push("__MID_MISSION__");
  const briefText = loadBrief(slug, unit);
  const heads = pickBriefHeads(briefText);
  if (heads.length) {
    for (const h of heads.slice(0, 4)) {
      rows.push(
        `  ${c.yellow}${h.head}${c.reset} ${trunc(h.text || "", Math.max(8, rightW - 14))}`,
      );
    }
  } else if (selected) {
    const goal = String(dossier?.fields?.goal || "").trim();
    if (goal) rows.push(`  ${c.yellow}GOAL${c.reset} ${trunc(goal, Math.max(8, rightW - 14))}`);
    else rows.push(`  ${c.dim}(no brief yet)${c.reset}`);
  } else {
    rows.push(`  ${c.dim}(no brief yet)${c.reset}`);
  }

  rows.push("__MID_ACCEPTANCE__");
  const acceptBrief = heads.find((h) => h.head.toUpperCase() === "ACCEPTANCE");
  if (acceptBrief?.text) {
    rows.push(`  ${trunc(acceptBrief.text, Math.max(8, rightW - 4))}`);
  } else if (selected) {
    const acceptField = String(dossier?.fields?.acceptance || "").trim();
    if (acceptField) {
      for (const line of acceptField
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 2)) {
        rows.push(`  ${trunc(line, Math.max(8, rightW - 4))}`);
      }
    } else {
      rows.push(`  ${c.dim}(no acceptance)${c.reset}`);
    }
  } else {
    rows.push(`  ${c.dim}(no acceptance)${c.reset}`);
  }

  return rows;
}

/**
 * PROGRAM / UNITS table / AI-CRON / INBOX — each a full mid-section for the DOSSIER scroll body.
 */
function buildDossierProgramSections({
  dossier,
  units = [],
  roster = [],
  rightW,
  cronAgents = [],
  inboxMessages = [],
  selIndex = 0,
}) {
  const rows = [];
  const kv = (label, value) => `  ${c.dim}${padVis(label, 10)}${c.reset}${value}`;
  const list = Array.isArray(units) ? units : [];

  rows.push("__MID_PROGRAM__");
  const playbook = trunc(String(dossier?.fields?.playbook || "—"), 16);
  const status = trunc(String(dossier?.status || "—"), 10);
  const host = trunc(String(dossier?.fields?.host || "—"), 10);
  rows.push(kv("playbook", `${playbook} · ${status} · ${host}`));
  rows.push(kv("updated", tsShort(dossier?.updatedAt)));
  const pmHero = String(dossier?.fields?.pmHero || "").trim();
  if (pmHero) {
    const pmH = (roster || []).find((h) => h.id === pmHero);
    const fleet = pmH
      ? `${statusColor(pmH.status)}${statusShort(pmH.status)}${c.reset}`
      : `${c.dim}—${c.reset}`;
    rows.push(
      kv(
        "pm",
        `${shortId(pmHero)} · ${trunc(String(dossier?.fields?.pmRole || "—"), 14)} · ${fleet}`,
      ),
    );
  } else {
    rows.push(kv("pm", `${c.dim}(unassigned)${c.reset}`));
  }
  const cover = String(dossier?.fields?.coverImage || "").trim();
  rows.push(
    kv(
      "cover",
      cover
        ? `${c.dim}${trunc(basename(cover), Math.max(8, rightW - 14))}${c.reset}`
        : `${c.dim}missing${c.reset}`,
    ),
  );
  const goal = String(dossier?.fields?.goal || "").trim();
  if (goal) {
    rows.push(kv("goal", trunc(goal, Math.max(10, rightW - 14))));
  }

  rows.push("__MID_UNITS__");
  const counts = countUnitStates(list);
  const pct = counts.total ? Math.round((counts.done / counts.total) * 100) : 0;
  rows.push(
    `  ${c.dim}total${c.reset} ${c.gold}${counts.total}${c.reset}` +
      ` ${c.dim}· plan${c.reset} ${c.gray}${counts.planned}${c.reset}` +
      ` ${c.dim}· run${c.reset} ${c.green}${counts.running}${c.reset}` +
      ` ${c.dim}· done${c.reset} ${c.white}${counts.done}${c.reset}` +
      ` ${c.dim}· fail${c.reset} ${c.yellow}${counts.failed}${c.reset}` +
      ` ${c.dim}·${c.reset} ${c.gold}${pct}%${c.reset}`,
  );
  if (!list.length) {
    rows.push(`  ${c.dim}(no units)${c.reset}`);
  } else {
    rows.push(
      `  ${c.dim}${padVis("id", 16)} ${padVis("role", 8)} ${padVis("state", 8)} ${padVis("hero", 12)} session${c.reset}`,
    );
    for (let i = 0; i < list.length; i++) {
      const u = list[i];
      const sel = i === selIndex;
      const marker = sel ? `${c.yellow}${c.bold}▸${c.reset}` : " ";
      const idBit = sel ? `${c.bold}${trunc(u.id, 15)}${c.reset}` : trunc(u.id, 15);
      const st = unitStateColor(u.state);
      rows.push(
        `  ${marker}${padVis(idBit, 15)} ${padVis(trunc(u.role || "—", 8), 8)} ` +
          `${st}${padVis(trunc(u.state || "planned", 8), 8)}${c.reset} ` +
          `${padVis(trunc(shortId(u.hero), 12), 12)} ${sessionShort(u.session)}`,
      );
    }
  }

  // INBOX + AI-CRON live as full-width panels between TEAM and Gotchis (not here).
  return rows;
}

/**
 * DOSSIER body: PROGRAM, UNITS, AI-CRON, INBOX each as their own scroll section,
 * then a full detail section per TEAM op. PROGRESS stays sticky at the bottom.
 * Returns { stickyRows: [], rows, sectionStarts }.
 */
function buildDossierContentRows({
  empty,
  slug,
  dossier,
  unit,
  units,
  roster,
  rightW,
  cronAgents = [],
  inboxMessages = [],
  selIndex = 0,
}) {
  if (empty) {
    return { stickyRows: [], rows: buildEmptyDetailLines(slug, rightW), sectionStarts: [] };
  }

  const list = Array.isArray(units) && units.length ? units : unit ? [unit] : [];
  const rows = [];
  const sectionStarts = [];

  // Own sections each — full tables, not a cramped sticky header.
  for (const r of buildDossierProgramSections({
    dossier,
    units: list,
    roster,
    rightW,
    cronAgents,
    inboxMessages,
    selIndex,
  })) {
    rows.push(r);
  }

  if (!list.length) {
    rows.push(`  ${c.dim}(no units — gotchibot pstack unit add)${c.reset}`);
  } else {
    for (let i = 0; i < list.length; i++) {
      const u = list[i];
      sectionStarts.push(countDossierExpanded(rows));
      const selected = i === selIndex;
      rows.push(`__MID_UNIT__:${u.id}:${selected ? "1" : "0"}`);
      for (const r of buildUnitDetailRows({
        slug,
        dossier,
        unit: u,
        roster,
        rightW,
        selected,
        useCover: selected,
      })) {
        rows.push(r);
      }
      if (i < list.length - 1) rows.push("");
    }
  }

  const counts = countUnitStates(list);
  const pct = counts.total ? Math.round((counts.done / counts.total) * 100) : 0;
  rows.push("__PROGRESS__");
  rows.push(
    `  ${c.gold}${c.bold}PROGRESS${c.reset} ${c.gold}${c.bold}${counts.done}${c.reset}/${c.gold}${c.bold}${counts.total}${c.reset} done · ${c.gold}${c.bold}${pct}%${c.reset}`,
  );
  return { stickyRows: [], rows, sectionStarts };
}

/** How many scrollable expanded rows `rows` produce (mirrors packDossierPanel scroll body). */
function countDossierExpanded(rows) {
  let n = 0;
  let takeProgress = false;
  for (const row of rows) {
    if (
      row === "__MID_MISSION__" ||
      row === "__MID_ACCEPTANCE__" ||
      row === "__MID_AI_CRON__" ||
      row === "__MID_INBOX__" ||
      row === "__MID_PROGRAM__" ||
      row === "__MID_UNITS__" ||
      (typeof row === "string" && row.startsWith("__MID_UNIT__:"))
    ) {
      n += 1;
    } else if (row === "__PROGRESS__") {
      takeProgress = true;
    } else if (takeProgress) {
      takeProgress = false;
    } else {
      n += 1;
    }
  }
  return n;
}

function expandDossierItem(row) {
  if (row === "__MID_MISSION__") return { mid: "MISSION" };
  if (row === "__MID_ACCEPTANCE__") return { mid: "ACCEPTANCE" };
  if (row === "__MID_AI_CRON__") return { mid: "AI-CRON" };
  if (row === "__MID_INBOX__") return { mid: "INBOX" };
  if (row === "__MID_PROGRAM__") return { mid: "PROGRAM" };
  if (row === "__MID_UNITS__") return { mid: "UNITS" };
  if (typeof row === "string" && row.startsWith("__MID_UNIT__:")) {
    const parts = row.split(":");
    const id = parts[1] || "unit";
    const selected = parts[2] === "1";
    return { mid: selected ? `▸ ${id}` : id, unitSel: selected };
  }
  return { text: row };
}

function packDossierPanel(
  contentRows,
  rightW,
  opsH,
  detailScroll,
  titleBase,
  sectionStarts = [],
  _stickyRows = [],
) {
  const innerH = Math.max(1, opsH - 2); // top+bottom borders
  const expanded = [];
  let progressRow = null;
  let takeProgress = false;
  for (const row of contentRows) {
    if (row === "__PROGRESS__") {
      takeProgress = true;
      continue;
    }
    if (takeProgress) {
      progressRow = { text: row };
      takeProgress = false;
      continue;
    }
    expanded.push(expandDossierItem(row));
  }

  // Only PROGRESS is sticky (bottom). PROGRAM / UNITS / AI-CRON / INBOX / ops all scroll.
  const stickyBottom = progressRow ? 1 : 0;
  const scrollH = Math.max(1, innerH - stickyBottom);
  const maxScroll = Math.max(0, expanded.length - scrollH);
  const ds = Math.min(Math.max(0, detailScroll || 0), maxScroll);
  const slice = expanded.slice(ds, ds + scrollH);
  while (slice.length < scrollH) slice.push({ text: "" });

  const title =
    maxScroll > 0 ? `${titleBase} · scroll ${ds}/${maxScroll}` : titleBase;
  const out = [boxTop(title, rightW)];
  // Body rows (mids + content + optional sticky PROGRESS + pad) share one scrollbar track.
  const bodyItems = [];
  for (const item of slice) bodyItems.push(item);
  if (progressRow) bodyItems.push({ text: progressRow.text });
  while (bodyItems.length < opsH - 2) bodyItems.push({ text: "" });
  if (bodyItems.length > opsH - 2) bodyItems.length = opsH - 2;
  const track = dossierScrollTrack(bodyItems.length, ds, maxScroll, scrollH);
  for (let i = 0; i < bodyItems.length; i++) {
    const item = bodyItems[i];
    const edge = track[i] || `${c.border}│${c.reset}`;
    if (item.mid) out.push(boxMidScroll(item.mid, rightW, edge));
    else out.push(boxRowScroll(item.text || "", rightW, edge));
  }
  out.push(boxBottom(rightW));
  return { lines: out, maxScroll, ds, sectionStarts };
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
  inboxMessages = [],
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
        inboxMessages: inboxMessages || [],
      });
  const opsLines = packOpsPanel(opsBody, leftW, opsH);

  const dossierBuilt = buildDossierContentRows({
    empty,
    slug,
    dossier,
    unit: selUnit,
    units: unitList,
    roster: roster || [],
    rightW,
    cronAgents: cronAgents || [],
    inboxMessages: inboxMessages || [],
    selIndex: sel || 0,
  });
  const nOps = (unitList || []).length;
  const titleBase =
    `DOSSIER · ${nOps ? `${nOps} ops` : unitId}` +
    (selUnit ? ` · ▸ ${selUnit.id}` : "") +
    (dossier?.fields?.pmHero ? ` · PM ${shortId(dossier.fields.pmHero)}` : "");
  // followSel (-1): snap scroll so the selected op's section is in view
  let dsIn = detailScroll;
  if (dsIn < 0 && dossierBuilt.sectionStarts?.length) {
    const start = dossierBuilt.sectionStarts[Math.min(sel || 0, dossierBuilt.sectionStarts.length - 1)] || 0;
    dsIn = start;
  }
  const dossierPacked = packDossierPanel(
    dossierBuilt.rows,
    rightW,
    opsH,
    dsIn < 0 ? 0 : dsIn,
    titleBase,
    dossierBuilt.sectionStarts,
    dossierBuilt.stickyRows || [],
  );
  lastDossierScroll = dossierPacked.ds;
  lastDossierMaxScroll = dossierPacked.maxScroll;

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

  // e) INBOX then AI-CRON — full-width sections between TEAM and Gotchis
  const afterPanelsTeam = 1 + panelRows + teamBudget;
  const remainForMidGrid = Math.max(4, rowsN - footerH - afterPanelsTeam);
  // Prefer ~half of mid band for inbox+cron, leave ≥3 rows for Gotchis header+art
  const midBand = Math.max(6, remainForMidGrid - 3);
  let inboxH = Math.min(12, Math.max(5, Math.floor(midBand * 0.5)));
  let cronH = Math.min(12, Math.max(5, midBand - inboxH));
  if (inboxH + cronH > midBand) {
    cronH = Math.max(4, midBand - inboxH);
  }
  const inboxBody = empty
    ? [`  ${c.dim}(no project)${c.reset}`]
    : buildInboxPanelBody(inboxMessages || [], cols);
  const cronBody = empty
    ? [`  ${c.dim}(no project)${c.reset}`]
    : buildAiCronPanelBody(cronAgents || [], cols);
  const inboxLines = packFullWidthPanel("INBOX", inboxBody, cols, inboxH);
  const cronLines = packFullWidthPanel("AI-CRON", cronBody, cols, cronH);
  for (const row of inboxLines) lines.push(pad(row, cols));
  for (const row of cronLines) lines.push(pad(row, cols));

  // f) GOTCHIS grid — fill remaining body, never eat footer
  const afterMid = afterPanelsTeam + inboxLines.length + cronLines.length;
  lastGridStartRow = afterMid;
  lastRows = rowsN;
  const gridBudget = Math.max(1, rowsN - footerH - afterMid);
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
      `${c.dim}j/k select op · h/l page · PgUp/PgDn (b/f) scroll dossier · TEAM→INBOX→AI-CRON→Gotchis · [c][o][u] · wheel · q${c.reset}`,
      cols,
    ),
  );
  // OVERALL first (always visible); leave path shortened (no ./scripts/).
  // At ≥72 cols allow 3-col overflow so the leave hint is not ellipsis-truncated.
  // Narrower panes: pad() keeps OVERALL and trims the leave tail.
  {
    const overall = `${c.gold}${c.bold}OVERALL ${pct}% done (${counts.done}/${counts.total})${c.reset}`;
    const mk = (k, label) =>
      `${c.bold}${c.cyan}[${c.reset}${c.bold}${k}${c.reset}${c.bold}${c.cyan}] ${label}${c.reset}`;
    const btnC = mk("c", "Cockpit");
    const btnO = mk("o", "Orch");
    const btnU = mk("u", "User");
    const gap = " ";
    const foot2 = `${overall}  ${btnC}${gap}${btnO}${gap}${btnU}`;
    let x = visLen(overall) + 2;
    const hits = [];
    for (const [key, btn] of [
      ["cockpit", btnC],
      ["orch", btnO],
      ["user", btnU],
    ]) {
      const w = visLen(btn);
      hits.push({ key, x0: x, x1: x + w, y: lines.length });
      x += w + visLen(gap);
    }
    lastCockpitBtn = hits;
    const n = visLen(foot2);
    if (n <= cols) lines.push(foot2 + " ".repeat(cols - n));
    else if (cols >= 72) lines.push(foot2);
    else lines.push(pad(foot2, cols));
  }

  process.stdout.write(`${ESC}[?25l${ESC}[H${ESC}[J`);
  process.stdout.write(lines.join("\n"));
}

/* ---------- state + watch ---------- */


function leavePstackTo(target) {
  const layout = join(ROOT, "scripts", "orchestrator-layout.sh");
  const cmd =
    target === "orch"
      ? "leave-pstack-orch"
      : target === "user"
        ? "leave-pstack-user"
        : "leave-pstack-cockpit";
  spawnSync("bash", [layout, cmd], {
    cwd: ROOT,
    env: process.env,
    stdio: "ignore",
  });
  process.exit(0);
}

/** Leave pstack dossier and reopen cockpit via leave-pstack-cockpit. */
function returnToCockpit() {
  leavePstackTo("cockpit");
}
function returnToOrch() {
  leavePstackTo("orch");
}
function returnToUser() {
  leavePstackTo("user");
}

function buildState() {
  const slug = currentSlug();
  const hasDossier = dossierExists(slug);
  const empty = !hasDossier;
  const dossier = hasDossier ? loadDossier(slug) : null;
  const cronAgents = loadCronAgents(slug, dossier);
  const inboxMessages = loadInboxMessages(slug);
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
    inboxMessages,
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
  let detailScroll = 0; // start at PROGRAM section; j/k jumps to selected op
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
      // Leave follow-sel; scroll from the last painted dossier offset.
      const base = detailScroll < 0 ? lastDossierScroll : detailScroll;
      detailScroll = Math.max(0, Math.min(lastDossierMaxScroll, base + delta));
      paint();
    };
    const handleCockpitClick = (mx, my) => {
      const hits = Array.isArray(lastCockpitBtn)
        ? lastCockpitBtn
        : lastCockpitBtn
          ? [{ ...lastCockpitBtn, key: "cockpit" }]
          : [];
      for (const hit of hits) {
        if (my !== hit.y) continue;
        if (mx < hit.x0 || mx >= hit.x1) continue;
        cleanup();
        if (hit.key === "orch") returnToOrch();
        else if (hit.key === "user") returnToUser();
        else returnToCockpit();
        return;
      }
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
        if (m[4] === "M") {
          if (btn === 0 || btn === 32) handleCockpitClick(mx, my);
          else handleWheel(btn, mx, my);
        }
      }
      // X10: ESC [ M btn x y  (each +32; x/y already 0-based)
      for (let i = 0; i + 6 <= s.length; i++) {
        if (s.slice(i, i + 3) !== "\x1b[M") continue;
        const btn = s.charCodeAt(i + 3) - 32;
        const mx = s.charCodeAt(i + 4) - 32;
        const my = s.charCodeAt(i + 5) - 32;
        if (btn === 0 || btn === 32) handleCockpitClick(mx, my);
        else handleWheel(btn, mx, my);
      }
    });
    process.stdin.on("keypress", (str, key) => {
      if (!key) return;
      if (key.ctrl && key.name === "c") {
        cleanup();
        process.exit(0);
      }
      if (key.name === "c" || key.name === "escape" || str === "c") {
        cleanup();
        returnToCockpit();
        return;
      }
      if (key.name === "o" || str === "o") {
        cleanup();
        returnToOrch();
        return;
      }
      if (key.name === "u" || str === "u") {
        cleanup();
        returnToUser();
        return;
      }
      if (key.name === "q") {
        cleanup();
        process.exit(0);
      }
      const n = (state.units || []).length;
      if (key.name === "j" || key.name === "down") {
        if (n) {
          sel = Math.min(n - 1, sel + 1);
          detailScroll = -1; // follow selected op section
          paint();
        }
      } else if (key.name === "k" || key.name === "up") {
        if (n) {
          sel = Math.max(0, sel - 1);
          detailScroll = -1;
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
      } else if (key.name === "pageup" || key.name === "b") {
        // b = back/scroll up (u is User nav)
        scrollDetail(-3);
      } else if (key.name === "pagedown" || key.name === "f") {
        // f = forward/scroll down
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
  pstack-window watch            # interactive when stdin is a tty (j/k select · h/l page · u/d scroll · c Cockpit · wheel · q quit); --interactive forces it
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
