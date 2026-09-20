#!/usr/bin/env node
/**
 * pkm-record.mjs — every delegated / submitted / reviewed work notifies
 * kanban-manager (PKM) to record + manage. Falls back to orch if PKM unseated.
 *
 *   node scripts/pkm-record.mjs --event delegated|submitted|reviewed \\
 *     --from <hero> --title "…" [--to <hero|role>] [--ticket <id>] [--card <id>] \\
 *     [--note "…"] [--passoff <id>] [--session <id>] [--no-inbox] [--json]
 *
 * Events:
 *   delegated  — desk asked Prof for a worker / opened work for someone else
 *   submitted  — worker/desk handed work in for review
 *   reviewed   — accept or rework decision (note should say which)
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";
import { sendMessage } from "./bot-inbox.mjs";
import { currentProjectSlug } from "./project-context.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVENTS = new Set(["delegated", "submitted", "reviewed"]);

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}
function has(args, name) {
  return args.includes(name);
}

function usage() {
  console.error(`usage: pkm-record.mjs --event delegated|submitted|reviewed --from <hero> --title "…" [options]`);
  process.exit(2);
}

export function recordPkmEvent({
  event,
  from,
  title,
  to = null,
  ticket = null,
  card = null,
  note = "",
  passoff = null,
  session = null,
  noInbox = false,
} = {}) {
  if (!EVENTS.has(event)) throw new Error(`event must be ${[...EVENTS].join("|")}`);
  if (!from) throw new Error("--from required");
  if (!title) throw new Error("--title required");

  const project = currentProjectSlug() || null;
  const payload = {
    event,
    from,
    to: to || null,
    title: String(title).trim(),
    ticket: ticket || null,
    card: card || null,
    note: note ? String(note).trim() : "",
    passoff: passoff || null,
    session: session || null,
    project,
    at: new Date().toISOString(),
  };

  let inboxMsg = null;
  if (!noInbox) {
    const body = [
      `event: ${event}`,
      `from: ${from}`,
      to ? `to: ${to}` : null,
      `title: ${payload.title}`,
      ticket ? `ticket: ${ticket}` : null,
      card ? `card: ${card}` : null,
      passoff ? `passoff: ${passoff}` : null,
      session ? `session: ${session}` : null,
      project ? `project: ${project}` : null,
      payload.note ? `note: ${payload.note}` : null,
      "",
      "Action for kanban-manager: record on main board + ticket lifecycle; sync desk minis; manage blockers.",
    ]
      .filter((x) => x !== null)
      .join("\n");

    inboxMsg = sendMessage({
      to: "kanban-manager",
      from,
      subject: `pkm:${event} — ${payload.title.slice(0, 80)}`,
      body,
      kind: event === "reviewed" ? "report" : "fyi",
      project,
    });
  }

  return { ...payload, inboxId: inboxMsg?.id || null, inboxTo: inboxMsg?.to || null };
}

function main() {
  const args = process.argv.slice(2);
  if (!args.length) usage();
  const event = flag(args, "--event");
  const from = flag(args, "--from");
  const title = flag(args, "--title");
  if (!event || !from || !title) usage();
  const result = recordPkmEvent({
    event,
    from,
    title,
    to: flag(args, "--to"),
    ticket: flag(args, "--ticket"),
    card: flag(args, "--card"),
    note: flag(args, "--note") || "",
    passoff: flag(args, "--passoff"),
    session: flag(args, "--session"),
    noInbox: has(args, "--no-inbox"),
  });
  if (has(args, "--json")) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(
      `pkm-record ${result.event} → inbox ${result.inboxTo || "(none)"} id=${result.inboxId || "—"}  ${result.title}`,
    );
  }
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`pkm-record: ${e.message || e}`);
    process.exit(1);
  }
}
