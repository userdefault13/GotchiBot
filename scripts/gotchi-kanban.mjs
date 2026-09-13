#!/usr/bin/env node
/**
 * GotchiBot Kanban — terminal board of cAavegotchi seats + assigned tasks.
 *
 *   node scripts/gotchi-kanban.mjs              # print board once
 *   node scripts/gotchi-kanban.mjs --json       # machine-readable
 *   node scripts/gotchi-kanban.mjs --watch      # refresh every 5s (Ctrl+C to stop)
 *   node scripts/gotchi-kanban.mjs --interactive  # reload / back (cockpit)
 *
 * Seat cap = number of cartridge heroes (mints). Each clawbot may open many sessions.
 * Chief = owned-954 (never a worker card).
 */
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ORCH_ID = "owned-954";
const WATCH_MS = Number(process.env.GOTCHIBOT_KANBAN_WATCH_MS || 5000);

const args = process.argv.slice(2);
const wantJson = args.includes("--json");
const wantWatch = args.includes("--watch");
const wantInteractive = args.includes("--interactive") || args.includes("--menu");

function loadOrchId() {
  try {
    const p = `${ROOT}/sessions/.onboarding.json`;
    if (!existsSync(p)) return ORCH_ID;
    const j = JSON.parse(readFileSync(p, "utf8"));
    return j.orchestratorHeroId || ORCH_ID;
  } catch {
    return ORCH_ID;
  }
}

function fetchRoster() {
  const r = spawnSync(process.execPath, [`${ROOT}/scripts/agent-focus.mjs`, "list", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || "").trim() || `exit ${r.status}`;
    throw new Error(`agent-focus list --json failed: ${err}`);
  }
  const raw = (r.stdout || "").trim();
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`bad roster JSON: ${e.message}`);
  }
}

function trunc(s, n = 48) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (!t) return "—";
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function normStatus(h) {
  return String(h.status || h.agentStatus || "available").toLowerCase();
}

function columnFor(hero, orchId) {
  if (hero.id === orchId || hero.hero === orchId) return "chief";
  const st = normStatus(hero);
  if (st === "available") return "available";
  if (st === "working" || st === "active") return "working";
  if (st === "assigned" || st === "watching") return "assigned";
  if (st === "idle" || st === "done") return "idle";
  // fallback: has a task → assigned, else available
  if (hero.agentTask) return "assigned";
  return "available";
}

const COLUMNS = [
  { key: "chief", title: "CHIEF (orch)" },
  { key: "working", title: "WORKING / ACTIVE" },
  { key: "assigned", title: "ASSIGNED / WATCHING" },
  { key: "idle", title: "IDLE" },
  { key: "available", title: "AVAILABLE (free seats)" },
];

function buildBoard(roster, orchId) {
  const numbered = Array.isArray(roster?.numbered) ? roster.numbered : Array.isArray(roster) ? roster : [];
  const heroes = numbered.filter((e) => e.kind === "hero" || (!e.kind && e.id && String(e.id).includes("-")));
  // Prefer explicit kind===hero; if list shape differs, keep entries that look like heroes
  const cards = (heroes.length ? heroes : numbered.filter((e) => e.hero || e.collateral || e.bindType)).map((h) => {
    const id = h.id || h.hero;
    const st = normStatus(h);
    const col = columnFor({ ...h, id }, orchId);
    return {
      id,
      column: col,
      status: st,
      collateral: h.collateral || null,
      bindType: h.bindType || null,
      name: h.name || null,
      sessionId: h.agentSessionId || null,
      task: h.agentTask || null,
      host: h.host || "cartridge",
      isChief: id === orchId,
    };
  });

  const seatsTotal = cards.length;
  const seatsFree = cards.filter((c) => c.column === "available").length;
  const seatsUsed = seatsTotal - seatsFree;

  const columns = {};
  for (const c of COLUMNS) columns[c.key] = [];
  for (const card of cards) {
    (columns[card.column] || columns.assigned).push(card);
  }

  return {
    orchId,
    seatsTotal,
    seatsUsed,
    seatsFree,
    columns,
    cards,
    at: new Date().toISOString(),
  };
}

function printBoard(board) {
  const line = (ch = "─", n = 72) => ch.repeat(n);
  console.log("");
  console.log("GotchiBot Kanban — clawbot seats + tasks");
  console.log(line());
  console.log(
    `  seats  ${board.seatsUsed}/${board.seatsTotal} used · ${board.seatsFree} free · chief ${board.orchId}`,
  );
  console.log(`  as of  ${board.at}`);
  console.log(line());

  for (const col of COLUMNS) {
    const list = board.columns[col.key] || [];
    console.log("");
    console.log(`▸ ${col.title} (${list.length})`);
    if (!list.length) {
      console.log("    (empty)");
      continue;
    }
    for (const c of list) {
      const coll = c.collateral ? ` · ${c.collateral}` : "";
      const role = c.isChief ? " · CHIEF" : "";
      const sess = c.sessionId ? ` · ${c.sessionId}` : "";
      console.log(`    • ${c.id} [${c.status}]${role}${coll}${sess}`);
      console.log(`      task: ${trunc(c.task, 64)}`);
    }
  }

  console.log("");
  console.log(line());
  console.log("  CLI: node scripts/gotchi-kanban.mjs [--json] [--watch]");
  console.log("  Cap: clawbot seats = cartridge mint count; each seat may open many sessions.");
  console.log("");
}

async function interactive(boardFactory) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));
  try {
    for (;;) {
      console.clear?.();
      const board = boardFactory();
      printBoard(board);
      console.log("  [r] reload   [b] back / quit");
      const ans = String(await ask("\n  > ")).trim().toLowerCase();
      if (!ans || ans === "b" || ans === "back" || ans === "q" || ans === "quit") break;
      // r or anything else → reload
    }
  } finally {
    rl.close();
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const orchId = loadOrchId();
  const load = () => buildBoard(fetchRoster(), orchId);

  if (wantJson && !wantWatch && !wantInteractive) {
    console.log(JSON.stringify(load(), null, 2));
    return;
  }

  if (wantInteractive) {
    await interactive(load);
    return;
  }

  if (wantWatch) {
    for (;;) {
      try {
        process.stdout.write("\x1bc"); // clear
        const board = load();
        if (wantJson) console.log(JSON.stringify(board, null, 2));
        else printBoard(board);
        console.log(`  watching — refresh ${WATCH_MS}ms · Ctrl+C to stop`);
      } catch (e) {
        console.error(String(e.message || e));
      }
      await sleep(WATCH_MS);
    }
  }

  printBoard(load());
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
