#!/usr/bin/env node
/**
 * project-tickets.mjs — thin agent ticketing layer under the project kanban.
 *
 * Agents request/claim/submit work to each other; PKM (kanban-manager) owns
 * ticket lifecycle with orch. Tickets link to kanban cards — no second backlog.
 *
 * Store:   sessions/pstack/<slug>/tickets/<ticketId>.json
 * Index:   sessions/pstack/<slug>/tickets/index.json   (rewritten on mutation)
 * Jobs:    sessions/pstack/<slug>/jobs/<jobId>.json
 *
 * States:  open → claimed → submitted → accepted | rework → closed
 *          (open → closed cancel; rework → submitted resubmit loop)
 * Card:    request→todo · claim→doing · submit→review · accept→done ·
 *          rework→todo · close→done (only when a card exists)
 *
 *   node scripts/project-tickets.mjs request --from <hero> --to <hero|role> "title" [--acceptance "…"] [--body "…"] [--card|--no-card] [--job <jobId>] [--project <slug>]
 *   node scripts/project-tickets.mjs claim <id> --by <hero>
 *   node scripts/project-tickets.mjs submit <id> --by <hero> [--note "…"] [--passoff <passoffId>]
 *   node scripts/project-tickets.mjs accept <id> --by <hero> [--note "…"]
 *   node scripts/project-tickets.mjs rework <id> --by <hero> --note "…"
 *   node scripts/project-tickets.mjs close <id> --by <hero> [--note "…"]
 *   node scripts/project-tickets.mjs show <id> [--json]
 *   node scripts/project-tickets.mjs list [--to <hero>] [--from <hero>] [--status <s>] [--json]
 *   node scripts/project-tickets.mjs inbox <hero> [--json]
 *   node scripts/project-tickets.mjs digest [--json]
 *
 * A job is the ask those tickets belong to. Stages move only through `job advance`;
 * limbo is a flag, set when a child ticket sits open or claimed for 30 minutes.
 *
 *   node scripts/project-tickets.mjs job open --by <role|hero> "title" [--body]
 *   node scripts/project-tickets.mjs job advance <id> --to <stage> --by <role|hero> [--note]
 *   node scripts/project-tickets.mjs job show <id> [--json]
 *   node scripts/project-tickets.mjs job list [--json]
 *   node scripts/project-tickets.mjs job digest [--json]
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

export const JOB_STAGES = [
  "intake",
  "design",
  "plan",
  "approval",
  "staff",
  "assigned",
  "doing",
  "review",
  "rework",
  "verify",
  "approved",
  "reported",
];

/** Role that holds the job while it sits in a stage. Shown on the Factory rail. */
export const STAGE_OWNER = {
  intake: "orchestrator",
  design: "architect",
  plan: "project-manager",
  approval: "orchestrator",
  staff: "project-manager",
  assigned: "project-manager",
  doing: "kanban-manager",
  review: "chief-of-staff",
  rework: "project-manager",
  verify: "project-manager",
  approved: "chief-of-staff",
  reported: "orchestrator",
};

/**
 * Who may cross each edge. Orch owns intake, the UserDefault yes/no, and the
 * final report. PM owns the plan, staffing, assignment, and rework routing.
 * Kanban owns the move into review and the "all children accepted" signal.
 * CoS owns review notes and the final approval. CoS does not implement.
 */
export const JOB_MOVES = {
  "intake→design": ["orchestrator"],
  "design→plan": ["architect", "orchestrator"],
  "plan→approval": ["project-manager"],
  "approval→staff": ["orchestrator"],
  "approval→plan": ["orchestrator"],
  "staff→assigned": ["project-manager"],
  "assigned→doing": ["project-manager"],
  "doing→review": ["kanban-manager"],
  "review→rework": ["chief-of-staff"],
  "review→verify": ["kanban-manager", "chief-of-staff"],
  "rework→doing": ["project-manager"],
  "rework→assigned": ["project-manager"],
  "verify→approved": ["chief-of-staff"],
  "verify→rework": ["project-manager", "chief-of-staff"],
  "approved→reported": ["orchestrator"],
};

const ROLE_ALIAS = {
  orch: "orchestrator",
  pm: "project-manager",
  pkm: "kanban-manager",
  kanban: "kanban-manager",
  cos: "chief-of-staff",
};

/** Same bar as a stuck dispatch session. */
export const LIMBO_MS = 30 * 60 * 1000;

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
          jobId: t.jobId ?? null,
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

/* ── jobs ──────────────────────────────────────────────────────────────── */

export function jobsDir(slug = currentProjectSlug()) {
  const root = projectRoot(slug);
  return root ? join(root, "jobs") : null;
}

export function jobPath(jobId, slug = currentProjectSlug()) {
  const dir = jobsDir(slug);
  return dir && jobId ? join(dir, `${jobId}.json`) : null;
}

function newJobId() {
  return `j${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function loadRoles() {
  try {
    return JSON.parse(readFileSync(join(ROOT, "config/agent-roles.json"), "utf8"));
  } catch {
    return {};
  }
}

/** Role id, whether `by` is already a role or a seated hero. */
export function actorRole(by, roles = loadRoles()) {
  const raw = String(by || "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (ROLE_ALIAS[lower]) return ROLE_ALIAS[lower];
  if (Object.values(STAGE_OWNER).includes(raw)) return raw;
  return roles[raw] || null;
}

export function assertJobMove(stage, next, role) {
  const owners = JOB_MOVES[`${stage}→${next}`];
  if (!owners) {
    const allowed = Object.keys(JOB_MOVES)
      .filter((k) => k.startsWith(`${stage}→`))
      .map((k) => k.slice(stage.length + 1));
    throw new Error(`job: ${stage} → ${next} not allowed (allowed: ${allowed.join("|") || "—"})`);
  }
  if (!owners.includes(role)) {
    throw new Error(`job: ${role || "unknown"} cannot move ${stage} → ${next} (${owners.join("|")} only)`);
  }
}

export function isTicketLimbo(ticket, now = Date.now(), windowMs = LIMBO_MS) {
  if (ticket?.status !== "open" && ticket?.status !== "claimed") return false;
  const at = Date.parse(ticket.updatedAt || ticket.createdAt || "");
  return Number.isFinite(at) && now - at >= windowMs;
}

/** Live limbo and all-done, from the job's child tickets. Does not write. */
export function jobSignals(job, tickets, now = Date.now()) {
  const ids = new Set(job?.tickets || []);
  const children = (tickets || []).filter((t) => ids.has(t.id) || (t.jobId && t.jobId === job?.id));
  const limboTickets = children.filter((t) => isTicketLimbo(t, now)).map((t) => t.id);
  const unfinished = children.filter((t) => t.status !== "accepted" && t.status !== "closed");
  const allAccepted =
    children.length > 0 && unfinished.length === 0 && children.some((t) => t.status === "accepted");
  return { limbo: limboTickets.length > 0, limboTickets, allAccepted, children: children.length };
}

/**
 * Write the limbo flag onto the job. Stamps that stop a repeat consult are set
 * only when `notify` is set (kanban digest). A later stall, or a later
 * completion after rework, notifies once more.
 */
export function applyJobSignals(job, tickets, { now = Date.now(), notify = false } = {}) {
  const sig = jobSignals(job, tickets, now);
  const key = sig.limboTickets.slice().sort().join(",");
  const hints = { consultPmLimbo: false, consultPmAllDone: false };
  job.limbo = sig.limbo;
  job.limboTickets = sig.limboTickets;
  if (!sig.limbo) job.limboNotifiedKey = "";
  else if (notify && key !== (job.limboNotifiedKey || "")) {
    hints.consultPmLimbo = true;
    job.limboNotifiedKey = key;
  }
  if (!sig.allAccepted) job.allDoneNotifiedAt = null;
  else if (notify && !job.allDoneNotifiedAt) {
    hints.consultPmAllDone = true;
    job.allDoneNotifiedAt = new Date(now).toISOString();
  }
  return hints;
}

export function loadJob(jobId, slug = requireProjectSlug()) {
  const p = jobPath(jobId, slug);
  if (!p || !existsSync(p)) throw new Error(`job not found: ${jobId}`);
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    throw new Error(`job corrupt: ${jobId}`);
  }
}

export function saveJob(job, slug = requireProjectSlug()) {
  const p = jobPath(job.id, slug);
  if (!p) throw new Error("job id required");
  mkdirSync(dirname(p), { recursive: true });
  const next = { ...job, owner: STAGE_OWNER[job.stage] || job.owner || null, updatedAt: nowIso() };
  writeFileSync(p, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function listJobs(slug = requireProjectSlug()) {
  const dir = jobsDir(slug);
  const out = [];
  if (!dir || !existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const j = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (j?.id) out.push(j);
    } catch {
      /* skip corrupt job file */
    }
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return out;
}

export function listTicketFiles(slug = requireProjectSlug()) {
  const dir = ticketsDir(slug);
  const out = [];
  if (!dir || !existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json") || f === "index.json") continue;
    try {
      const t = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (t?.id) out.push(t);
    } catch {
      /* skip */
    }
  }
  return out;
}

function refreshJobs(slug, { notify = false } = {}) {
  const tickets = listTicketFiles(slug);
  const hints = [];
  for (const job of listJobs(slug)) {
    if (job.stage === "reported") continue;
    const h = applyJobSignals(job, tickets, { notify });
    saveJob(job, slug);
    if (h.consultPmLimbo) {
      hints.push({ job: job.id, kind: "limbo", tickets: job.limboTickets, consult: "project-manager" });
    }
    if (h.consultPmAllDone) {
      hints.push({ job: job.id, kind: "all-accepted", consult: "project-manager" });
    }
  }
  return hints;
}

function printHints(hints) {
  for (const h of hints) {
    if (h.kind === "limbo") {
      console.log(`consult project-manager: job ${h.job} limbo (${h.tickets.join(", ")})`);
    } else {
      console.log(`consult project-manager: job ${h.job} all child tickets accepted`);
    }
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
    if (t.jobId) console.log(`  job ${t.jobId}`);
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
  project-tickets request --from <hero> --to <hero|role> "title" [--acceptance "…"] [--body "…"] [--card|--no-card] [--job <jobId>] [--project <slug>]
  project-tickets claim <id> --by <hero>
  project-tickets submit <id> --by <hero> [--note "…"] [--passoff <passoffId>]
  project-tickets accept <id> --by <hero> [--note "…"]
  project-tickets rework <id> --by <hero> --note "…"
  project-tickets close <id> --by <hero> [--note "…"]
  project-tickets show <id> [--json]
  project-tickets list [--to <hero>] [--from <hero>] [--status <s>] [--json]
  project-tickets inbox <hero> [--json]
  project-tickets digest [--json]
  project-tickets job open --by <role|hero> "title" [--body] [--project]
  project-tickets job advance <id> --to <stage> --by <role|hero> [--note]
  project-tickets job show <id> [--json]
  project-tickets job list [--json]
  project-tickets job digest [--json]
states: ${TICKET_STATUSES.join("|")}
job stages: ${JOB_STAGES.join("|")}`);
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
    job: null,
    toStage: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--project") out.project = argv[++i];
    else if (a === "--from") out.from = argv[++i];
    else if (a === "--to") {
      out.to = argv[++i];
      out.toStage = out.to;
    }
    else if (a === "--acceptance") out.acceptance = argv[++i];
    else if (a === "--body") out.body = argv[++i];
    else if (a === "--card") out.card = true;
    else if (a === "--no-card") out.card = false;
    else if (a === "--by") out.by = argv[++i];
    else if (a === "--note") out.note = argv[++i];
    else if (a === "--passoff") out.passoff = argv[++i];
    else if (a === "--status") out.status = argv[++i];
    else if (a === "--job") out.job = argv[++i];
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
      jobId: null,
      history: [{ at: nowIso(), by: flags.from, op: "request", note: "" }],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    if (flags.job) {
      const job = loadJob(flags.job, slug);
      ticket.jobId = job.id;
      job.tickets = Array.isArray(job.tickets) ? job.tickets : [];
      if (!job.tickets.includes(ticket.id)) job.tickets.push(ticket.id);
      job.history = job.history || [];
      job.history.push({ at: nowIso(), by: flags.from, op: "ticket", note: ticket.id });
      saveJob(job, slug);
    }
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
    const hints = refreshJobs(slug, { notify: true });
    const out = { project: slug, updatedAt: index.updatedAt, counts, total: index.tickets.length, jobs: hints };
    if (flags.json) console.log(JSON.stringify(out, null, 2));
    else {
      console.log(`ticket digest ${slug} — total ${out.total}`);
      for (const s of TICKET_STATUSES) {
        console.log(`  ${s.padEnd(9)} ${counts[s]}`);
      }
      printHints(hints);
    }
    return;
  }

  if (cmd === "job") {
    const sub = rest[0];
    if (sub === "open") {
      const title = rest.slice(1).join(" ").trim();
      const role = actorRole(flags.by);
      if (!role || !title) usage();
      if (role !== "orchestrator") throw new Error("job open is orchestrator's move");
      const job = {
        id: newJobId(),
        project: slug,
        title,
        body: flags.body ? String(flags.body).trim() : "",
        stage: "intake",
        owner: STAGE_OWNER.intake,
        limbo: false,
        limboTickets: [],
        limboNotifiedKey: "",
        allDoneNotifiedAt: null,
        tickets: [],
        history: [{ at: nowIso(), by: role, actor: flags.by, op: "open", note: "" }],
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      const saved = saveJob(job, slug);
      if (flags.json) console.log(JSON.stringify(saved, null, 2));
      else console.log(`job ${saved.id}  [intake]  owner orchestrator  ${saved.title}`);
      return;
    }
    if (sub === "advance") {
      const id = rest[1];
      const role = actorRole(flags.by);
      const next = flags.toStage;
      if (!id || !role || !next) usage();
      if (!JOB_STAGES.includes(next)) throw new Error(`unknown stage: ${next}`);
      const job = loadJob(id, slug);
      assertJobMove(job.stage, next, role);
      const from = job.stage;
      job.stage = next;
      job.history = job.history || [];
      job.history.push({
        at: nowIso(),
        by: role,
        actor: flags.by,
        op: "advance",
        from,
        to: next,
        note: flags.note || "",
      });
      const saved = saveJob(job, slug);
      if (flags.json) console.log(JSON.stringify(saved, null, 2));
      else console.log(`job ${saved.id}  ${from} → ${next}  by ${role}  owner ${saved.owner}`);
      return;
    }
    if (sub === "show") {
      const id = rest[1];
      if (!id) usage();
      const job = loadJob(id, slug);
      const sig = jobSignals(job, listTicketFiles(slug));
      const view = { ...job, limbo: sig.limbo, limboTickets: sig.limboTickets };
      if (flags.json) console.log(JSON.stringify(view, null, 2));
      else {
        const flag = view.limbo ? `  LIMBO ${view.limboTickets.join(",")}` : "";
        console.log(`job ${view.id}  [${view.stage}]  owner ${view.owner}${flag}  ${view.title}`);
        if (view.body) console.log(`  body: ${view.body}`);
        if (view.tickets?.length) console.log(`  tickets: ${view.tickets.join(" ")}`);
        for (const h of view.history || []) {
          const edge = h.from ? ` ${h.from} → ${h.to}` : "";
          console.log(`  ${h.at}  ${h.op}${edge} by ${h.by}${h.note ? ` — ${h.note}` : ""}`);
        }
      }
      return;
    }
    if (sub === "list") {
      const rows = listJobs(slug).map((j) => ({
        id: j.id,
        stage: j.stage,
        owner: STAGE_OWNER[j.stage] || j.owner,
        title: j.title,
        limbo: !!j.limbo,
        updatedAt: j.updatedAt,
      }));
      if (flags.json) console.log(JSON.stringify(rows, null, 2));
      else {
        console.log(`jobs ${slug} (${rows.length})`);
        for (const r of rows) {
          console.log(`  ${r.id}  [${r.stage}]  ${r.owner}  ${r.limbo ? "LIMBO  " : ""}${r.title}`);
        }
      }
      return;
    }
    if (sub === "digest") {
      const hints = refreshJobs(slug, { notify: true });
      if (flags.json) console.log(JSON.stringify({ project: slug, hints }, null, 2));
      else {
        console.log(`job digest ${slug}`);
        printHints(hints);
        if (!hints.length) console.log("  (no consult)");
      }
      return;
    }
    usage();
  }

  usage();
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}