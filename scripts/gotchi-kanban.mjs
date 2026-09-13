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
import { spawnSync } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import readline from "node:readline";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = join(ROOT, "sessions");
const ORCH_ID = "owned-954";
const WATCH_MS = Number(process.env.GOTCHIBOT_KANBAN_WATCH_MS || 5000);
const REFRESH_S = Math.max(0.5, WATCH_MS / 1000);

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
    .map((e) => ({
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
      started: e.started || null,
    }));
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

function buildBoard(roster, orchId) {
  const numbered = Array.isArray(roster?.numbered) ? roster.numbered : [];
  const heroes = numbered.filter((e) => e.kind === "hero");
  const cards = heroes.map((h) => {
    const id = h.id || h.hero;
    return {
      id,
      column: columnFor({ ...h, id }, orchId),
      status: normStatus(h),
      collateral: h.collateral || null,
      bindType: h.bindType || null,
      name: h.name || null,
      sessionId: h.agentSessionId || null,
      task: h.agentTask || null,
      host: h.host || "cartridge",
      isChief: id === orchId,
      kind: "hero",
      hero: id,
      model: null,
      started: null,
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

function boxLine(width, left, fill = "─", right) {
  const inner = Math.max(0, width - 2);
  return `${left}${fill.repeat(inner)}${right}`;
}

function pad(str, width) {
  const s = String(str);
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "");
  if (visible.length >= width) return trunc(visible, width);
  return s + " ".repeat(width - visible.length);
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

function drawTui(state) {
  const { board, rows, sel, collapsed, focusPane, term } = state;
  const cols = term.cols;
  const rowsN = Math.max(24, term.rows);
  const leftW = Math.max(28, Math.floor(cols * 0.34));
  const rightW = cols - leftW - 1;
  const headerH = 1;
  const footerH = 1;
  const bodyH = rowsN - headerH - footerH;
  const detailsH = Math.max(10, Math.floor(bodyH * 0.55));
  const logsH = bodyH - detailsH;

  const lines = [];
  const header =
    `${c.bold}gotchibot-kanban${c.reset}` +
    " ".repeat(Math.max(1, cols - 40)) +
    `${c.dim}seats: ${board.seatsUsed}/${board.seatsTotal}  refresh: ${REFRESH_S}s${c.reset}`;
  lines.push(pad(header, cols));

  const card = selectedCard(rows, sel);
  const logs = readSessionLogs(card?.sessionId, logsH - 3);

  // Build left column lines
  const leftLines = [];
  leftLines.push(`${c.yellow}Tasks by Category${c.reset}`);
  leftLines.push(c.border + "─".repeat(Math.max(8, leftW - 2)) + c.reset);
  let rowIdx = 0;
  for (const row of rows) {
    const selected = rowIdx === sel;
    const mark = selected ? `${c.sel}` : "";
    const end = selected ? c.reset : "";
    if (row.type === "cat") {
      const arrow = row.collapsed ? ">" : "v";
      const n = row.count;
      leftLines.push(
        `${mark}${c.bold}${arrow} ${row.title} (${n}/${n})${c.reset}${end}`,
      );
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
      leftLines.push(`${mark}┌${"─".repeat(Math.min(leftW - 4, 34))}┐${end}`);
      leftLines.push(
        `${mark}│ ${c.green}${trunc(`.: ${prog}`, 12)}${c.reset} ${trunc(title, Math.min(leftW - 18, 22))}${end}`,
      );
      leftLines.push(
        `${mark}│ ${c.dim}${trunc(cardX.task || "—", Math.min(leftW - 6, 32))}${c.reset}${end}`,
      );
      leftLines.push(`${mark}└${"─".repeat(Math.min(leftW - 4, 34))}┘${end}`);
    }
    rowIdx++;
  }
  while (leftLines.length < bodyH) leftLines.push("");

  // Details pane
  const detailLines = [];
  const dFocus = focusPane === "details" ? c.cyan : c.yellow;
  detailLines.push(`${dFocus}Details${c.reset}`);
  detailLines.push(c.border + "─".repeat(Math.max(8, rightW - 2)) + c.reset);
  if (!card) {
    detailLines.push(`${c.dim}(select a card)${c.reset}`);
  } else {
    detailLines.push(`${c.bold}OVERVIEW${c.reset}`);
    detailLines.push(`  Title    ${trunc(card.task || card.id, rightW - 12)}`);
    detailLines.push(`  Hero     ${card.id}${card.isChief ? " (CHIEF)" : ""}`);
    detailLines.push(
      `  Collateral ${card.collateral || "—"} · bind ${card.bindType || "—"} · host ${card.host}`,
    );
    detailLines.push("");
    detailLines.push(`${c.bold}RUNTIME${c.reset}`);
    const stColor = card.status === "working" || card.status === "active" ? c.green : c.white;
    detailLines.push(`  Status   ${stColor}${String(card.status).toUpperCase()}${c.reset}`);
    detailLines.push(`  Seats    ${board.seatsUsed}/${board.seatsTotal} used · ${board.seatsFree} free`);
    detailLines.push(`  Session  ${card.sessionId || "—"}`);
    if (card.model) detailLines.push(`  Model    ${card.model}`);
    detailLines.push("");
    detailLines.push(`${c.bold}WORK PLAN${c.reset}`);
    const plan = workPlanFromTask(card.task);
    if (!plan.length) detailLines.push(`  ${c.dim}(no task text)${c.reset}`);
    for (const step of plan) {
      const box = step.state === "done" ? `${c.green}[✓]${c.reset}` : step.state === "active" ? `${c.yellow}[•]${c.reset}` : "[ ]";
      detailLines.push(`  ${box} ${step.text}`);
    }
    detailLines.push("");
    detailLines.push(`${c.bold}ACTIONS${c.reset}`);
    detailLines.push(`  ${c.dim}Enter open session dir · r reload · q quit${c.reset}`);
  }
  while (detailLines.length < detailsH) detailLines.push("");

  // Logs pane
  const logLines = [];
  const lFocus = focusPane === "logs" ? c.cyan : c.yellow;
  logLines.push(`${lFocus}Logs${c.reset} ${c.dim}| session output | e toggle${c.reset}`);
  logLines.push(c.border + "─".repeat(Math.max(8, rightW - 2)) + c.reset);
  if (!logs.length) {
    logLines.push(`${c.dim}(no session logs yet)${c.reset}`);
  } else {
    logs
      .slice()
      .reverse()
      .forEach((L, i) => {
        const prefix = i === 0 ? `${c.cyan}▶${c.reset}` : " ";
        logLines.push(`${prefix} ${c.cyan}[${L.source}]${c.reset} ${c.dim}${trunc(L.text, rightW - 16)}${c.reset}`);
      });
  }
  while (logLines.length < logsH) logLines.push("");

  for (let y = 0; y < bodyH; y++) {
    const L = pad(leftLines[y] || "", leftW);
    let R = "";
    if (y < detailsH) R = pad(detailLines[y] || "", rightW);
    else R = pad(logLines[y - detailsH] || "", rightW);
    lines.push(`${L}${c.border}│${c.reset}${R}`);
  }

  const footer = `${c.dim}j/k:select  Space:collapse  Tab:pane  Enter:session  r:reload  q:quit  ·  clawbot seats = mint count${c.reset}`;
  lines.push(pad(footer, cols));

  // Render
  process.stdout.write(`${ESC}[?25l${ESC}[H${ESC}[J`);
  process.stdout.write(lines.join("\n"));
  if (lines.length < rowsN) process.stdout.write("\n".repeat(rowsN - lines.length));
}

function openSessionDir(sessionId) {
  if (!sessionId) return;
  const dir = join(SESSIONS, sessionId);
  if (!existsSync(dir)) return;
  // Best-effort: print path; caller may attach later
  spawnSync("open", [dir], { stdio: "ignore" });
}

async function runTui() {
  const orchId = loadOrchId();
  let collapsed = {};
  let sel = 1; // prefer first card
  let focusPane = "list"; // list | details | logs
  let board = buildBoard(fetchRoster(), orchId);
  let rows = flatSelectable(board, collapsed);

  // jump selection to first card
  const firstCard = rows.findIndex((r) => r.type === "card");
  if (firstCard >= 0) sel = firstCard;

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  const term = {
    cols: process.stdout.columns || 100,
    rows: process.stdout.rows || 40,
  };

  const redraw = () => {
    board = buildBoard(fetchRoster(), orchId);
    rows = flatSelectable(board, collapsed);
    if (sel >= rows.length) sel = Math.max(0, rows.length - 1);
    drawTui({ board, rows, sel, collapsed, focusPane, term });
  };

  const onResize = () => {
    term.cols = process.stdout.columns || 100;
    term.rows = process.stdout.rows || 40;
    drawTui({ board, rows, sel, collapsed, focusPane, term });
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
      if (key.ctrl && key.name === "c") {
        cleanup();
        resolve();
        return;
      }
      if (key.name === "q" || key.name === "escape") {
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
        drawTui({ board, rows, sel, collapsed, focusPane, term });
        return;
      }
      if (key.name === "j" || key.name === "down") {
        sel = Math.min(rows.length - 1, sel + 1);
        drawTui({ board, rows, sel, collapsed, focusPane, term });
        return;
      }
      if (key.name === "k" || key.name === "up") {
        sel = Math.max(0, sel - 1);
        drawTui({ board, rows, sel, collapsed, focusPane, term });
        return;
      }
      if (str === " " || key.name === "space") {
        const row = rows[sel];
        if (row?.type === "cat") {
          collapsed[row.key] = !collapsed[row.key];
          rows = flatSelectable(board, collapsed);
          drawTui({ board, rows, sel, collapsed, focusPane, term });
        } else if (row?.type === "card") {
          // collapse parent category
          collapsed[row.cat] = true;
          rows = flatSelectable(board, collapsed);
          sel = Math.max(
            0,
            rows.findIndex((r) => r.type === "cat" && r.key === row.cat),
          );
          drawTui({ board, rows, sel, collapsed, focusPane, term });
        }
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        const card = selectedCard(rows, sel);
        if (card?.sessionId) openSessionDir(card.sessionId);
        return;
      }
      if (str === "e") {
        focusPane = focusPane === "logs" ? "details" : "logs";
        drawTui({ board, rows, sel, collapsed, focusPane, term });
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

  // Default on tty: interactive 3-pane TUI
  await runTui();
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
