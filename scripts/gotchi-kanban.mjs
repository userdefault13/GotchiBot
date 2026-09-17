#!/usr/bin/env node
/**
 * GotchiBot Kanban — opencode-kanban-style 3-pane TUI for clawbot seats + tasks.
 *
 * Layout (like TomCC7/opencode-kanban):
 *   left  = Tasks by Category
 *   top-right = Details (overview / runtime / work plan)
 *   bottom-right = Logs
 *
 *   node scripts/gotchi-kanban.mjs                 # interactive TUI (tty)
 *   node scripts/gotchi-kanban.mjs --once          # plain dump (also non-tty default)
 *   node scripts/gotchi-kanban.mjs --json
 *   node scripts/gotchi-kanban.mjs --watch         # plain refresh loop
 *   node scripts/gotchi-kanban.mjs --interactive   # force TUI
 *
 * Seat cap = cartridge mint count. Chief = owned-954.
 */
import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import readline from "node:readline";
import { resolveHeroColors } from "./collateral-resolve.mjs";
import { renderKanbanAscii } from "./gotchi-art.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = join(ROOT, "sessions");
const ORCH_ID = "owned-954";
const WATCH_MS = Number(process.env.GOTCHIBOT_KANBAN_WATCH_MS || 5000);
const REFRESH_S = Math.max(0.5, WATCH_MS / 1000);
const KANBAN_ART_W = 12; // gotchi-thumb.ascii width (large tombstone, not the 5-line mini)

const args = process.argv.slice(2);
const wantJson = args.includes("--json");
const wantWatch = args.includes("--watch");
const wantOnce = args.includes("--once");
const forceTui = args.includes("--interactive") || args.includes("--tui") || args.includes("--menu");
const isTty = Boolean(process.stdout.isTTY && process.stdin.isTTY);

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
  bg: `${ESC}[48;5;236m`,
  sel: `${ESC}[48;5;238m`,
  border: `${ESC}[38;5;240m`,
};

const CATEGORIES = [
  { key: "todo", title: "TODO", match: (x) => x.column === "available" },
  { key: "progress", title: "IN PROGRESS", match: (x) => x.column === "working" || x.column === "chief" },
  { key: "assigned", title: "ASSIGNED", match: (x) => x.column === "assigned" },
  { key: "idle", title: "IDLE", match: (x) => x.column === "idle" },
  { key: "rework", title: "NEED REWORK", match: (x) => x.column === "rework" },
];

function loadOrchId() {
  try {
    const p = join(ROOT, "sessions", ".onboarding.json");
    if (!existsSync(p)) return ORCH_ID;
    const j = JSON.parse(readFileSync(p, "utf8"));
    return j.orchestratorHeroId || ORCH_ID;
  } catch {
    return ORCH_ID;
  }
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
  return JSON.parse((r.stdout || "").trim());
}

function trunc(s, n) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (!t) return "—";
  return t.length > n ? `${t.slice(0, Math.max(0, n - 1))}…` : t;
}

function normStatus(h) {
  return String(h.status || h.agentStatus || "available").toLowerCase();
}

function columnFor(hero, orchId) {
  const id = hero.id || hero.hero;
  if (id === orchId) return "chief";
  const st = normStatus(hero);
  if (st === "available") return "available";
  if (st === "working" || st === "active") return "working";
  if (st === "assigned" || st === "watching") return "assigned";
  if (st === "failed" || st === "error") return "rework";
  if (st === "idle" || st === "done") return "idle";
  if (hero.agentTask) return "assigned";
  return "available";
}

function readSessionLogs(sessionId, limit = 40) {
  if (!sessionId) return [];
  const dir = join(SESSIONS, sessionId);
  if (!existsSync(dir)) return [];
  const candidates = ["output.log", "output.md", "bootstrap.txt", "prompt.txt"];
  const lines = [];
  for (const name of candidates) {
    const p = join(dir, name);
    if (!existsSync(p)) continue;
    let text = "";
    try {
      text = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    const chunk = text.split(/\r?\n/).filter(Boolean).slice(-limit);
    for (const line of chunk) {
      lines.push({ source: name, text: line });
    }
    if (lines.length >= limit) break;
  }
  return lines.slice(-limit);
}

function recentFailedSessions(roster, limit = 8) {
  const numbered = Array.isArray(roster?.numbered) ? roster.numbered : [];
  return numbered
    .filter((e) => e.kind === "session" && String(e.status || "").toLowerCase() === "failed")
    .slice(0, limit)
    .map((e) => {
      const startedAt = parseSessionStarted(e.id, e.started || null);
      return {
        id: e.id,
        column: "rework",
        status: "failed",
        collateral: null,
        bindType: null,
        name: null,
        sessionId: e.id,
        task: e.model ? `failed session · ${e.model}` : "failed session",
        host: e.host || "local",
        isChief: false,
        kind: "session",
        hero: e.hero || null,
        model: e.model || null,
        started: startedAt ? startedAt.toISOString() : e.started || null,
        ageMs: startedAt ? Math.max(0, Date.now() - startedAt.getTime()) : null,
        ageLabel: formatAge(startedAt),
        stale: false,
        isCronRole: false,
        cronMapped: false,
        cronNeedsRole: false,
        cronHistory: null,
        cronStateLine: null,
        cronScheduleHint: null,
        role: null,
        roleTitle: null,
        roleSummary: null,
      };
    });
}

function workPlanFromTask(task) {
  const t = String(task || "").trim();
  if (!t || t === "—") return [];
  // Split on sentence-ish / numbered bits for a lightweight checklist view
  const parts = t
    .split(/(?<=[.!;])\s+|\s+——\s+|\s+\(\d\)\s+|;\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 8);
  if (parts.length <= 1) {
    return [{ text: trunc(t, 72), state: "active" }];
  }
  return parts.slice(0, 6).map((p, i) => ({
    text: trunc(p, 72),
    state: i === 0 ? "active" : "pending",
  }));
}


function readJsonSafe(path, fallback = null) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function loadRoleCatalog() {
  const roles = readJsonSafe(join(ROOT, "config/agent-roles.json"), {}) || {};
  const playbooks = readJsonSafe(join(ROOT, "config/agent-role-playbooks.json"), {}) || {};
  return { roles, playbooks };
}

/** Known cron/log sources keyed by role (cheap filesystem reads only). */
const CRON_LOG_SOURCES = {
  "infra-monitor": {
    dir: join(SESSIONS, "infra-logs"),
    pattern: /^infra-check-.*\.md$/i,
    statePath: join(ROOT, "var/infra-watch/state.json"),
    scheduleHint: "scheduled every ~900s · infra schedule (launchd supervise)",
  },
  "aarcade-comms-handler": {
    dir: join(SESSIONS, "comms-logs"),
    pattern: /^comms-.*\.md$/i,
    scheduleHint: "daily 23:50 PT · comms schedule",
  },
  "trader-desk": {
    dir: join(SESSIONS, "trader-logs"),
    pattern: /^cycle-.*\.md$/i,
    scheduleHint: "every ~1800s · trader schedule",
  },
};

function formatPtStamp(isoOrMs) {
  try {
    const d = new Date(isoOrMs);
    if (Number.isNaN(d.getTime())) return "—";
    const s = d.toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return `${s} PT`;
  } catch {
    return "—";
  }
}


function parseSessionStarted(sessionId, fallbackStarted) {
  if (fallbackStarted) {
    const d = new Date(fallbackStarted);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const m = String(sessionId || "").match(
    /^s(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/,
  );
  if (!m) return null;
  // Session ids use local wall-clock when minted.
  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  );
}

function formatAge(fromDate, now = new Date()) {
  if (!fromDate || Number.isNaN(fromDate.getTime())) return null;
  const ms = Math.max(0, now.getTime() - fromDate.getTime());
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h`;
  const days = Math.floor(hr / 24);
  return `${days}d`;
}

/** Treat task text as cron-ish even without agent-roles mapping. */
function isCronishTask(task) {
  return /\bcron\b|scheduleCmd|launchd|env-frustration|scheduled every|every\s*~\d+s/i.test(
    String(task || ""),
  );
}

/** Age threshold for "stale" assigned/working seats (ms). */
const STALE_MS = Number(process.env.GOTCHIBOT_KANBAN_STALE_MS || 2 * 24 * 60 * 60 * 1000);

function extractCronStatus(text, filename) {
  const raw = String(text || "");
  const overall = raw.match(/\*\*Overall:\*\*\s*(.+)/i);
  if (overall) return overall[1].replace(/\s+/g, " ").trim();
  const claude = raw.match(/^Claude:\s*(.+)$/im);
  if (claude) return claude[1].replace(/\s+/g, " ").trim();
  const h1 = raw.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].replace(/\s+/g, " ").trim();
  const first = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#") && !l.startsWith("API "));
  if (first) return first.replace(/\s+/g, " ").trim();
  return filename || "run";
}

function listCronHistory(src, limit = 8) {
  if (!src?.dir || !existsSync(src.dir)) return [];
  let names = [];
  try {
    names = readdirSync(src.dir);
  } catch {
    return [];
  }
  const files = names
    .filter((n) => src.pattern.test(n))
    .map((n) => {
      const p = join(src.dir, n);
      let mtime = 0;
      try {
        mtime = statSync(p).mtimeMs;
      } catch {
        mtime = 0;
      }
      return { name: n, path: p, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);

  return files.map((f) => {
    let status = f.name;
    try {
      const text = readFileSync(f.path, "utf8").slice(0, 2500);
      status = extractCronStatus(text, f.name);
    } catch {
      /* keep filename */
    }
    return {
      file: f.name,
      at: f.mtime ? new Date(f.mtime).toISOString() : null,
      status,
    };
  });
}

function readInfraWatchStateLine(statePath) {
  const s = readJsonSafe(statePath, null);
  if (!s || typeof s !== "object") return null;
  const failing = Array.isArray(s.failing) && s.failing.length ? s.failing.join(",") : "none";
  const age =
    s.updatedAt != null
      ? formatPtStamp(s.updatedAt)
      : "—";
  return `status ${s.status || "?"} · tick ${s.tick ?? "?"} · failing ${failing} · updated ${age}`;
}

/** Load cron history + optional state once per board refresh (not per keypress). */
function loadCronBundle(playbooks) {
  const out = {};
  for (const [role, src] of Object.entries(CRON_LOG_SOURCES)) {
    out[role] = {
      cron: true,
      history: listCronHistory(src, 8),
      stateLine: src.statePath ? readInfraWatchStateLine(src.statePath) : null,
      scheduleHint: src.scheduleHint || null,
    };
  }
  for (const [role, pb] of Object.entries(playbooks || {})) {
    if (!pb?.scheduleCmd) continue;
    if (out[role]) continue;
    out[role] = {
      cron: true,
      history: [],
      stateLine: null,
      scheduleHint: null,
    };
  }
  return out;
}

function buildBoard(roster, orchId) {
  const { roles, playbooks } = loadRoleCatalog();
  const cronByRole = loadCronBundle(playbooks);
  const numbered = Array.isArray(roster?.numbered) ? roster.numbered : [];
  const heroes = numbered.filter((e) => e.kind === "hero");
  const cards = heroes.map((h) => {
    const id = h.id || h.hero;
    const role = roles[id] || null;
    const pb = role ? playbooks[role] : null;
    const cron = role && cronByRole[role] ? cronByRole[role] : null;
    const task = h.agentTask || null;
    const sessionId = h.agentSessionId || null;
    const startedAt = parseSessionStarted(sessionId, h.started || null);
    const ageMs = startedAt ? Math.max(0, Date.now() - startedAt.getTime()) : null;
    const cronish = Boolean(cron?.cron) || isCronishTask(task);
    const stale =
      ageMs != null &&
      ageMs >= STALE_MS &&
      ["assigned", "working", "watching", "active"].includes(normStatus(h));
    return {
      id,
      column: columnFor({ ...h, id }, orchId),
      status: normStatus(h),
      collateral: h.collateral || null,
      bindType: h.bindType || null,
      name: h.name || null,
      traits: h.traits ?? h.modifiedTraits ?? null,
      sessionId,
      task,
      host: h.host || "cartridge",
      isChief: id === orchId,
      kind: "hero",
      hero: id,
      model: null,
      started: startedAt ? startedAt.toISOString() : null,
      role,
      roleTitle: pb?.title || null,
      roleSummary: pb?.summary || null,
      isCronRole: cronish,
      cronMapped: Boolean(cron?.cron),
      cronNeedsRole: cronish && !role,
      cronHistory: cron?.history || null,
      cronStateLine: cron?.stateLine || null,
      cronScheduleHint: cron?.scheduleHint || null,
      ageMs,
      ageLabel: formatAge(startedAt),
      stale,
    };
  });

  // Surface recent failed sessions under NEED REWORK (not seat cards)
  for (const fail of recentFailedSessions(roster)) cards.push(fail);

  const seatCards = cards.filter((c) => c.kind === "hero");
  const seatsTotal = seatCards.length;
  const seatsFree = seatCards.filter((c) => c.column === "available").length;
  const seatsUsed = seatsTotal - seatsFree;

  const categories = CATEGORIES.map((cat) => {
    const items = cards.filter(cat.match);
    return { ...cat, items, collapsed: false };
  });

  return {
    orchId,
    seatsTotal,
    seatsUsed,
    seatsFree,
    categories,
    cards,
    at: new Date().toISOString(),
  };
}

function flatSelectable(board, collapsedMap) {
  const rows = [];
  for (const cat of board.categories) {
    const collapsed = collapsedMap[cat.key] ?? false;
    rows.push({ type: "cat", key: cat.key, title: cat.title, count: cat.items.length, collapsed });
    if (!collapsed) {
      for (const item of cat.items) {
        rows.push({ type: "card", cat: cat.key, card: item });
      }
    }
  }
  return rows;
}

function selectedCard(rows, idx) {
  const row = rows[idx];
  if (!row) return null;
  if (row.type === "card") return row.card;
  // nearest card below, else above
  for (let i = idx + 1; i < rows.length; i++) if (rows[i].type === "card") return rows[i].card;
  for (let i = idx - 1; i >= 0; i--) if (rows[i].type === "card") return rows[i].card;
  return null;
}


function pad(str, width) {
  const s = String(str);
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "");
  if (visible.length >= width) return trunc(visible, width);
  return s + " ".repeat(width - visible.length);
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

const artCache = new Map();

function artForCard(card) {
  if (!card || card.kind === "session") return null;
  const traits = Array.isArray(card.traits) ? card.traits : null;
  const traitsKey = traits ? traits.join(",") : "";
  const key = `${card.id}|${card.collateral || ""}|${traitsKey}`;
  if (artCache.has(key)) return artCache.get(key);
  const colors =
    resolveHeroColors(
      {
        id: card.id,
        collateral: card.collateral,
        hauntId: card.hauntId,
      },
      card.id,
    ) || null;
  const art = renderKanbanAscii(colors, {
    useColor: true,
  });
  const lines = art.split("\n");
  artCache.set(key, lines);
  return lines;
}

function printPlain(board) {
  console.log("");
  console.log("GotchiBot Kanban — clawbot seats + tasks");
  console.log("─".repeat(72));
  console.log(
    `  seats  ${board.seatsUsed}/${board.seatsTotal} used · ${board.seatsFree} free · chief ${board.orchId}`,
  );
  console.log(`  as of  ${board.at}`);
  for (const cat of board.categories) {
    console.log("");
    console.log(`▸ ${cat.title} (${cat.items.length}/${cat.items.length})`);
    if (!cat.items.length) {
      console.log("    (empty)");
      continue;
    }
    for (const card of cat.items) {
      const label = card.isChief
        ? `${card.id}:CHIEF`
        : `${card.id}${card.collateral ? ":" + card.collateral : ""}`;
      console.log(`    • [${card.status}] ${label}`);
      console.log(`      ${trunc(card.task, 64)}`);
    }
  }
  console.log("");
}


/** Build full left-pane content; each entry tracks which selectable row it belongs to. */
function buildLeftContent(rows, sel, leftInnerW) {
  const out = [];
  out.push({ text: `${c.yellow}Tasks by Category${c.reset}`, row: -1 });
  out.push({ text: c.border + "─".repeat(Math.max(8, leftInnerW - 2)) + c.reset, row: -1 });
  let rowIdx = 0;
  for (const row of rows) {
    const selected = rowIdx === sel;
    const mark = selected ? `${c.sel}` : "";
    const end = selected ? c.reset : "";
    if (row.type === "cat") {
      const arrow = row.collapsed ? ">" : "v";
      const n = row.count;
      out.push({
        text: `${mark}${c.bold}${arrow} ${row.title} (${n}/${n})${c.reset}${end}`,
        row: rowIdx,
      });
    } else {
      const cardX = row.card;
      const prog =
        cardX.kind === "session"
          ? "failed"
          : cardX.isChief
            ? "chief"
            : cardX.status;
      const title = cardX.isChief
        ? `${cardX.id}:chief`
        : `${cardX.id}${cardX.collateral ? ":" + cardX.collateral : ""}`;
      const art = artForCard(cardX);
      const textW = Math.max(10, leftInnerW - (art ? KANBAN_ART_W + 2 : 0));
      const sideLabel =
        cardX.roleTitle ||
        (cardX.task && cardX.role && cardX.task === cardX.role
          ? cardX.role
          : null) ||
        cardX.task ||
        "—";
      const meta = [
        `${c.green}${trunc(`.: ${prog}`, 12)}${c.reset} ${trunc(title, Math.max(8, textW - 14))}`,
        `${c.dim}${trunc(sideLabel, Math.max(8, textW - 1))}${c.reset}`,
      ];
      if (art?.length) {
        const h = Math.max(art.length, meta.length);
        for (let i = 0; i < h; i++) {
          const thumb = padVis(art[i] || "", KANBAN_ART_W);
          const body = meta[i] || "";
          out.push({
            text: `${mark}${thumb} ${body}${end}`,
            row: rowIdx,
          });
        }
      } else {
        const boxW = Math.min(leftInnerW - 2, 34);
        out.push({ text: `${mark}┌${"─".repeat(boxW)}┐${end}`, row: rowIdx });
        out.push({
          text: `${mark}│ ${meta[0]}${end}`,
          row: rowIdx,
        });
        out.push({
          text: `${mark}│ ${meta[1]}${end}`,
          row: rowIdx,
        });
        out.push({ text: `${mark}└${"─".repeat(boxW)}┘${end}`, row: rowIdx });
      }
    }
    rowIdx++;
  }
  return out;
}

/** Vertical scrollbar: track ▒ + thumb █ for the visible window. */
function scrollBarGlyph(viewH, contentH, scrollTop, y) {
  if (contentH <= viewH) return `${c.dim}│${c.reset}`;
  const track = Math.max(1, viewH);
  const thumbH = Math.max(1, Math.round((viewH / contentH) * track));
  const maxScroll = Math.max(1, contentH - viewH);
  const thumbTop = Math.round((scrollTop / maxScroll) * (track - thumbH));
  if (y >= thumbTop && y < thumbTop + thumbH) return `${c.cyan}█${c.reset}`;
  return `${c.dim}▒${c.reset}`;
}

function clampScroll(scrollTop, contentH, viewH) {
  const max = Math.max(0, contentH - viewH);
  return Math.max(0, Math.min(max, scrollTop));
}

/** Keep the selected row's lines inside the left viewport. */
function ensureSelVisible(leftContent, sel, scrollTop, viewH) {
  const idxs = [];
  for (let i = 0; i < leftContent.length; i++) {
    if (leftContent[i].row === sel) idxs.push(i);
  }
  if (!idxs.length) return scrollTop;
  const first = idxs[0];
  const last = idxs[idxs.length - 1];
  let next = scrollTop;
  if (first < next) next = first;
  if (last >= next + viewH) next = last - viewH + 1;
  return clampScroll(next, leftContent.length, viewH);
}

function buildDetailLines(card, board, rightW) {
  const detailLines = [];
  if (!card) {
    detailLines.push(`${c.dim}(select a card)${c.reset}`);
    return detailLines;
  }
  const title =
    card.roleTitle ||
    (card.task && card.task !== card.role ? card.task : null) ||
    card.task ||
    card.id;
  detailLines.push(`${c.bold}OVERVIEW${c.reset}`);
  detailLines.push(`  Title    ${trunc(title, rightW - 12)}`);
  detailLines.push(`  Hero     ${card.id}${card.isChief ? " (CHIEF)" : ""}`);
  detailLines.push(
    `  Collateral ${card.collateral || "—"} · bind ${card.bindType || "—"} · host ${card.host}`,
  );
  detailLines.push("");
  detailLines.push(`${c.bold}ASSIGNMENT${c.reset}`);
  if (card.role) {
    detailLines.push(
      `  Role     ${card.role}${card.roleTitle ? ` — ${card.roleTitle}` : ""}`,
    );
  } else if (card.kind === "session") {
    detailLines.push(`  Role     ${c.dim}(session — no seat role)${c.reset}`);
  } else {
    detailLines.push(`  Role     ${c.dim}(none in agent-roles.json)${c.reset}`);
  }
  // Idle seats often store the role key as agentTask; still show standing assignment.
  const liveTask =
    card.task && card.role && card.task === card.role
      ? null
      : card.task;
  if (liveTask) {
    detailLines.push(`  Task     ${trunc(liveTask, rightW - 12)}`);
  } else if (card.role) {
    detailLines.push(`  Task     ${c.dim}(standing role; no live task)${c.reset}`);
  } else {
    detailLines.push(`  Task     ${trunc(card.task || "—", rightW - 12)}`);
  }
  if (card.roleSummary) {
    detailLines.push(`  ${c.dim}${trunc(card.roleSummary, Math.max(20, rightW - 4))}${c.reset}`);
  }
  detailLines.push("");
  detailLines.push(`${c.bold}RUNTIME${c.reset}`);
  const stColor = card.status === "working" || card.status === "active" ? c.green : c.white;
  const staleTag = card.stale
    ? ` ${c.yellow}stale · last activity ${card.ageLabel || "—"}${c.reset}`
    : card.ageLabel
      ? ` ${c.dim}· age ${card.ageLabel}${c.reset}`
      : "";
  detailLines.push(
    `  Status   ${stColor}${String(card.status).toUpperCase()}${c.reset}${staleTag}`,
  );
  detailLines.push(`  Seats    ${board.seatsUsed}/${board.seatsTotal} used · ${board.seatsFree} free`);
  detailLines.push(`  Session  ${card.sessionId || "—"}`);
  if (card.started) {
    detailLines.push(
      `  Started  ${formatPtStamp(card.started)}${card.ageLabel ? ` · age ${card.ageLabel}` : ""}`,
    );
  }
  if (card.model) detailLines.push(`  Model    ${card.model}`);
  detailLines.push("");
  detailLines.push(`${c.bold}WORK PLAN${c.reset}`);
  // Prefer live task text; standing role key alone is not a work plan.
  const planTask =
    card.task && card.role && card.task === card.role ? "" : card.task;
  const plan = workPlanFromTask(planTask);
  if (!plan.length) {
    detailLines.push(
      card.role
        ? `  ${c.dim}(standing ${card.role} — no live work plan)${c.reset}`
        : `  ${c.dim}(no task text)${c.reset}`,
    );
  }
  for (const step of plan) {
    const box =
      step.state === "done"
        ? `${c.green}[✓]${c.reset}`
        : step.state === "active"
          ? `${c.yellow}[•]${c.reset}`
          : "[ ]";
    detailLines.push(`  ${box} ${step.text}`);
  }
  if (card.isCronRole) {
    detailLines.push("");
    detailLines.push(`${c.bold}CRON HISTORY${c.reset}`);
    if (card.cronNeedsRole) {
      detailLines.push(
        `  ${c.yellow}cron-ish task · no role in agent-roles.json${c.reset}`,
      );
      detailLines.push(
        `  ${c.dim}map a role (+ playbook scheduleCmd) to load cron logs here${c.reset}`,
      );
    }
    if (card.cronScheduleHint) {
      detailLines.push(`  ${c.dim}${trunc(card.cronScheduleHint, Math.max(20, rightW - 4))}${c.reset}`);
    }
    if (card.cronStateLine) {
      detailLines.push(`  State    ${trunc(card.cronStateLine, rightW - 12)}`);
    }
    if (card.stale) {
      detailLines.push(
        `  ${c.yellow}stale · last activity ${formatPtStamp(card.started) || card.ageLabel || "—"}${c.reset}`,
      );
    }
    const hist = Array.isArray(card.cronHistory) ? card.cronHistory : [];
    if (!hist.length) {
      detailLines.push(
        card.cronMapped
          ? `  ${c.dim}(no recent cron logs)${c.reset}`
          : `  ${c.dim}(no cron logs — not a mapped cron role)${c.reset}`,
      );
    } else {
      for (const run of hist) {
        const when = formatPtStamp(run.at);
        detailLines.push(
          `  • ${when}  ${trunc(run.status || run.file || "run", Math.max(12, rightW - when.length - 6))}`,
        );
      }
    }
  } else if (card.stale) {
    detailLines.push("");
    detailLines.push(`${c.bold}ACTIVITY${c.reset}`);
    detailLines.push(
      `  ${c.yellow}stale · last activity ${formatPtStamp(card.started) || card.ageLabel || "—"}${c.reset}`,
    );
  }
  detailLines.push("");
  detailLines.push(`${c.bold}ACTIONS${c.reset}`);
  detailLines.push(
    `  ${c.dim}Enter: open this agent's chat · PgUp/PgDn · q${c.reset}`,
  );
  return detailLines;
}

function drawTui(state) {
  const {
    board,
    rows,
    sel,
    focusPane,
    term,
    scrollTop,
    detailScroll,
    logScroll,
    statusMsg = "",
  } = state;
  const cols = term.cols;
  const rowsN = Math.max(24, term.rows);
  const scrollCol = 1; // vertical bar width inside left pane
  const leftW = Math.max(28, Math.floor(cols * 0.34));
  const leftInnerW = Math.max(12, leftW - scrollCol);
  const rightW = cols - leftW - 1;
  const headerH = 1;
  const footerH = 1;
  const bodyH = rowsN - headerH - footerH;
  const detailsH = Math.max(10, Math.floor(bodyH * 0.55));
  const logsH = bodyH - detailsH;
  const listViewH = Math.max(1, bodyH - 0); // full left body is the list viewport

  const lines = [];
  const statusBit = statusMsg
    ? `${c.yellow} ${trunc(statusMsg, Math.max(12, cols - 56))}${c.reset}`
    : "";
  const rightMeta = `${c.dim}seats: ${board.seatsUsed}/${board.seatsTotal}  refresh: ${REFRESH_S}s${c.reset}`;
  const headerLeft = `${c.bold}gotchibot-kanban${c.reset}${statusBit}`;
  const gap = Math.max(1, cols - visLen(headerLeft) - visLen(rightMeta));
  const header = `${headerLeft}${" ".repeat(gap)}${rightMeta}`;
  lines.push(pad(header, cols));

  const card = selectedCard(rows, sel);
  const leftContent = buildLeftContent(rows, sel, leftInnerW);
  let st = ensureSelVisible(leftContent, sel, scrollTop, listViewH);
  st = clampScroll(st, leftContent.length, listViewH);
  state.scrollTop = st; // write-back so callers keep sync

  const detailBody = buildDetailLines(card, board, rightW);
  const detailHeader = [
    `${focusPane === "details" ? c.cyan : c.yellow}Details${c.reset}`,
    c.border + "─".repeat(Math.max(8, rightW - 2)) + c.reset,
  ];
  const detailViewH = Math.max(1, detailsH - detailHeader.length);
  let dScroll = clampScroll(detailScroll, detailBody.length, detailViewH);
  state.detailScroll = dScroll;

  const rawLogs = readSessionLogs(card?.sessionId, 200);
  const logBody = [];
  if (!rawLogs.length) {
    logBody.push(`${c.dim}(no session logs yet)${c.reset}`);
  } else {
    rawLogs
      .slice()
      .reverse()
      .forEach((L, i) => {
        const prefix = i === 0 ? `${c.cyan}▶${c.reset}` : " ";
        logBody.push(
          `${prefix} ${c.cyan}[${L.source}]${c.reset} ${c.dim}${trunc(L.text, rightW - 18)}${c.reset}`,
        );
      });
  }
  const logHeader = [
    `${focusPane === "logs" ? c.cyan : c.yellow}Logs${c.reset} ${c.dim}| session output | e toggle${c.reset}`,
    c.border + "─".repeat(Math.max(8, rightW - 2)) + c.reset,
  ];
  const logViewH = Math.max(1, logsH - logHeader.length);
  let lScroll = clampScroll(logScroll, logBody.length, logViewH);
  state.logScroll = lScroll;

  for (let y = 0; y < bodyH; y++) {
    const contentIdx = st + y;
    const entry = leftContent[contentIdx];
    const leftText = entry ? entry.text : "";
    const bar = scrollBarGlyph(listViewH, leftContent.length, st, y);
    const L = pad(leftText, leftInnerW) + bar;

    let R = "";
    if (y < detailsH) {
      if (y < detailHeader.length) R = pad(detailHeader[y], rightW);
      else {
        const dy = y - detailHeader.length;
        const barR = scrollBarGlyph(detailViewH, detailBody.length, dScroll, dy);
        const line = detailBody[dScroll + dy] || "";
        R = pad(line, Math.max(0, rightW - 1)) + (detailBody.length > detailViewH ? barR : " ");
      }
    } else {
      const ly = y - detailsH;
      if (ly < logHeader.length) R = pad(logHeader[ly], rightW);
      else {
        const dy = ly - logHeader.length;
        const barR = scrollBarGlyph(logViewH, logBody.length, lScroll, dy);
        const line = logBody[lScroll + dy] || "";
        R = pad(line, Math.max(0, rightW - 1)) + (logBody.length > logViewH ? barR : " ");
      }
    }
    lines.push(`${L}${c.border}│${c.reset}${R}`);
  }

  const footerStatus = statusMsg
    ? `${c.yellow}${trunc(statusMsg, Math.max(10, cols - 72))}${c.reset}  `
    : "";
  const footer = `${footerStatus}${c.dim}j/k:select  PgUp/PgDn:scroll  Space:collapse  Tab:pane  Enter:open chat  r:reload  q:quit${c.reset}`;
  lines.push(pad(footer, cols));

  process.stdout.write(`${ESC}[?25l${ESC}[H${ESC}[J`);
  process.stdout.write(lines.join("\n"));
  if (lines.length < rowsN) process.stdout.write("\n".repeat(rowsN - lines.length));
}

const STATUS_TTL_MS = Number(process.env.GOTCHIBOT_KANBAN_STATUS_MS || 4500);

function sessionDirPath(sessionId) {
  if (!sessionId) return null;
  return join(SESSIONS, sessionId);
}

function sessionDirExists(sessionId) {
  const dir = sessionDirPath(sessionId);
  return Boolean(dir && existsSync(dir));
}

/** Open Finder to sessions/<id> when present. Never silent about missing dirs. */
function openSessionDir(sessionId) {
  if (!sessionId) return { ok: false, reason: "no-id" };
  const dir = sessionDirPath(sessionId);
  if (!existsSync(dir)) return { ok: false, reason: "missing", dir };
  try {
    const child = spawn("open", [dir], { stdio: "ignore", detached: true });
    child.unref();
    return { ok: true, dir };
  } catch (e) {
    return { ok: false, reason: String(e.message || e), dir };
  }
}

/**
 * Focus/switch avatar+chat into a hero seat (like /switch). Non-blocking so the
 * TUI does not hang while agent-focus refreshes roster / OpenClaw.
 */
function focusHeroSeat(heroId, { onDone } = {}) {
  const child = spawn(
    process.execPath,
    [join(ROOT, "scripts/agent-focus.mjs"), "switch", String(heroId)],
    {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let err = "";
  child.stderr?.on("data", (buf) => {
    err += String(buf);
  });
  child.on("close", (code) => {
    if (typeof onDone === "function") {
      onDone({
        code: code ?? 1,
        err: err.trim().split("\n").filter(Boolean).slice(-1)[0] || "",
      });
    }
  });
  child.on("error", (e) => {
    if (typeof onDone === "function") {
      onDone({ code: 1, err: String(e.message || e) });
    }
  });
  return child;
}

function enterCardAction(card, { setStatus, onFocusDone } = {}) {
  if (!card) {
    setStatus?.("no card selected");
    return;
  }
  if (card.kind === "hero") {
    const heroId = card.id || card.hero;
    if (!heroId) {
      setStatus?.("no hero id on card");
      return;
    }
    setStatus?.(`focusing → ${heroId}…`);
    focusHeroSeat(heroId, {
      onDone: ({ code, err }) => {
        if (code === 0) {
          const sess = card.sessionId;
          if (sess && sessionDirExists(sess)) {
            openSessionDir(sess);
            setStatus?.(`switched → ${heroId} · opened session`);
          } else if (sess) {
            setStatus?.(`no session dir · focusing hero ${heroId}`);
          } else {
            setStatus?.(`switched → ${heroId}`);
          }
        } else {
          setStatus?.(
            `focus failed · ${heroId}${err ? " · " + trunc(err, 40) : ""}`,
          );
        }
        onFocusDone?.();
      },
    });
    // Open session dir immediately when present (don't wait for switch).
    if (card.sessionId && sessionDirExists(card.sessionId)) {
      openSessionDir(card.sessionId);
    }
    return;
  }

  // Failed-session (or other) cards: open dir if present, else status.
  if (!card.sessionId) {
    setStatus?.("no sessionId on card");
    return;
  }
  const opened = openSessionDir(card.sessionId);
  if (opened.ok) setStatus?.(`opened ${card.sessionId}`);
  else setStatus?.(`no session dir · ${card.sessionId}`);
}

async function runTui() {
  const orchId = loadOrchId();
  let collapsed = {};
  let sel = 1;
  let focusPane = "list"; // list | details | logs
  let scrollTop = 0;
  let detailScroll = 0;
  let logScroll = 0;
  let statusMsg = "";
  let statusUntil = 0;
  let board = buildBoard(fetchRoster(), orchId);
  let rows = flatSelectable(board, collapsed);

  const setStatus = (msg, ttl = STATUS_TTL_MS) => {
    statusMsg = String(msg || "");
    statusUntil = Date.now() + ttl;
  };
  const currentStatus = () => {
    if (!statusMsg) return "";
    if (Date.now() > statusUntil) {
      statusMsg = "";
      return "";
    }
    return statusMsg;
  };

  const firstCard = rows.findIndex((r) => r.type === "card");
  if (firstCard >= 0) sel = firstCard;

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  const term = {
    cols: process.stdout.columns || 100,
    rows: process.stdout.rows || 40,
  };

  const paint = () => {
    const state = {
      board,
      rows,
      sel,
      collapsed,
      focusPane,
      term,
      scrollTop,
      detailScroll,
      logScroll,
      statusMsg: currentStatus(),
    };
    drawTui(state);
    scrollTop = state.scrollTop;
    detailScroll = state.detailScroll;
    logScroll = state.logScroll;
  };

  const page = () => Math.max(5, Math.floor(((term.rows || 40) - 2) * 0.4));

  const redraw = () => {
    board = buildBoard(fetchRoster(), orchId);
    rows = flatSelectable(board, collapsed);
    if (sel >= rows.length) sel = Math.max(0, rows.length - 1);
    paint();
  };

  const onResize = () => {
    term.cols = process.stdout.columns || 100;
    term.rows = process.stdout.rows || 40;
    paint();
  };
  process.stdout.on("resize", onResize);

  let timer = setInterval(() => {
    try {
      redraw();
    } catch {
      /* keep UI up */
    }
  }, WATCH_MS);

  const cleanup = () => {
    clearInterval(timer);
    process.stdout.write(`${ESC}[?25h${ESC}[0m\n`);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.removeAllListeners("keypress");
    process.stdout.removeListener("resize", onResize);
  };

  redraw();

  await new Promise((resolve) => {
    process.stdin.on("keypress", (str, key) => {
      if (!key) return;
      if ((key.ctrl && key.name === "c") || key.name === "q" || key.name === "escape") {
        cleanup();
        resolve();
        return;
      }
      if (key.name === "r") {
        try {
          redraw();
        } catch (e) {
          cleanup();
          console.error(e.message || e);
          resolve();
        }
        return;
      }
      if (key.name === "tab") {
        focusPane = focusPane === "list" ? "details" : focusPane === "details" ? "logs" : "list";
        paint();
        return;
      }

      // Page scroll — focused pane
      if (key.name === "pageup" || (key.ctrl && key.name === "u")) {
        if (focusPane === "details") detailScroll = Math.max(0, detailScroll - page());
        else if (focusPane === "logs") logScroll = Math.max(0, logScroll - page());
        else {
          sel = Math.max(0, sel - page());
        }
        paint();
        return;
      }
      if (key.name === "pagedown" || (key.ctrl && key.name === "d")) {
        if (focusPane === "details") detailScroll += page();
        else if (focusPane === "logs") logScroll += page();
        else {
          sel = Math.min(rows.length - 1, sel + page());
        }
        paint();
        return;
      }

      if (key.name === "j" || key.name === "down") {
        if (focusPane === "details") detailScroll += 1;
        else if (focusPane === "logs") logScroll += 1;
        else sel = Math.min(rows.length - 1, sel + 1);
        paint();
        return;
      }
      if (key.name === "k" || key.name === "up") {
        if (focusPane === "details") detailScroll = Math.max(0, detailScroll - 1);
        else if (focusPane === "logs") logScroll = Math.max(0, logScroll - 1);
        else sel = Math.max(0, sel - 1);
        paint();
        return;
      }
      if (str === " " || key.name === "space") {
        const row = rows[sel];
        if (row?.type === "cat") {
          collapsed[row.key] = !collapsed[row.key];
          rows = flatSelectable(board, collapsed);
          paint();
        } else if (row?.type === "card") {
          collapsed[row.cat] = true;
          rows = flatSelectable(board, collapsed);
          sel = Math.max(
            0,
            rows.findIndex((r) => r.type === "cat" && r.key === row.cat),
          );
          paint();
        }
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        const card = selectedCard(rows, sel);
        // Hero seat → leave kanban and open that agent's chat (switch + respawn pane).
        if (card?.kind === "hero") {
          const heroId = card.id || card.hero;
          if (!heroId) {
            setStatus("no hero id on card");
            paint();
            return;
          }
          setStatus(`opening chat → ${heroId}…`);
          paint();
          cleanup();
          const r = spawnSync(
            process.execPath,
            [join(ROOT, "scripts/agent-focus.mjs"), "switch", String(heroId), "--respawn"],
            { cwd: ROOT, stdio: "inherit", env: process.env },
          );
          // 10 = opened a seat chat (cockpit should not keep looping the menu)
          process.exit(r.status === 0 ? 10 : r.status ?? 1);
        }
        enterCardAction(card, {
          setStatus,
          onFocusDone: () => {
            try {
              paint();
            } catch {
              /* ignore */
            }
          },
        });
        paint();
        return;
      }
      if (str === "e") {
        focusPane = focusPane === "logs" ? "details" : "logs";
        paint();
      }
    });
  });
}

async function main() {
  const orchId = loadOrchId();
  const load = () => buildBoard(fetchRoster(), orchId);

  if (wantJson && !wantWatch) {
    console.log(JSON.stringify(load(), null, 2));
    return;
  }

  if (wantWatch) {
    for (;;) {
      try {
        process.stdout.write("\x1bc");
        const board = load();
        if (wantJson) console.log(JSON.stringify(board, null, 2));
        else printPlain(board);
        console.log(`  watching — refresh ${WATCH_MS}ms · Ctrl+C to stop`);
      } catch (e) {
        console.error(String(e.message || e));
      }
      await new Promise((r) => setTimeout(r, WATCH_MS));
    }
  }

  if (wantOnce || (!isTty && !forceTui)) {
    printPlain(load());
    return;
  }

  // Default on tty: interactive 3-pane TUI.
  // If --tui was forced but stdout is piped (cockpit runAbraNode), do NOT hang.
  if (forceTui && !isTty) {
    console.error("kanban: no tty for TUI — printing plain board (--once)");
    printPlain(load());
    return;
  }
  await runTui();
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
