#!/usr/bin/env node
/**
 * Bot inbox — internal async mail between bots and UserDefault / orch.
 *
 * Not AgentMail. Not passoff. Not meet.
 *   AgentMail / desk mailbox = external
 *   Passoff                  = work packets (Done / Next)
 *   Meet                     = live talk (burns quota)
 *   Bot inbox                = durable FYI / report / ask / alert
 *
 * Store (project-scoped when a pstack project is selected):
 *   sessions/pstack/<slug>/inbox/inbox.json
 *   sessions/pstack/<slug>/inbox/archive.json
 * Desk-wide fallback: sessions/inbox/
 *
 *   node scripts/bot-inbox.mjs send --to userdefault --from owned-954 \
 *        --subject "…" --body "…" [--kind fyi|report|ask|alert]
 *   node scripts/bot-inbox.mjs list [--to userdefault] [--unread] [--kind alert] [--json]
 *   node scripts/bot-inbox.mjs read <id>
 *   node scripts/bot-inbox.mjs archive <id>
 *   node scripts/bot-inbox.mjs digest [--json]   # unread counts by to + kind
 *   node scripts/bot-inbox.mjs unread [--to userdefault]
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { isMainModule } from "./is-main.mjs";
import {
  currentProjectSlug,
  resolveInboxRoot,
  requireProjectSlug,
} from "./project-context.mjs";
import { orchestratorHeroId } from "./openclaw-fleet.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const INBOX_KINDS = ["fyi", "report", "ask", "alert"];
const USER_ALIASES = new Set([
  "userdefault",
  "user",
  "user-default",
  "me",
  "human",
]);

function nowIso() {
  return new Date().toISOString();
}

function newMessageId() {
  return `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
}

export function inboxPaths(slug = currentProjectSlug()) {
  const { root, project } = resolveInboxRoot();
  return {
    root,
    project: project || slug || null,
    inbox: join(root, "inbox.json"),
    archive: join(root, "archive.json"),
  };
}

function emptyBox({ project, kind }) {
  return {
    project: project || null,
    kind, // inbox | archive
    messages: [],
    updatedAt: nowIso(),
    note:
      "Internal bot inbox — not AgentMail. Address UserDefault in bodies. Kinds: fyi|report|ask|alert.",
  };
}

export function loadBox(which = "inbox") {
  const paths = inboxPaths();
  const file = which === "archive" ? paths.archive : paths.inbox;
  if (!existsSync(file)) return emptyBox({ project: paths.project, kind: which });
  const j = readJson(file, null);
  if (!j || !Array.isArray(j.messages)) {
    return emptyBox({ project: paths.project, kind: which });
  }
  return j;
}

function saveBox(box, which = "inbox") {
  const paths = inboxPaths();
  box.updatedAt = nowIso();
  box.kind = which;
  box.project = paths.project;
  writeJson(which === "archive" ? paths.archive : paths.inbox, box);
  return box;
}

/** Normalize recipient: user aliases → userdefault; orch → orchestrator hero. */
export function normalizeAddress(raw) {
  const s = String(raw || "")
    .trim()
    .replace(/^@/, "");
  if (!s) throw new Error("address required");
  const low = s.toLowerCase();
  if (USER_ALIASES.has(low) || low === "userdefault") return "userdefault";
  if (low === "orch" || low === "gotchi" || low === "chair" || low === "orchestrator") {
    return orchestratorHeroId() || "owned-954";
  }
  return s;
}

function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return null;
  return args[i + 1] ?? "";
}

function hasFlag(args, name) {
  return args.includes(name);
}

/**
 * Send an internal message. Never touches AgentMail.
 */
export function sendMessage({
  to,
  from,
  subject,
  body,
  kind = "fyi",
  project = null,
} = {}) {
  const k = String(kind || "fyi").toLowerCase();
  if (!INBOX_KINDS.includes(k)) {
    throw new Error(`kind must be ${INBOX_KINDS.join("|")} (got ${kind})`);
  }
  const toId = normalizeAddress(to);
  const fromId = String(from || "").trim();
  if (!fromId) throw new Error("--from <heroId|userdefault> required");
  const subj = String(subject || "").trim();
  const text = String(body || "").trim();
  if (!subj) throw new Error("--subject required");
  if (!text) throw new Error("--body required");

  // Soft guard: discourage real-name address in body (UserDefault rule).
  if (/\bJulius\b/i.test(text) || /\bJulius\b/i.test(subj)) {
    throw new Error(
      "address UserDefault only — do not put the human's real name in subject/body",
    );
  }

  const paths = inboxPaths();
  const box = loadBox("inbox");
  const msg = {
    id: newMessageId(),
    project: project || paths.project,
    from: fromId === "user" || fromId.toLowerCase() === "me" ? "userdefault" : fromId,
    to: toId,
    kind: k,
    subject: subj,
    body: text,
    ts: nowIso(),
    readAt: null,
    archivedAt: null,
  };
  box.messages.push(msg);
  saveBox(box, "inbox");
  return msg;
}

export function listMessages({
  to = null,
  unread = false,
  kind = null,
  includeArchive = false,
} = {}) {
  const toId = to ? normalizeAddress(to) : null;
  const kindFilter = kind ? String(kind).toLowerCase() : null;
  if (kindFilter && !INBOX_KINDS.includes(kindFilter)) {
    throw new Error(`kind must be ${INBOX_KINDS.join("|")}`);
  }
  let msgs = [...(loadBox("inbox").messages || [])];
  if (includeArchive) {
    msgs = msgs.concat(loadBox("archive").messages || []);
  }
  msgs.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  return msgs.filter((m) => {
    if (toId && m.to !== toId) return false;
    if (unread && m.readAt) return false;
    if (kindFilter && m.kind !== kindFilter) return false;
    return true;
  });
}

export function findMessage(id) {
  const needle = String(id || "").trim();
  if (!needle) return null;
  for (const which of ["inbox", "archive"]) {
    const box = loadBox(which);
    const hit = (box.messages || []).find((m) => m.id === needle);
    if (hit) return { msg: hit, which, box };
  }
  return null;
}

export function readMessage(id, { markRead = true } = {}) {
  const found = findMessage(id);
  if (!found) throw new Error(`no message: ${id}`);
  if (markRead && !found.msg.readAt && found.which === "inbox") {
    found.msg.readAt = nowIso();
    saveBox(found.box, "inbox");
  }
  return found.msg;
}

export function archiveMessage(id) {
  const found = findMessage(id);
  if (!found) throw new Error(`no message: ${id}`);
  if (found.which === "archive") return found.msg;
  const inbox = found.box;
  inbox.messages = (inbox.messages || []).filter((m) => m.id !== found.msg.id);
  saveBox(inbox, "inbox");
  const arch = loadBox("archive");
  found.msg.archivedAt = nowIso();
  if (!found.msg.readAt) found.msg.readAt = found.msg.archivedAt;
  arch.messages.push(found.msg);
  saveBox(arch, "archive");
  return found.msg;
}

export function digest() {
  const msgs = loadBox("inbox").messages || [];
  const byTo = {};
  const byKind = {};
  let unread = 0;
  for (const m of msgs) {
    if (m.readAt) continue;
    unread += 1;
    byTo[m.to] = (byTo[m.to] || 0) + 1;
    byKind[m.kind] = (byKind[m.kind] || 0) + 1;
  }
  return {
    project: inboxPaths().project,
    unread,
    byTo,
    byKind,
    updatedAt: loadBox("inbox").updatedAt,
  };
}

function printList(rows) {
  if (!rows.length) {
    console.log("(empty)");
    return;
  }
  for (const m of rows) {
    const flag = m.readAt ? " " : "•";
    const when = String(m.ts || "").replace("T", " ").slice(0, 16);
    console.log(
      `${flag} ${m.id}  ${when}  [${m.kind}]  ${m.from} → ${m.to}  ${m.subject}`,
    );
  }
}

function usage() {
  console.error(`usage:
  bot-inbox.mjs send --to <userdefault|orch|hero> --from <hero> --subject "…" --body "…" [--kind fyi|report|ask|alert]
  bot-inbox.mjs list [--to <addr>] [--unread] [--kind <k>] [--json]
  bot-inbox.mjs read <id>
  bot-inbox.mjs archive <id>
  bot-inbox.mjs digest [--json]
  bot-inbox.mjs unread [--to userdefault]
  bot-inbox.mjs tui                  # interactive list+body (cockpit / tty)

Internal only — never AgentMail. Address UserDefault in bodies.`);
  process.exit(2);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === "-h" || cmd === "--help") usage();
  const rest = argv.slice(1);
  const json = hasFlag(rest, "--json");

  // Prefer a project when one is selected; allow desk-wide fallback.
  try {
    if (currentProjectSlug()) requireProjectSlug();
  } catch {
    /* desk-wide sessions/inbox */
  }

  if (cmd === "send") {
    const msg = sendMessage({
      to: flag(rest, "--to"),
      from: flag(rest, "--from"),
      subject: flag(rest, "--subject"),
      body: flag(rest, "--body"),
      kind: flag(rest, "--kind") || "fyi",
    });
    if (json) console.log(JSON.stringify(msg, null, 2));
    else console.log(`sent ${msg.id}  [${msg.kind}]  ${msg.from} → ${msg.to}  ${msg.subject}`);
    return;
  }

  if (cmd === "list") {
    const rows = listMessages({
      to: flag(rest, "--to"),
      unread: hasFlag(rest, "--unread"),
      kind: flag(rest, "--kind"),
    });
    if (json) console.log(JSON.stringify(rows, null, 2));
    else printList(rows);
    return;
  }

  if (cmd === "unread") {
    const rows = listMessages({ to: flag(rest, "--to") || "userdefault", unread: true });
    if (json) console.log(JSON.stringify(rows, null, 2));
    else {
      console.log(`${rows.length} unread for ${flag(rest, "--to") || "userdefault"}`);
      printList(rows);
    }
    return;
  }

  if (cmd === "read") {
    const id = rest.find((a) => !a.startsWith("--"));
    if (!id) usage();
    const msg = readMessage(id);
    if (json) console.log(JSON.stringify(msg, null, 2));
    else {
      console.log(`[${msg.kind}] ${msg.subject}`);
      console.log(`${msg.from} → ${msg.to}  ${msg.ts}${msg.readAt ? `  read ${msg.readAt}` : ""}`);
      console.log("");
      console.log(msg.body);
    }
    return;
  }

  if (cmd === "archive") {
    const id = rest.find((a) => !a.startsWith("--"));
    if (!id) usage();
    const msg = archiveMessage(id);
    if (json) console.log(JSON.stringify(msg, null, 2));
    else console.log(`archived ${msg.id}`);
    return;
  }

  if (cmd === "digest") {
    const d = digest();
    if (json) console.log(JSON.stringify(d, null, 2));
    else {
      console.log(`project ${d.project || "(desk)"}  unread ${d.unread}`);
      for (const [to, n] of Object.entries(d.byTo)) console.log(`  to ${to}: ${n}`);
      for (const [k, n] of Object.entries(d.byKind)) console.log(`  kind ${k}: ${n}`);
    }
    return;
  }

  if (cmd === "tui" || cmd === "ui" || cmd === "menu") {
    const r = spawnSync(process.execPath, [`${ROOT}/scripts/bot-inbox-tui.mjs`], {
      cwd: ROOT,
      stdio: "inherit",
      env: process.env,
    });
    process.exit(r.status ?? 1);
  }

  usage();
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e?.message || e);
    process.exit(1);
  });
}
