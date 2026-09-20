#!/usr/bin/env node
/**
 * project-tickets.mjs — thin agent ticketing layer under the project kanban.
 *
 * Agents request/claim/submit work to each other; PKM (kanban-manager) owns
 * ticket lifecycle with orch. Tickets link to kanban cards — no second backlog.
 *
 * Store:   sessions/pstack/<slug>/tickets/<ticketId>.json
 * Index:   sessions/pstack/<slug>/tickets/index.json   (rewritten on mutation)
 *
 * States:  open → claimed → submitted → accepted | rework → closed
 *          (open → closed cancel; rework → submitted resubmit loop)
 * Card:    request→todo · claim→doing · submit→review · accept→done ·
 *          rework→todo · close→done (only when a card exists)
 *
 *   node scripts/project-tickets.mjs request --from <hero> --to <hero|role> "title" [--acceptance "…"] [--body "…"] [--card|--no-card] [--project <slug>]
 *   node scripts/project-tickets.mjs claim <id> --by <hero>
 *   node scripts/project-tickets.mjs submit <id> --by <hero> [--note "…"] [--passoff <passoffId>]
 *   node scripts/project-tickets.mjs accept <id> --by <hero> [--note "…"]
 *   node scripts/project-tickets.mjs rework <id> --by <hero> --note "…"
 *   node scripts/project-tickets.mjs close <id> --by <hero> [--note "…"]
 *   node scripts/project-tickets.mjs show <id> [--json]
 *   node scripts/project-tickets.mjs list [--to <hero>] [--from <hero>] [--status <s>] [--json]
 *   node scripts/project-tickets.mjs inbox <hero> [--json]
 *   node scripts/project-tickets.mjs digest [--json]
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
import {
  addCard,
  ensureMainBoard,
  mainKanbanPath,
  moveCard,
  pullMainOntoDesk,
  saveBoard,
} from "./project-kanban.mjs";
import { recordPkmEvent } from "./pkm-record.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const TICKET_STATUSES = ["open", "claimed", "submitted", "accepted", "rework", "closed"];

/** Allowed next states per current state (spec chain + escape hatches). */
export const TRANSITIONS = {
  open: ["claimed", "closed"], // closed = cancel
  claimed: ["submitted", "closed"], // closed = abandon
  submitted: ["accepted", "rework", "closed"], // closed = withdraw
  rework: ["submitted", "closed"], // resubmit loop / abandon
  accepted: ["closed"], // archive
  closed: [],
};

/** Kanban column per ticket status (only when a card exists). */
export const CARD_COLUMN = {
  claimed: "doing",
  submitted: "review",
  accepted: "done",
  rework: "todo",
  closed: "done",
};

function nowIso() {
  return new Date().toISOString();
}

function newTicketId() {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/* ── store ─────────────────────────────────────────────────────────────── */

export function ticketsDir(slug = currentProjectSlug()) {
  const root = projectRoot(slug);
  return root ? join(root, "tickets") : null;
}

export function ticketPath(ticketId, slug = currentProjectSlug()) {
  const dir = ticketsDir(slug);
  return dir && ticketId ? join(dir, `${ticketId}.json`) : null;
}

export function ticketsIndexPath(slug = currentProjectSlug()) {
  const dir = ticketsDir(slug);
  return dir ? join(dir, "index.json") : null;
}

export function ensureTicketsDir(slug = requireProjectSlug()) {
  ensureProjectDirs(slug);
  const ip = ticketsIndexPath(slug);
  if (!existsSync(ip)) {
    writeFileSync(
      ip,
      `${JSON.stringify({ project: slug, updatedAt: nowIso(), tickets: [] }, null, 2)}\n`,
      "utf8",
    );
  }
  return ticketsDir(slug);
}

export function loadTicket(ticketId, slug = requireProjectSlug()) {
  const p = ticketPath(ticketId, slug);
  if (!p || !existsSync(p)) throw new Error(`ticket not found: ${ticketId}`);
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    throw new Error(`ticket corrupt: ${ticketId}`);
  }
}

export function saveTicket(ticket, slug = requireProjectSlug()) {
  const p = ticketPath(ticket.id, slug);
  if (!p) throw new Error("ticket id required");
  mkdirSync(dirname(p), { recursive: true });
  const next = { ...ticket, updatedAt: nowIso() };
  writeFileSync(p, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  rebuildIndex(slug);
  return next;
}

/** Rewrite index.json from the ticket files on disk (single source of truth). */
export function rebuildIndex(slug = requireProjectSlug()) {
  const dir = ticketsDir(slug);
  const rows = [];
  if (dir && existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json") || f === "index.json") continue;
      try {
        const t = JSON.parse(readFileSync(join(dir, f), "utf8"));
        rows.push({
          id: t.id,
          from: t.from,
          to: t.to,
          title: t.title,
          status: t.status,
          cardId: t.cardId ?? null,
          updatedAt: t.updatedAt,
        });
      } catch {
        /* skip corrupt ticket file */
      }
    }
  }
  rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  const index = { project: slug, updatedAt: nowIso(), tickets: rows };
  writeFileSync(ticketsIndexPath(slug), `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return index;
}

export function loadIndex(slug = requireProjectSlug()) {
  const ip = ticketsIndexPath(slug);
  if (!ip || !existsSync(ip)) return rebuildIndex(slug);
  try {
    return JSON.parse(readFileSync(ip, "utf8"));
  } catch {
    return rebuildIndex(slug);
  }
}

/* ── transitions + history ─────────────────────────────────────────────── */

function assertTransition(ticket, next, op) {
  const allowed = TRANSITIONS[ticket.status] || [];
  if (!allowed.includes(next)) {
    throw new Error(`${op}: ${ticket.status} → ${next} not allowed (allowed: ${allowed.join("|") || "—"})`);
  }
}

function pushHistory(ticket, by, op, note = "") {
  ticket.history = ticket.history || [];
  ticket.history.push({ at: nowIso(), by: String(by), op, note: note || "" });
}

/* ── kanban link ───────────────────────────────────────────────────────── */

function createLinkedCard(slug, ticket) {
  const main = ensureMainBoard(slug);
  const card = addCard(main, { title: ticket.title, column: "todo", owner: ticket.to });
  saveBoard(mainKanbanPath(slug), main);
  return card;
}

function moveLinkedCard(slug, ticket, column) {
  if (!ticket.cardId) return null;
  const main = ensureMainBoard(slug);
  const card = moveCard(main, ticket.cardId, column);
  saveBoard(mainKanbanPath(slug), main);
  if (card.owner || card.desk) {
    try {
      pullMainOntoDesk(card.owner || card.desk, slug);
    } catch {
      /* desk mini optional */
    }
  }
  return card;
}

/* ── render ────────────────────────────────────────────────────────────── */

function printTicket(t) {
  console.log(`${t.id}  [${t.status}]  ${t.title}`);
  console.log(`  project ${t.project}  from ${t.from} → ${t.to}`);
  if (t.acceptance) console.log(`  acceptance: ${t.acceptance}`);
  if (t.body) console.log(`  body: ${t.body}`);
  const links = [
    t.cardId ? `card ${t.cardId}` : null,
    t.passoffId ? `passoff ${t.passoffId}` : null,
    t.claimer ? `claimer ${t.claimer}` : null,
  ].filter(Boolean);
  if (links.length) console.log(`  ${links.join(" · ")}`);
  if (t.submission) {
    console.log(`  submission: ${t.submission.at} by ${t.submission.by}${t.submission.note ? ` — ${t.submission.note}` : ""}`);
  }
  for (const h of t.history || []) {
    console.log(`  ${h.at}  ${h.op} by ${h.by}${h.note ? ` — ${h.note}` : ""}`);
  }
}

function usage() {
  console.error(`usage:
  project-tickets request --from <hero> --to <hero|role> "title" [--acceptance "…"] [--body "…"] [--card|--no-card] [--project <slug>]
  project-tickets claim <id> --by <hero>
  project-tickets submit <id> --by <hero> [--note "…"] [--passoff <passoffId>]
  project-tickets accept <id> --by <hero> [--note "…"]
  project-tickets rework <id> --by <hero> --note "…"
  project-tickets close <id> --by <hero> [--note "…"]
  project-tickets show <id> [--json]
  project-tickets list [--to <hero>] [--from <hero>] [--status <s>] [--json]
  project-tickets inbox <hero> [--json]
  project-tickets digest [--json]
states: ${TICKET_STATUSES.join("|")}`);
  process.exit(2);
}

function parseFlags(argv) {
  const out = {
    positional: [],
    project: null,
    from: null,
    to: null,
    acceptance: null,
    body: null,
    card: true,
    by: null,
    note: null,
    passoff: null,
    status: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--project") out.project = argv[++i];
    else if (a === "--from") out.from = argv[++i];
    else if (a === "--to") out.to = argv[++i];
    else if (a === "--acceptance") out.acceptance = argv[++i];
    else if (a === "--body") out.body = argv[++i];
    else if (a === "--card") out.card = true;
    else if (a === "--no-card") out.card = false;
    else if (a === "--by") out.by = argv[++i];
    else if (a === "--note") out.note = argv[++i];
    else if (a === "--passoff") out.passoff = argv[++i];
    else if (a === "--status") out.status = argv[++i];
    else out.positional.push(a);
  }
  return out;
}


function notifyPkm(event, ticket, by, note = "") {
  try {
    recordPkmEvent({
      event,
      from: by || ticket.from,
      title: ticket.title,
      to: ticket.to,
      ticket: ticket.id,
      card: ticket.cardId || null,
      note: note || "",
      passoff: ticket.passoffId || null,
    });
  } catch (e) {
    console.error(`[pkm-record] warn: ${e.message || e}`);
  }
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
  ensureTicketsDir(slug);

  if (cmd === "request") {
    const title = rest.join(" ").trim();
    if (!flags.from || !flags.to || !title) usage();
    const ticket = {
      id: newTicketId(),
      project: slug,
      from: flags.from,
      to: flags.to,
      title,
      acceptance: flags.acceptance ? String(flags.acceptance).trim() : "",
      body: flags.body ? String(flags.body).trim() : "",
      status: "open",
      cardId: null,
      passoffId: null,
      claimer: null,
      submission: null,
      history: [{ at: nowIso(), by: flags.from, op: "request", note: "" }],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    if (flags.card) {
      const card = createLinkedCard(slug, ticket);
      ticket.cardId = card.id;
    }
    saveTicket(ticket, slug);
    notifyPkm("delegated", ticket, flags.from, "ticket request opened");
    const cardPart = ticket.cardId ? `  card ${ticket.cardId} [todo]` : "  no card";
    console.log(`ticket ${ticket.id}  open → ${ticket.to}${cardPart}  ${ticket.title}`);
    return;
  }

  if (cmd === "claim") {
    const id = rest[0];
    if (!id || !flags.by) usage();
    const t = loadTicket(id, slug);
    assertTransition(t, "claimed", "claim");
    t.claimer = flags.by;
    t.status = "claimed";
    pushHistory(t, flags.by, "claim");
    moveLinkedCard(slug, t, CARD_COLUMN.claimed);
    saveTicket(t, slug);
    console.log(`ticket ${t.id}  claimed by ${flags.by} → doing`);
    return;
  }

  if (cmd === "submit") {
    const id = rest[0];
    if (!id || !flags.by) usage();
    const t = loadTicket(id, slug);
    assertTransition(t, "submitted", "submit");
    if (t.claimer && flags.by !== t.claimer) {
      throw new Error(`submit by claimer only: ${t.claimer}`);
    }
    t.status = "submitted";
    t.submission = { at: nowIso(), by: flags.by, note: flags.note || "", passoffId: flags.passoff || null };
    pushHistory(t, flags.by, "submit", flags.note || "");
    moveLinkedCard(slug, t, CARD_COLUMN.submitted);
    saveTicket(t, slug);
    console.log(`ticket ${t.id}  submitted by ${flags.by} → review`);
    notifyPkm("submitted", t, flags.by, flags.note || "submitted for review");
    return;
  }

  if (cmd === "accept") {
    const id = rest[0];
    if (!id || !flags.by) usage();
    const t = loadTicket(id, slug);
    assertTransition(t, "accepted", "accept");
    t.status = "accepted";
    pushHistory(t, flags.by, "accept", flags.note || "");
    moveLinkedCard(slug, t, CARD_COLUMN.accepted);
    saveTicket(t, slug);
    notifyPkm("reviewed", t, flags.by, flags.note || "accepted");
    console.log(`ticket ${t.id}  accepted by ${flags.by} → done`);
    return;
  }

  if (cmd === "rework") {
    const id = rest[0];
    if (!id || !flags.by || !flags.note) usage();
    const t = loadTicket(id, slug);
    assertTransition(t, "rework", "rework");
    t.status = "rework";
    pushHistory(t, flags.by, "rework", flags.note);
    moveLinkedCard(slug, t, CARD_COLUMN.rework);
    saveTicket(t, slug);
    notifyPkm("reviewed", t, flags.by, flags.note || "rework");
    console.log(`ticket ${t.id}  rework by ${flags.by} → todo  (${flags.note})`);
    return;
  }

  if (cmd === "close") {
    const id = rest[0];
    if (!id || !flags.by) usage();
    const t = loadTicket(id, slug);
    assertTransition(t, "closed", "close");
    t.status = "closed";
    pushHistory(t, flags.by, "close", flags.note || "");
    if (t.cardId) moveLinkedCard(slug, t, CARD_COLUMN.closed);
    saveTicket(t, slug);
    console.log(`ticket ${t.id}  closed by ${flags.by}`);
    return;
  }

  if (cmd === "show") {
    const id = rest[0];
    if (!id) usage();
    const t = loadTicket(id, slug);
    if (flags.json) console.log(JSON.stringify(t, null, 2));
    else printTicket(t);
    return;
  }

  if (cmd === "list") {
    const index = loadIndex(slug);
    let rows = index.tickets;
    if (flags.to) rows = rows.filter((r) => r.to === flags.to);
    if (flags.from) rows = rows.filter((r) => r.from === flags.from);
    if (flags.status) rows = rows.filter((r) => r.status === flags.status);
    if (flags.json) console.log(JSON.stringify(rows, null, 2));
    else {
      console.log(`tickets ${slug} (${rows.length})`);
      for (const r of rows) {
        console.log(`  ${r.id}  [${r.status}]  ${r.from} → ${r.to}  ${r.title}${r.cardId ? `  card ${r.cardId}` : ""}`);
      }
    }
    return;
  }

  if (cmd === "inbox") {
    const hero = rest[0] || flags.to;
    if (!hero) usage();
    const index = loadIndex(slug);
    const rows = index.tickets.filter(
      (r) =>
        ["open", "claimed", "submitted", "rework"].includes(r.status) &&
        (r.to === hero || r.claimer === hero),
    );
    if (flags.json) console.log(JSON.stringify(rows, null, 2));
    else {
      console.log(`inbox ${hero} (${rows.length})`);
      for (const r of rows) {
        console.log(`  ${r.id}  [${r.status}]  ${r.from} → ${r.to}  ${r.title}`);
      }
    }
    return;
  }

  if (cmd === "digest") {
    const index = loadIndex(slug);
    const counts = { open: 0, claimed: 0, submitted: 0, accepted: 0, rework: 0, closed: 0 };
    for (const r of index.tickets) counts[r.status] = (counts[r.status] || 0) + 1;
    const out = { project: slug, updatedAt: index.updatedAt, counts, total: index.tickets.length };
    if (flags.json) console.log(JSON.stringify(out, null, 2));
    else {
      console.log(`ticket digest ${slug} — total ${out.total}`);
      for (const s of TICKET_STATUSES) {
        console.log(`  ${s.padEnd(9)} ${counts[s]}`);
      }
    }
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