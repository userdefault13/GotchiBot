#!/usr/bin/env node
/**
 * pstack-window — full TUI for the pstack dossier pane (tmux work.2, mode=pstack-dossier).
 *
 * Mock window (Julius):
 *   chat (work.1) | Details top-right (dossier/unit SoT) + gotchi thumb grid bottom-right
 *
 * Replaces pstack-pane.sh (text-only dossier dump) as the primary UI. The dossier
 * stays SoT: sessions/pstack/<slug>/dossier.json is read directly, units come from
 * units.tsv, and the hero grid comes from agent-focus list --json. Editing still
 * happens via CLI in the chat pane:
 *   ./scripts/gotchibot pstack dossier set <slug> <field> <value>
 *
 * Reuses gotchi-kanban.mjs pane patterns (pad/visLen/trunc, section headers,
 * scrollbar glyphs) and gotchi-art.mjs renderKanbanAscii for the thumb grid.
 *
 *   node scripts/pstack-window.mjs watch            (layout respawn target, non-interactive)
 *   node scripts/pstack-window.mjs once             single render (debug / capture)
 *   node scripts/pstack-window.mjs --interactive    minimal j/k select unit · q quit
 *
 * Watch refreshes on dossier.json / units.tsv mtime change, a roster tick every
 * GOTCHIBOT_PSTACK_ROSTER_S seconds, USR1 (layout signal_panes) and WINCH.
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import readline from "node:readline";
import { resolveHeroColors } from "./collateral-resolve.mjs";
import { renderKanbanAscii } from "./gotchi-art.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PSTACK_ROOT = join(ROOT, "sessions", "pstack");
const CURRENT = join(ROOT, "sessions", ".pstack-dossier-current");
const POLICY = join(ROOT, "config", "pstack-dossier-policy.json");

const WATCH_MS = Number(process.env.GOTCHIBOT_PSTACK_WATCH_MS || 3000);
const ROSTER_S = Number(process.env.GOTCHIBOT_PSTACK_ROSTER_S || 15);
const ART_W = 12; // gotchi-thumb.ascii width (large tombstone, not the 5-line mini)
const ART_H = 9; // gotchi-thumb.ascii height

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
};

const args = process.argv.slice(2);
const wantOnce = args.includes("--once") || args.includes("once");
const wantInteractive = args.includes("--interactive") || args.includes("--tui");
const isTty = Boolean(process.stdout.isTTY && process.stdin.isTTY);

/* ---------- tiny helpers (same shapes as gotchi-kanban.mjs) ---------- */

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

/** Pad/clip by visible width; never strip ANSI (wide colored thumb rows overflowed and went monochrome). */
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
    return d.toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }) + " PT";
  } catch {
    return "—";
  }
}

/* ---------- data sources ---------- */

function currentSlug() {
  let slug = "";
  try {
    slug = readFileSync(CURRENT, "utf8").trim();
  } catch {}
  if (!slug || !existsSync(join(PSTACK_ROOT, slug, "dossier.json"))) {
    try {
      slug =
        readdirSync(PSTACK_ROOT)
          .filter((n) => existsSync(join(PSTACK_ROOT, n, "dossier.json")))
          .sort()[0] || "";
    } catch {
      slug = "";
    }
  }
  return slug;
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
  const traits = Array.isArray(hero.traits) ? hero.traits : Array.isArray(hero.modifiedTraits) ? hero.modifiedTraits : null;
  const traitsKey = traits ? traits.join(",") : "";
  const key = `${hero.id}|${hero.collateral || ""}|${traitsKey}`;
  if (artCache.has(key)) return artCache.get(key);
  const colors = resolveHeroColors(
    { id: hero.id, collateral: hero.collateral, hauntId: hero.hauntId },
    hero.id,
  ) || null;
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

/** Compact hero id for grid labels: starter-dai-h1-2 → dai-h1-2, owned-22899 → 22899. */
function shortId(id) {
  const s = String(id || "");
  return s.replace(/^starter-/, "").replace(/^owned-/, "");
}

/* ---------- Details pane (top half) ---------- */

function workPlanLines(briefText, dossier, rightW) {
  const lines = [];
  const raw = String(briefText || "").trim();
  if (raw) {
    const picked = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^(GOAL|SCOPE|VERIFY|ACCEPTANCE|FORBIDDEN|TIMEBOX|REPORT)\b/i.test(l))
      .slice(0, 4);
    if (picked.length) {
      for (const p of picked) {
        const [head, ...rest] = p.split(/\s+/);
        lines.push(`  ${c.yellow}[•]${c.reset} ${c.bold}${head}${c.reset} ${trunc(rest.join(" "), Math.max(12, rightW - 12))}`);
      }
      return lines;
    }
    const first = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 5);
    for (const f of first) lines.push(`  ${c.yellow}[•]${c.reset} ${trunc(f, Math.max(12, rightW - 8))}`);
    return lines;
  }
  for (const field of ["units", "principles", "approaches"]) {
    const v = String(dossier?.fields?.[field] || "").trim();
    if (!v) continue;
    lines.push(`  ${c.yellow}[•]${c.reset} ${c.bold}${field}${c.reset} ${trunc(v, Math.max(12, rightW - 12))}`);
  }
  if (!lines.length) lines.push(`  ${c.dim}(no units/brief yet — add a unit or brief)${c.reset}`);
  return lines;
}

function buildDetailLines({ dossier, slug, units, selUnit, roster, rightW }) {
  const lines = [];
  const fields = dossier?.fields || {};

  lines.push(`${c.bold}OVERVIEW${c.reset}`);
  lines.push(`  Title    ${trunc(fields.title || "—", rightW - 12)}`);
  lines.push(`  Goal     ${trunc(fields.goal || "—", rightW - 12)}`);
  lines.push(
    `  Playbook ${trunc(fields.playbook || "—", Math.max(8, rightW - 24))} · status ${dossier?.status || "draft"}`,
  );
  lines.push(`  Slug     ${slug || "—"} · updated ${formatPt(dossier?.updatedAt)}`);

  lines.push(`${c.bold}ASSIGNMENT${c.reset}`);
  if (selUnit) {
    lines.push(`  Unit     ${selUnit.id} · ${selUnit.role || "—"} · ${selUnit.state || "planned"}`);
    lines.push(`  Hero     ${selUnit.hero || "—"}${selUnit.session ? ` · session ${selUnit.session}` : ""}`);
    lines.push(`  Brief    ${trunc(selUnit.brief || "—", Math.max(12, rightW - 12))}`);
  } else if (units.length) {
    lines.push(`  ${c.dim}(select a unit with j/k)${c.reset}`);
  } else {
    lines.push(`  ${c.dim}(no units — gotchibot pstack unit add ${slug || "<slug>"} --role worker)${c.reset}`);
  }

  lines.push(`${c.bold}RUNTIME${c.reset}`);
  const working = roster.filter((h) => ["working", "active"].includes(String(h.status || "").toLowerCase())).length;
  lines.push(`  Dossier  updated ${formatPt(dossier?.updatedAt)}`);
  lines.push(`  Roster   ${roster.length} heroes · ${working} working · refresh ${ROSTER_S}s · ${units.length} units`);

  lines.push(`${c.bold}WORK PLAN${c.reset}`);
  const brief = selUnit ? loadBrief(slug, selUnit) : "";
  lines.push(...workPlanLines(brief, dossier, rightW));

  lines.push(`${c.bold}ACTIONS${c.reset}`);
  lines.push(`  ${c.dim}edit:  ./scripts/gotchibot pstack dossier set ${slug || "<slug>"} <field> <value>${c.reset}`);
  lines.push(`  ${c.dim}leave: ./scripts/orchestrator-layout.sh leave-pstack-dossier · wheel scrolls${c.reset}`);
  return lines;
}

/* ---------- gotchi thumb grid (bottom half) ---------- */

function buildGridLines(heroes, innerW) {
  const out = [];
  if (!heroes.length) {
    out.push(`${c.dim}(no heroes on cartridge)${c.reset}`);
    return out;
  }
  const n = heroes.length;
  // Prefer 2 rows (mock: 2xN grid) when the pane is wide enough.
  let cols = Math.ceil(n / 2);
  if (cols * 14 > innerW) cols = Math.max(2, Math.floor(innerW / 14));
  const rows = Math.ceil(n / cols);
  const cellW = Math.max(12, Math.floor(innerW / cols));

  const { roles } = loadRoleCatalog();
  const cells = heroes.map((h) => {
    const art = artForHero(h) || [];
    const role = roles[h.id] || null;
    const roleTitle = role?.title || null;
    const task = h.agentTask || null;
    const label2 =
      roleTitle ||
      (task && task !== h.id ? task : null) ||
      (role ? h.id : null) ||
      "—";
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
    // 9 art lines (large thumb tombstone)
    for (let a = 0; a < ART_H; a++) {
      let line = "";
      for (const cell of rowCells) {
        line += padVis(cell.art[a] || "", cellW) + " ";
      }
      out.push(pad(line, innerW));
    }
    // 2 label lines
    for (let l = 0; l < 2; l++) {
      let line = "";
      for (const cell of rowCells) {
        line += padVis(l === 0 ? cell.label1 : cell.label2, cellW) + " ";
      }
      out.push(pad(line, innerW));
    }
  }
  return out;
}

/* ---------- render ---------- */

function render({ dossier, slug, units, selUnit, roster, term }) {
  const cols = Math.max(30, term.cols);
  const rowsN = Math.max(14, term.rows);
  const headerH = 1;
  const bodyH = rowsN - headerH;
  const detailsH = Math.max(8, Math.floor(bodyH * 0.6));
  const gridH = bodyH - detailsH;
  const rightW = cols - 1;

  const lines = [];
  const header = `${c.bold}pstack · dossier${c.reset} ${c.dim}| ${slug || "no program"} · ${dossier?.status || "—"} · ${formatPt(dossier?.updatedAt)}${c.reset}`;
  lines.push(pad(header, cols));

  const detailBody = buildDetailLines({ dossier, slug, units, selUnit, roster, rightW });
  const detailHeader = [
    `${c.cyan}Details${c.reset}`,
    c.border + "─".repeat(Math.max(8, rightW - 2)) + c.reset,
  ];
  const detailViewH = Math.max(1, detailsH - detailHeader.length);
  for (let y = 0; y < detailsH; y++) {
    if (y < detailHeader.length) lines.push(pad(detailHeader[y], cols));
    else {
      const dy = y - detailHeader.length;
      const line = detailBody[dy] || "";
      lines.push(pad(line, cols));
    }
  }

  const gridBody = buildGridLines(roster, rightW);
  const gridHeader = `${c.cyan}Gotchis${c.reset} ${c.dim}| 2xN grid · status + role · refresh ${ROSTER_S}s${c.reset}`;
  const gridViewH = Math.max(1, gridH - 1);
  lines.push(pad(gridHeader, cols));
  for (let y = 0; y < gridViewH; y++) {
    const line = gridBody[y] || "";
    lines.push(pad(line, cols));
  }

  process.stdout.write(`${ESC}[?25l${ESC}[H${ESC}[J`);
  process.stdout.write(lines.join("\n"));
  if (lines.length < rowsN) process.stdout.write("\n".repeat(rowsN - lines.length));
}

/* ---------- state + watch ---------- */

function buildState() {
  const slug = currentSlug();
  const dossier = loadDossier(slug);
  const units = loadUnits(slug);
  let roster = [];
  try {
    roster = fetchRoster();
  } catch (e) {
    roster = [];
  }
  return { slug, dossier, units, roster, at: new Date().toISOString() };
}

function fingerprint(state) {
  const slug = state.slug;
  let fp = `${slug}|${state.roster.length}|${state.at}`;
  if (slug) {
    try {
      fp += `|${statSync(join(PSTACK_ROOT, slug, "dossier.json")).mtimeMs}`;
    } catch {}
    try {
      fp += `|${statSync(join(PSTACK_ROOT, slug, "units.tsv")).mtimeMs}`;
    } catch {}
  }
  return fp;
}

function markSelf() {
  if (!process.env.TMUX || !process.env.TMUX_PANE) return;
  const { spawnSync: ss } = { spawnSync };
  ss("tmux", ["set-option", "-p", "-t", process.env.TMUX_PANE, "@gotchibot-pstack-dossier", "1"], { stdio: "ignore" });
  ss("tmux", ["set-option", "-p", "-t", process.env.TMUX_PANE, "pane-border-format", " pstack · dossier "], { stdio: "ignore" });
  ss("tmux", ["set-option", "-p", "-t", process.env.TMUX_PANE, "pane-scrollbars", "off"], { stdio: "ignore" });
}

function runWatch() {
  markSelf();
  let state = buildState();
  let sel = 0;
  let lastFp = fingerprint(state);
  let lastRosterTick = Date.now();
  const term = { cols: process.stdout.columns || 72, rows: process.stdout.rows || 40 };

  const paint = () => {
    const units = state.units || [];
    const selUnit = units.length ? units[Math.min(sel, units.length - 1)] : null;
    render({ ...state, selUnit, term });
  };

  const refresh = () => {
    state = buildState();
    if (state.units?.length) sel = Math.min(sel, state.units.length - 1);
    paint();
  };

  const onResize = () => {
    term.cols = process.stdout.columns || 72;
    term.rows = process.stdout.rows || 40;
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
        if (state.units?.length) sel = Math.min(sel, state.units.length - 1);
        paint();
      }
    } catch {}
  }, WATCH_MS);

  const cleanup = () => {
    clearInterval(timer);
    process.stdout.removeListener("resize", onResize);
    process.removeListener("SIGUSR1", onUsr1);
    process.stdout.write(`${ESC}[?25h${ESC}[0m\n`);
  };

  if (wantInteractive && isTty) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on("keypress", (str, key) => {
      if (!key) return;
      if ((key.ctrl && key.name === "c") || key.name === "q" || key.name === "escape") {
        cleanup();
        process.exit(0);
      }
      const units = state.units || [];
      if (!units.length) return;
      if (key.name === "j" || key.name === "down") {
        sel = Math.min(units.length - 1, sel + 1);
        paint();
      } else if (key.name === "k" || key.name === "up") {
        sel = Math.max(0, sel - 1);
        paint();
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
  const selUnit = state.units?.length ? state.units[0] : null;
  const term = { cols: process.stdout.columns || 72, rows: process.stdout.rows || 40 };
  render({ ...state, selUnit, term });
  process.stdout.write(`${ESC}[?25h${ESC}[0m\n`);
}

function usage() {
  console.log(`usage:
  pstack-window watch            # layout respawn target (non-interactive watch)
  pstack-window once             # single render (debug / capture)
  pstack-window --interactive    # minimal j/k select unit · q quit

SoT: sessions/pstack/<slug>/dossier.json · units: units.tsv · grid: agent-focus list`);
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
  if (args.includes("watch") || args.includes("--watch") || !args.length) {
    runWatch();
    return;
  }
  usage();
  process.exit(2);
}

main();