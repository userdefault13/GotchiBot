#!/usr/bin/env node
/**
 * project-mailbox.mjs — per-desk local mailboxes under the project AgentMail.
 *
 * Policy: still ONE AgentMail address per project (`sessions/pstack/<slug>/mail.json`).
 * mail-courier owns AgentMail send/receive (abra `AGENT_MAIL_API_KEY`); other desks
 * never hold the key and passoff outbound to the courier. Every desk also has a
 * LOCAL mailbox so agents see their own inbox + sent — the courier appends to
 * those files on send/receive (never a second AgentMail inbox).
 *
 * Store:
 *   sessions/pstack/<slug>/desks/<heroId>/mailbox/inbox.json
 *   sessions/pstack/<slug>/desks/<heroId>/mailbox/sent.json
 *
 *   node scripts/project-mailbox.mjs desk ensure <hero> [--project <slug>]
 *   node scripts/project-mailbox.mjs desk ensure-roster [--project <slug>]
 *   node scripts/project-mailbox.mjs desk show <hero> [--json] [--project <slug>]
 *   node scripts/project-mailbox.mjs inbox <hero> [--json] [--unread] [--project <slug>]
 *   node scripts/project-mailbox.mjs sent <hero> [--json] [--project <slug>]
 *   node scripts/project-mailbox.mjs append inbox|sent <hero> --from <x> --to <x> --subject "…" [--snippet "…"] [--thread <id>] [--agent-mail-id <id>] [--passoff <id>] [--read] [--project <slug>]
 *   node scripts/project-mailbox.mjs read <hero> <messageId> [--project <slug>]
 *   node scripts/project-mailbox.mjs digest [--json] [--project <slug>]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";
import {
  currentProjectSlug,
  ensureProjectDirs,
  loadRoster,
  projectRoot,
  requireProjectSlug,
  slugOk,
} from "./project-context.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const MAILBOX_KINDS = ["inbox", "sent"];

function nowIso() {
  return new Date().toISOString();
}

function newMessageId() {
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/* ── store ─────────────────────────────────────────────────────────────── */

export function deskMailboxDir(heroId, slug = currentProjectSlug()) {
  const root = projectRoot(slug);
  if (!root || !heroId) return null;
  return join(root, "desks", String(heroId), "mailbox");
}

export function deskMailboxPaths(heroId, slug = currentProjectSlug()) {
  const dir = deskMailboxDir(heroId, slug);
  if (!dir) return null;
  return { dir, inbox: join(dir, "inbox.json"), sent: join(dir, "sent.json") };
}

function emptyMailbox({ project, heroId, kind }) {
  return {
    project,
    heroId: String(heroId),
    kind, // "inbox" | "sent"
    messages: [],
    updatedAt: nowIso(),
    note: "Desk mailbox. Project AgentMail is one address; courier appends here on send/receive.",
  };
}

export function loadMailbox(heroId, kind, slug = requireProjectSlug()) {
  if (!MAILBOX_KINDS.includes(kind)) throw new Error(`kind must be inbox|sent, got ${kind}`);
  const paths = deskMailboxPaths(heroId, slug);
  if (!paths) throw new Error("no project selected");
  const p = paths[kind];
  if (!p || !existsSync(p)) return emptyMailbox({ project: slug, heroId, kind });
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    return {
      ...emptyMailbox({ project: slug, heroId, kind }),
      ...j,
      heroId: String(j.heroId || heroId),
      kind: j.kind === "sent" ? "sent" : "inbox",
      messages: Array.isArray(j.messages) ? j.messages : [],
    };
  } catch {
    return emptyMailbox({ project: slug, heroId, kind });
  }
}

export function saveMailbox(box, slug = requireProjectSlug()) {
  if (!box || !box.heroId) throw new Error("hero id required");
  const paths = deskMailboxPaths(box.heroId, slug);
  if (!paths) throw new Error("no project selected");
  mkdirSync(paths.dir, { recursive: true });
  const body = { ...box, updatedAt: nowIso() };
  writeFileSync(paths[box.kind], `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return body;
}

/** Ensure both inbox.json + sent.json exist for a hero's desk. */
export function ensureDeskMailbox(heroId, slug = requireProjectSlug()) {
  if (!heroId) throw new Error("hero id required");
  ensureProjectDirs(slug);
  const paths = deskMailboxPaths(heroId, slug);
  if (!paths) throw new Error("no project selected");
  mkdirSync(paths.dir, { recursive: true });
  const inbox = loadMailbox(heroId, "inbox", slug);
  const sent = loadMailbox(heroId, "sent", slug);
  if (!existsSync(paths.inbox)) saveMailbox(inbox, slug);
  if (!existsSync(paths.sent)) saveMailbox(sent, slug);
  return { inbox, sent, paths };
}

/** Ensure a mailbox for every hero on the project roster. */
export function ensureRosterMailboxes(slug = requireProjectSlug()) {
  const { heroes } = loadRoster(slug);
  const ensured = [];
  for (const hero of heroes) {
    ensureDeskMailbox(hero, slug);
    ensured.push(String(hero));
  }
  return { project: slug, heroes: ensured, count: ensured.length };
}

/**
 * Append a message to a desk mailbox. Idempotent: when `agentMailId` is set and
 * already present in that box, nothing is written and `{ skipped: true }` returns.
 */
export function appendMessage(heroId, kind, fields, slug = requireProjectSlug()) {
  if (!heroId) throw new Error("hero id required");
  if (!MAILBOX_KINDS.includes(kind)) throw new Error(`kind must be inbox|sent, got ${kind}`);
  const from = String(fields.from || "").trim();
  const to = String(fields.to || "").trim();
  const subject = String(fields.subject || "").trim();
  if (!from || !to || !subject) throw new Error("from, to, subject required");
  const agentMailId = fields.agentMailId ? String(fields.agentMailId) : null;
  const box = loadMailbox(heroId, kind, slug);
  if (agentMailId && box.messages.some((m) => m.agentMailId === agentMailId)) {
    return { skipped: true, reason: "agent-mail-id already in box", heroId, kind, agentMailId };
  }
  const msg = {
    id: newMessageId(),
    direction: kind === "inbox" ? "in" : "out",
    from,
    to,
    subject,
    snippet: fields.snippet ? String(fields.snippet).trim() : "",
    threadId: fields.thread ? String(fields.thread) : null,
    agentMailId,
    passoffId: fields.passoff ? String(fields.passoff) : null,
    unread: kind === "inbox" ? !fields.read : false,
    at: nowIso(),
  };
  box.messages.push(msg);
  saveMailbox(box, slug);
  return { skipped: false, message: msg, heroId, kind };
}

/** Mark an inbox message read. Sent messages are never unread. */
export function markRead(heroId, messageId, slug = requireProjectSlug()) {
  if (!heroId || !messageId) throw new Error("hero id and message id required");
  const box = loadMailbox(heroId, "inbox", slug);
  const msg = box.messages.find((m) => m.id === messageId);
  if (!msg) {
    const sent = loadMailbox(heroId, "sent", slug);
    const s = sent.messages.find((m) => m.id === messageId);
    if (!s) throw new Error(`message not found: ${messageId}`);
    return { found: false, kind: "sent", message: s }; // sent is never unread
  }
  msg.unread = false;
  saveMailbox(box, slug);
  return { found: true, kind: "inbox", message: msg };
}

/** Per-desk mailbox digest across the project. */
export function mailboxDigest(slug = requireProjectSlug()) {
  const root = projectRoot(slug);
  const desksRoot = join(root, "desks");
  const rows = [];
  if (existsSync(desksRoot)) {
    for (const heroId of readdirSync(desksRoot)) {
      const paths = deskMailboxPaths(heroId, slug);
      if (!paths || !existsSync(paths.inbox)) continue;
      const inbox = loadMailbox(heroId, "inbox", slug);
      const sent = loadMailbox(heroId, "sent", slug);
      rows.push({
        heroId,
        inbox: inbox.messages.length,
        unread: inbox.messages.filter((m) => m.unread).length,
        sent: sent.messages.length,
        updatedAt: inbox.updatedAt,
      });
    }
  }
  rows.sort((a, b) => (a.heroId < b.heroId ? -1 : 1));
  const total = rows.reduce((n, r) => n + r.inbox + r.sent, 0);
  const unread = rows.reduce((n, r) => n + r.unread, 0);
  return { project: slug, updatedAt: nowIso(), desks: rows, total, unread };
}

/* ── render ────────────────────────────────────────────────────────────── */

function printMessage(m) {
  const mark = m.unread ? "●" : " ";
  console.log(`  ${mark} ${m.id}  ${m.from} → ${m.to}  ${m.subject}`);
  const links = [
    m.threadId ? `thread ${m.threadId}` : null,
    m.agentMailId ? `agentmail ${m.agentMailId}` : null,
    m.passoffId ? `passoff ${m.passoffId}` : null,
  ].filter(Boolean);
  if (links.length) console.log(`      ${links.join(" · ")}`);
  if (m.snippet) console.log(`      ${m.snippet}`);
  console.log(`      ${m.at}`);
}

function printBox(box, label) {
  console.log(`${label}  project=${box.project}  hero=${box.heroId}  (${box.messages.length})`);
  for (const m of box.messages) printMessage(m);
}

function usage() {
  console.error(`usage:
  project-mailbox desk ensure <hero> [--project <slug>]
  project-mailbox desk ensure-roster [--project <slug>]
  project-mailbox desk show <hero> [--json] [--project <slug>]
  project-mailbox inbox <hero> [--json] [--unread] [--project <slug>]
  project-mailbox sent <hero> [--json] [--project <slug>]
  project-mailbox append inbox|sent <hero> --from <x> --to <x> --subject "…" [--snippet "…"] [--thread <id>] [--agent-mail-id <id>] [--passoff <id>] [--read] [--project <slug>]
  project-mailbox read <hero> <messageId> [--project <slug>]
  project-mailbox digest [--json] [--project <slug>]
kinds: ${MAILBOX_KINDS.join("|")}`);
  process.exit(2);
}

function parseFlags(argv) {
  const out = {
    positional: [],
    project: null,
    from: null,
    to: null,
    subject: null,
    snippet: null,
    thread: null,
    agentMailId: null,
    passoff: null,
    read: false,
    unread: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--project") out.project = argv[++i];
    else if (a === "--from") out.from = argv[++i];
    else if (a === "--to") out.to = argv[++i];
    else if (a === "--subject") out.subject = argv[++i];
    else if (a === "--snippet") out.snippet = argv[++i];
    else if (a === "--thread") out.thread = argv[++i];
    else if (a === "--agent-mail-id") out.agentMailId = argv[++i];
    else if (a === "--passoff") out.passoff = argv[++i];
    else if (a === "--read") out.read = true;
    else if (a === "--unread") out.unread = true;
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

  if (cmd === "desk") {
    const sub = rest[0];
    if (sub === "ensure") {
      const hero = rest[1];
      if (!hero) usage();
      const r = ensureDeskMailbox(hero, slug);
      console.log(`desk mailbox → ${r.paths.dir}  inbox ${r.inbox.messages.length} · sent ${r.sent.messages.length}`);
      return;
    }
    if (sub === "ensure-roster") {
      const r = ensureRosterMailboxes(slug);
      console.log(`desk mailboxes ensured for ${r.count} roster hero(es): ${r.heroes.join(", ") || "(none)"}`);
      return;
    }
    if (sub === "show") {
      const hero = rest[1];
      if (!hero) usage();
      const r = ensureDeskMailbox(hero, slug);
      if (flags.json) console.log(JSON.stringify({ inbox: r.inbox, sent: r.sent }, null, 2));
      else {
        printBox(r.inbox, `inbox ${hero}`);
        console.log();
        printBox(r.sent, `sent ${hero}`);
      }
      return;
    }
    usage();
  }

  if (cmd === "inbox" || cmd === "sent") {
    const hero = rest[0];
    if (!hero) usage();
    const box = loadMailbox(hero, cmd, slug);
    let messages = box.messages;
    if (cmd === "inbox" && flags.unread) messages = messages.filter((m) => m.unread);
    if (flags.json) console.log(JSON.stringify({ ...box, messages }, null, 2));
    else printBox({ ...box, messages }, `${cmd} ${hero}`);
    return;
  }

  if (cmd === "append") {
    const kind = rest[0];
    const hero = rest[1];
    if (!kind || !hero) usage();
    const r = appendMessage(
      hero,
      kind,
      {
        from: flags.from,
        to: flags.to,
        subject: flags.subject,
        snippet: flags.snippet,
        thread: flags.thread,
        agentMailId: flags.agentMailId,
        passoff: flags.passoff,
        read: flags.read,
      },
      slug,
    );
    if (r.skipped) {
      console.log(`skipped ${kind} ${hero}: ${r.reason} (${r.agentMailId})`);
      return;
    }
    const unread = r.message.unread ? " unread" : "";
    console.log(`appended ${r.message.id} → ${kind} ${hero}${unread}  ${r.message.from} → ${r.message.to}  ${r.message.subject}`);
    return;
  }

  if (cmd === "read") {
    const hero = rest[0];
    const messageId = rest[1];
    if (!hero || !messageId) usage();
    const r = markRead(hero, messageId, slug);
    if (r.found) console.log(`read ${messageId} → ${hero} inbox (unread false)`);
    else console.log(`${messageId} is in ${hero} sent — sent is never unread`);
    return;
  }

  if (cmd === "digest") {
    const d = mailboxDigest(slug);
    if (flags.json) console.log(JSON.stringify(d, null, 2));
    else {
      console.log(`mailbox digest ${d.project} — total ${d.total} · unread ${d.unread}`);
      for (const r of d.desks) {
        console.log(`  ${r.heroId.padEnd(24)} inbox ${r.inbox} (unread ${r.unread}) · sent ${r.sent}`);
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