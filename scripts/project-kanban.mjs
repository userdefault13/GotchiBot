#!/usr/bin/env node
/**
 * project-kanban.mjs — headless project + desk mini kanban boards.
 *
 * Main board:  sessions/pstack/<slug>/kanban.json
 * Desk mini:   sessions/pstack/<slug>/desks/<heroId>/kanban.json
 *
 * The seat-status TUI remains scripts/gotchi-kanban.mjs (fleet seats).
 * This file is the *task* board for sealed projects.
 *
 *   node scripts/project-kanban.mjs show [--json] [--project <slug>]
 *   node scripts/project-kanban.mjs desk show <hero> [--json]
 *   node scripts/project-kanban.mjs desk ensure <hero>
 *   node scripts/project-kanban.mjs add "title" [--column todo] [--owner <hero>] [--desk <hero>]
 *   node scripts/project-kanban.mjs move <cardId> <column> [--desk <hero>]
 *   node scripts/project-kanban.mjs sync          # desk minis → main (merge by id)
 *   node scripts/project-kanban.mjs pull <hero>   # main cards owned by hero → that desk mini
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";
import {
  currentProjectSlug,
  ensureProjectDirs,
  projectRoot,
  requireProjectSlug,
  slugOk,
} from "./project-context.mjs";
import { ensureDeskMailbox } from "./project-mailbox.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const COLUMNS = ["backlog", "todo", "doing", "review", "done"];

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function mainKanbanPath(slug = currentProjectSlug()) {
  const root = projectRoot(slug);
  return root ? join(root, "kanban.json") : null;
}

export function deskKanbanPath(heroId, slug = currentProjectSlug()) {
  const root = projectRoot(slug);
  if (!root || !heroId) return null;
  return join(root, "desks", String(heroId), "kanban.json");
}

function emptyBoard({ project, kind, heroId = null }) {
  return {
    project,
    kind, // "project" | "desk"
    heroId,
    columns: [...COLUMNS],
    cards: [],
    updatedAt: nowIso(),
    note:
      kind === "desk"
        ? "Mini headless desk kanban. Sync into the project board via project-kanban sync."
        : "Main project kanban. Desk minis live under desks/<hero>/kanban.json; manager merges via sync.",
  };
}

export function loadBoard(path, fallback) {
  if (!path || !existsSync(path)) return fallback;
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    return {
      ...fallback,
      ...j,
      columns: Array.isArray(j.columns) && j.columns.length ? j.columns : [...COLUMNS],
      cards: Array.isArray(j.cards) ? j.cards : [],
    };
  } catch {
    return fallback;
  }
}

export function saveBoard(path, board) {
  mkdirSync(dirname(path), { recursive: true });
  const body = { ...board, updatedAt: nowIso() };
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return body;
}

export function ensureMainBoard(slug = requireProjectSlug()) {
  ensureProjectDirs(slug);
  const path = mainKanbanPath(slug);
  if (!existsSync(path)) {
    return saveBoard(path, emptyBoard({ project: slug, kind: "project" }));
  }
  return loadBoard(path, emptyBoard({ project: slug, kind: "project" }));
}

export function ensureDeskBoard(heroId, slug = requireProjectSlug()) {
  if (!heroId) throw new Error("hero id required");
  ensureProjectDirs(slug);
  // Desk seats also get a local mailbox (inbox+sent) — courier appends there.
  ensureDeskMailbox(heroId, slug);
  const path = deskKanbanPath(heroId, slug);
  if (!existsSync(path)) {
    return saveBoard(path, emptyBoard({ project: slug, kind: "desk", heroId: String(heroId) }));
  }
  return loadBoard(path, emptyBoard({ project: slug, kind: "desk", heroId: String(heroId) }));
}

function normalizeColumn(col) {
  const c = String(col || "todo").toLowerCase();
  if (!COLUMNS.includes(c)) {
    throw new Error(`unknown column "${col}" — use: ${COLUMNS.join("|")}`);
  }
  return c;
}

export function addCard(board, { title, column = "todo", owner = null, desk = null, source = "project" }) {
  const t = String(title || "").trim();
  if (!t) throw new Error("title required");
  const card = {
    id: newId(),
    title: t,
    column: normalizeColumn(column),
    owner: owner ? String(owner) : null,
    desk: desk ? String(desk) : owner ? String(owner) : null,
    source,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  board.cards.push(card);
  return card;
}

export function moveCard(board, cardId, column) {
  const card = board.cards.find((c) => c.id === cardId);
  if (!card) throw new Error(`card not found: ${cardId}`);
  card.column = normalizeColumn(column);
  card.updatedAt = nowIso();
  return card;
}

/** Merge desk mini cards into main by id (desk wins on conflict). */
export function syncDesksIntoMain(slug = requireProjectSlug()) {
  const mainPath = mainKanbanPath(slug);
  const main = ensureMainBoard(slug);
  const desksRoot = join(projectRoot(slug), "desks");
  if (!existsSync(desksRoot)) {
    return { main, merged: 0, desks: [] };
  }
  const byId = new Map(main.cards.map((c) => [c.id, c]));
  let merged = 0;
  const desks = [];
  for (const heroId of readdirSync(desksRoot)) {
    const p = deskKanbanPath(heroId, slug);
    if (!p || !existsSync(p)) continue;
    const desk = loadBoard(p, emptyBoard({ project: slug, kind: "desk", heroId }));
    desks.push(heroId);
    for (const card of desk.cards) {
      const next = {
        ...card,
        desk: card.desk || heroId,
        owner: card.owner || heroId,
        source: card.source || "desk",
        updatedAt: nowIso(),
      };
      if (byId.has(card.id)) {
        byId.set(card.id, { ...byId.get(card.id), ...next });
      } else {
        byId.set(card.id, next);
      }
      merged += 1;
    }
  }
  main.cards = [...byId.values()];
  saveBoard(mainPath, main);
  return { main, merged, desks };
}

/** Copy/update main cards assigned to hero onto that desk mini. */
export function pullMainOntoDesk(heroId, slug = requireProjectSlug()) {
  const main = ensureMainBoard(slug);
  const desk = ensureDeskBoard(heroId, slug);
  const hid = String(heroId);
  const mine = main.cards.filter(
    (c) => c.owner === hid || c.desk === hid || (!c.owner && !c.desk && c.source === "desk"),
  );
  const byId = new Map(desk.cards.map((c) => [c.id, c]));
  for (const card of mine) {
    byId.set(card.id, {
      ...card,
      desk: hid,
      owner: card.owner || hid,
      source: card.source || "project",
      updatedAt: nowIso(),
    });
  }
  desk.cards = [...byId.values()];
  saveBoard(deskKanbanPath(hid, slug), desk);
  return { desk, pulled: mine.length };
}

function printBoard(board, label) {
  console.log(`${label}  project=${board.project}  kind=${board.kind}${board.heroId ? `  hero=${board.heroId}` : ""}`);
  console.log(`updated ${board.updatedAt}`);
  for (const col of board.columns || COLUMNS) {
    const cards = board.cards.filter((c) => c.column === col);
    console.log(`\n▸ ${col.toUpperCase()} (${cards.length})`);
    if (!cards.length) {
      console.log("    —");
      continue;
    }
    for (const c of cards) {
      const who = c.owner || c.desk || "—";
      console.log(`    • ${c.id}  ${c.title}`);
      console.log(`      owner ${who}  src ${c.source || "—"}`);
    }
  }
}

function usage() {
  console.error(`usage:
  project-kanban show [--json] [--project <slug>]
  project-kanban desk show <hero> [--json] [--project <slug>]
  project-kanban desk ensure <hero> [--project <slug>]
  project-kanban add "title" [--column todo] [--owner <hero>] [--desk <hero>] [--project <slug>]
  project-kanban move <cardId> <column> [--desk <hero>] [--project <slug>]
  project-kanban sync [--project <slug>]
  project-kanban pull <hero> [--project <slug>]
columns: ${COLUMNS.join("|")}`);
  process.exit(2);
}

function parseFlags(argv) {
  const out = { positional: [], project: null, column: null, owner: null, desk: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--project") out.project = argv[++i];
    else if (a === "--column") out.column = argv[++i];
    else if (a === "--owner") out.owner = argv[++i];
    else if (a === "--desk") out.desk = argv[++i];
    else out.positional.push(a);
  }
  return out;
}

async function main() {
  const raw = process.argv.slice(2);
  if (!raw.length) usage();
  const flags = parseFlags(raw);
  const [cmd, ...rest] = flags.positional;
  let slug = flags.project || currentProjectSlug();
  if (flags.project) {
    if (!slugOk(flags.project)) throw new Error(`invalid project: ${flags.project}`);
    ensureProjectDirs(flags.project);
    slug = flags.project;
  } else {
    slug = requireProjectSlug();
  }

  if (cmd === "show") {
    const board = ensureMainBoard(slug);
    if (flags.json) console.log(JSON.stringify(board, null, 2));
    else printBoard(board, "project-kanban");
    return;
  }

  if (cmd === "desk") {
    const sub = rest[0];
    const hero = rest[1] || flags.desk;
    if (!sub || !hero) usage();
    if (sub === "ensure") {
      const board = ensureDeskBoard(hero, slug);
      console.log(`desk kanban → ${deskKanbanPath(hero, slug)}  cards ${board.cards.length}`);
      return;
    }
    if (sub === "show") {
      const board = ensureDeskBoard(hero, slug);
      if (flags.json) console.log(JSON.stringify(board, null, 2));
      else printBoard(board, `desk-kanban ${hero}`);
      return;
    }
    usage();
  }

  if (cmd === "add") {
    const title = rest.join(" ").trim() || flags.positional.slice(1).join(" ").trim();
    // rest already is title parts after cmd — but parseFlags put all in positional
    const titleParts = flags.positional.slice(1);
    const t = titleParts.join(" ").trim();
    if (!t) usage();
    const deskHero = flags.desk || flags.owner;
    if (deskHero) {
      const board = ensureDeskBoard(deskHero, slug);
      const card = addCard(board, {
        title: t,
        column: flags.column || "todo",
        owner: flags.owner || deskHero,
        desk: deskHero,
        source: "desk",
      });
      saveBoard(deskKanbanPath(deskHero, slug), board);
      // also mirror onto main
      const main = ensureMainBoard(slug);
      const existing = main.cards.findIndex((c) => c.id === card.id);
      if (existing >= 0) main.cards[existing] = card;
      else main.cards.push({ ...card });
      saveBoard(mainKanbanPath(slug), main);
      console.log(`added ${card.id} → desk ${deskHero} + project  [${card.column}] ${card.title}`);
      return;
    }
    const main = ensureMainBoard(slug);
    const card = addCard(main, {
      title: t,
      column: flags.column || "todo",
      owner: flags.owner,
      desk: flags.desk,
      source: "project",
    });
    saveBoard(mainKanbanPath(slug), main);
    console.log(`added ${card.id} → project  [${card.column}] ${card.title}`);
    return;
  }

  if (cmd === "move") {
    const cardId = rest[0];
    const column = rest[1] || flags.column;
    if (!cardId || !column) usage();
    if (flags.desk) {
      const board = ensureDeskBoard(flags.desk, slug);
      const card = moveCard(board, cardId, column);
      saveBoard(deskKanbanPath(flags.desk, slug), board);
      const main = ensureMainBoard(slug);
      const i = main.cards.findIndex((c) => c.id === cardId);
      if (i >= 0) main.cards[i] = { ...main.cards[i], ...card };
      else main.cards.push({ ...card });
      saveBoard(mainKanbanPath(slug), main);
      console.log(`moved ${cardId} → ${card.column} (desk ${flags.desk} + project)`);
      return;
    }
    const main = ensureMainBoard(slug);
    const card = moveCard(main, cardId, column);
    saveBoard(mainKanbanPath(slug), main);
    if (card.desk || card.owner) {
      const hid = card.desk || card.owner;
      try {
        const desk = ensureDeskBoard(hid, slug);
        const i = desk.cards.findIndex((c) => c.id === cardId);
        if (i >= 0) {
          desk.cards[i] = { ...desk.cards[i], ...card };
          saveBoard(deskKanbanPath(hid, slug), desk);
        }
      } catch {
        /* desk optional */
      }
    }
    console.log(`moved ${cardId} → ${card.column}`);
    return;
  }

  if (cmd === "sync") {
    const r = syncDesksIntoMain(slug);
    console.log(`synced ${r.desks.length} desk(s) · ${r.merged} card touch(es) → ${mainKanbanPath(slug)}`);
    return;
  }

  if (cmd === "pull") {
    const hero = rest[0] || flags.desk;
    if (!hero) usage();
    const r = pullMainOntoDesk(hero, slug);
    console.log(`pulled ${r.pulled} card(s) → ${deskKanbanPath(hero, slug)}`);
    return;
  }

  usage();
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
