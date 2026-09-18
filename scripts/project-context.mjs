#!/usr/bin/env node
/**
 * Project context — one sealed room per pstack program slug.
 *
 * A project owns its bots (roster), meetings, passoffs/notes. Desk-wide
 * sessions/meetings and sessions/passoff are legacy fallbacks only when no
 * project is selected.
 *
 *   sessions/.pstack-dossier-current  — pane/dossier pointer (canonical slug)
 *   sessions/.project-current         — alias kept in sync (passoff / intake)
 *   sessions/pstack/<slug>/
 *     dossier.json · roster.json · mail.json · meetings/ · passoff/ · notes/ · tickets/
 *
 *   node scripts/project-context.mjs current [--json]
 *   node scripts/project-context.mjs set <slug>
 *   node scripts/project-context.mjs root [<slug>]
 *   node scripts/project-context.mjs roster [<slug>] [--json]
 *   node scripts/project-context.mjs roster-add <hero> [<slug>]
 *   node scripts/project-context.mjs mail show|set [<slug>] [--address …] [--inbox-id …]
 *   node scripts/project-context.mjs ensure [<slug>]
 */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = join(ROOT, "sessions");
const PSTACK_ROOT = join(SESSIONS, "pstack");
const DOSSIER_CURRENT = join(SESSIONS, ".pstack-dossier-current");
const PROJECT_CURRENT = join(SESSIONS, ".project-current");

export function slugOk(slug) {
  return typeof slug === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(slug);
}

export function currentProjectSlug() {
  for (const path of [DOSSIER_CURRENT, PROJECT_CURRENT]) {
    try {
      const s = readFileSync(path, "utf8").trim();
      if (s && slugOk(s)) return s;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Keep both pointers identical so passoff / pstack / cockpit agree. */
export function setCurrentProject(slug) {
  if (!slugOk(slug)) throw new Error(`invalid project slug: ${slug}`);
  mkdirSync(SESSIONS, { recursive: true });
  writeFileSync(DOSSIER_CURRENT, `${slug}\n`, "utf8");
  writeFileSync(PROJECT_CURRENT, `${slug}\n`, "utf8");
  ensureProjectDirs(slug);
  return slug;
}

export function projectRoot(slug = currentProjectSlug()) {
  if (!slug) return null;
  return join(PSTACK_ROOT, slug);
}

export function projectMeetingsDir(slug = currentProjectSlug()) {
  const root = projectRoot(slug);
  return root ? join(root, "meetings") : null;
}

export function projectPassoffDir(slug = currentProjectSlug()) {
  const root = projectRoot(slug);
  return root ? join(root, "passoff") : null;
}

export function projectNotesDir(slug = currentProjectSlug()) {
  const root = projectRoot(slug);
  return root ? join(root, "notes") : null;
}

export function rosterPath(slug = currentProjectSlug()) {
  const root = projectRoot(slug);
  return root ? join(root, "roster.json") : null;
}

export function mailPath(slug = currentProjectSlug()) {
  const root = projectRoot(slug);
  return root ? join(root, "mail.json") : null;
}

export function defaultMailBinding(slug) {
  return {
    project: slug,
    provider: "agentmail",
    abraProject: "gotchibot",
    abraKey: "AGENT_MAIL_API_KEY",
    inboxId: null,
    address: null,
    updatedAt: new Date().toISOString(),
    note: "One agent mailbox per project. Secrets stay in abra (AGENT_MAIL_API_KEY) — never commit keys.",
  };
}

export function loadMail(slug = currentProjectSlug()) {
  const mp = mailPath(slug);
  if (!mp || !existsSync(mp)) {
    return slug ? defaultMailBinding(slug) : null;
  }
  try {
    const j = JSON.parse(readFileSync(mp, "utf8"));
    return {
      ...defaultMailBinding(slug || j.project),
      ...j,
      project: j.project || slug,
    };
  } catch {
    return defaultMailBinding(slug);
  }
}

export function saveMail(patch = {}, slug = currentProjectSlug()) {
  if (!slug) throw new Error("no project selected");
  ensureProjectDirs(slug);
  const next = {
    ...loadMail(slug),
    ...patch,
    project: slug,
    provider: "agentmail",
    abraProject: patch.abraProject || "gotchibot",
    abraKey: patch.abraKey || "AGENT_MAIL_API_KEY",
    updatedAt: new Date().toISOString(),
  };
  // Never persist secret values if somehow passed
  delete next.apiKey;
  delete next.AGENT_MAIL_API_KEY;
  delete next.AGENTMAIL_API_KEY;
  writeFileSync(mailPath(slug), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function ensureProjectDirs(slug = currentProjectSlug()) {
  if (!slug) throw new Error("no project selected — cockpit → Select new project");
  const root = projectRoot(slug);
  mkdirSync(join(root, "meetings"), { recursive: true });
  mkdirSync(join(root, "passoff"), { recursive: true });
  mkdirSync(join(root, "notes"), { recursive: true });
  mkdirSync(join(root, "desks"), { recursive: true });
  mkdirSync(join(root, "tickets"), { recursive: true });
  mkdirSync(join(root, "inbox"), { recursive: true });
  const rp = rosterPath(slug);
  if (!existsSync(rp)) {
    writeFileSync(
      rp,
      `${JSON.stringify(
        {
          project: slug,
          heroes: [],
          updatedAt: new Date().toISOString(),
          note: "Closed roster when non-empty — only listed heroes meet, pass notes, and work this project. Empty = not sealed yet.",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
  const mp = mailPath(slug);
  if (!existsSync(mp)) {
    writeFileSync(mp, `${JSON.stringify(defaultMailBinding(slug), null, 2)}\n`, "utf8");
  }
  const kp = join(root, "kanban.json");
  if (!existsSync(kp)) {
    writeFileSync(
      kp,
      `${JSON.stringify(
        {
          project: slug,
          kind: "project",
          heroId: null,
          columns: ["backlog", "todo", "doing", "review", "done"],
          cards: [],
          updatedAt: new Date().toISOString(),
          note: "Main project kanban. Desk minis: desks/<hero>/kanban.json — sync via ./scripts/project-kanban.mjs sync",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
  const tip = join(root, "tickets", "index.json");
  if (!existsSync(tip)) {
    writeFileSync(
      tip,
      `${JSON.stringify(
        {
          project: slug,
          updatedAt: new Date().toISOString(),
          tickets: [],
          note: "Agent tickets — request/claim/submit via ./scripts/project-tickets.mjs; PKM owns accept/digest. Tickets link to kanban cards, never a second backlog.",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
  return root;
}

export function loadRoster(slug = currentProjectSlug()) {
  const rp = rosterPath(slug);
  if (!rp || !existsSync(rp)) {
    return { project: slug || null, heroes: [], updatedAt: null };
  }
  try {
    const j = JSON.parse(readFileSync(rp, "utf8"));
    const heroes = Array.isArray(j.heroes) ? j.heroes.map(String) : [];
    return { project: j.project || slug, heroes, updatedAt: j.updatedAt || null, note: j.note };
  } catch {
    return { project: slug, heroes: [], updatedAt: null };
  }
}

export function saveRoster(roster, slug = currentProjectSlug()) {
  ensureProjectDirs(slug);
  const rp = rosterPath(slug);
  const body = {
    project: slug,
    heroes: [...new Set((roster.heroes || []).map(String))],
    updatedAt: new Date().toISOString(),
    note: roster.note || "Closed roster — only listed heroes meet, pass notes, and work this project.",
  };
  writeFileSync(rp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return body;
}

export function rosterHas(heroId, slug = currentProjectSlug()) {
  if (!heroId) return false;
  const { heroes } = loadRoster(slug);
  if (!heroes.length) return true; // empty roster = not yet sealed; allow until first add
  return heroes.includes(String(heroId));
}

export function rosterAdd(heroId, slug = currentProjectSlug()) {
  if (!heroId) throw new Error("hero id required");
  ensureProjectDirs(slug);
  const r = loadRoster(slug);
  if (!r.heroes.includes(String(heroId))) r.heroes.push(String(heroId));
  return saveRoster(r, slug);
}

export function requireProjectSlug() {
  const slug = currentProjectSlug();
  if (!slug) {
    throw new Error(
      "no project selected — projects are sealed rooms (bots, meetings, notes).\n" +
        "  cockpit → Select new project   or   ./scripts/gotchibot pstack dossier current <slug>",
    );
  }
  ensureProjectDirs(slug);
  return slug;
}

/** Meetings/passoff dirs: project-scoped when a project is selected. */
export function resolveMeetingsRoot() {
  const slug = currentProjectSlug();
  if (slug) {
    ensureProjectDirs(slug);
    return { root: projectMeetingsDir(slug), project: slug, scoped: true };
  }
  return { root: join(SESSIONS, "meetings"), project: null, scoped: false };
}

export function resolvePassoffRoot() {
  const slug = currentProjectSlug();
  if (slug) {
    ensureProjectDirs(slug);
    return { root: projectPassoffDir(slug), project: slug, scoped: true };
  }
  return { root: join(SESSIONS, "passoff"), project: null, scoped: false };
}

/** Internal bot inbox (not AgentMail). Project-scoped when a project is selected. */
export function projectInboxDir(slug = currentProjectSlug()) {
  const root = projectRoot(slug);
  return root ? join(root, "inbox") : null;
}

export function resolveInboxRoot() {
  const slug = currentProjectSlug();
  if (slug) {
    ensureProjectDirs(slug);
    return { root: projectInboxDir(slug), project: slug, scoped: true };
  }
  const fallback = join(SESSIONS, "inbox");
  mkdirSync(fallback, { recursive: true });
  return { root: fallback, project: null, scoped: false };
}

function usage() {
  console.error(`usage:
  project-context current [--json]
  project-context set <slug>
  project-context root [<slug>]
  project-context roster [<slug>] [--json]
  project-context roster-add <hero> [<slug>]
  project-context mail show [<slug>] [--json]
  project-context mail set [<slug>] --address <email> [--inbox-id <id>]
  project-context ensure [<slug>]`);
  process.exit(2);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const json = rest.includes("--json");
  const args = rest.filter((a) => a !== "--json");
  if (!cmd) usage();

  if (cmd === "current") {
    const slug = currentProjectSlug();
    if (json) console.log(JSON.stringify({ project: slug }, null, 2));
    else console.log(slug || "");
    return;
  }
  if (cmd === "set") {
    const slug = args[0];
    if (!slug) usage();
    setCurrentProject(slug);
    console.log(`project → ${slug}`);
    return;
  }
  if (cmd === "root") {
    const slug = args[0] || currentProjectSlug();
    const root = projectRoot(slug);
    if (!root) {
      console.error("no project");
      process.exit(1);
    }
    console.log(root);
    return;
  }
  if (cmd === "ensure") {
    const slug = args[0] || requireProjectSlug();
    if (args[0]) setCurrentProject(args[0]);
    console.log(ensureProjectDirs(slug));
    return;
  }
  if (cmd === "roster") {
    const slug = args[0] || currentProjectSlug();
    const r = loadRoster(slug);
    if (json) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(`project ${r.project || "(none)"}`);
      console.log(`heroes (${r.heroes.length}): ${r.heroes.join(", ") || "(empty)"}`);
    }
    return;
  }
  if (cmd === "roster-add") {
    const hero = args[0];
    const slug = args[1] || currentProjectSlug();
    if (!hero || !slug) usage();
    const r = rosterAdd(hero, slug);
    console.log(`roster ${slug}: ${r.heroes.join(", ")}`);
    return;
  }
  if (cmd === "mail") {
    const sub = args[0] || "show";
    const restArgs = args.slice(1);
    let slug = currentProjectSlug();
    let address = null;
    let inboxId = null;
    for (let i = 0; i < restArgs.length; i++) {
      const a = restArgs[i];
      if (a === "--address") address = restArgs[++i];
      else if (a === "--inbox-id" || a === "--inboxId") inboxId = restArgs[++i];
      else if (!a.startsWith("--") && slugOk(a)) slug = a;
    }
    if (!slug) {
      console.error("no project selected");
      process.exit(1);
    }
    ensureProjectDirs(slug);
    if (sub === "show") {
      const m = loadMail(slug);
      if (json) console.log(JSON.stringify(m, null, 2));
      else {
        console.log(`project  ${m.project}`);
        console.log(`provider ${m.provider}`);
        console.log(`abra     ${m.abraProject} / ${m.abraKey}  (secret — not shown)`);
        console.log(`address  ${m.address || "(unset)"}`);
        console.log(`inboxId  ${m.inboxId || "(unset)"}`);
        console.log(`path     ${mailPath(slug)}`);
      }
      return;
    }
    if (sub === "set") {
      if (!address && !inboxId) {
        console.error("mail set needs --address and/or --inbox-id");
        process.exit(2);
      }
      const patch = {};
      if (address) patch.address = address;
      if (inboxId) patch.inboxId = inboxId;
      const m = saveMail(patch, slug);
      console.log(`mail → ${slug}  ${m.address || "—"}  inbox ${m.inboxId || "—"}`);
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
