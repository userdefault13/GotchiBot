#!/usr/bin/env node
/**
 * Project context — one sealed room per pstack program slug.
 *
 * A project owns its bots (roster / crew), meetings, passoffs/notes. Desk-wide
 * sessions/meetings and sessions/passoff are legacy fallbacks only when no
 * project is selected.
 *
 * Definitions:
 *   Roster = all of the user's minted cAavegotchis on the GotchiBot cartridge
 *            (owned-* via bindOwned, starter-* via bindStarter). Source of truth
 *            = cartridge hero list.
 *   Crew   = the gotchis assigned to one project = sessions/pstack/<slug>/roster.json
 *            (user-facing name "crew"; keep roster.json paths + loadRoster/saveRoster/rosterAdd).
 *
 * Crew rules:
 *   1. owned-* may be in MANY project crews at once.
 *   2. starter-* may be in only ONE project crew at a time (use --move to reassign).
 *   3. unknown kinds: warn and allow (conservative).
 *
 *   sessions/.pstack-dossier-current  — pane/dossier pointer (canonical slug)
 *   sessions/.project-current         — alias kept in sync (passoff / intake)
 *   sessions/pstack/<slug>/
 *     dossier.json · roster.json · mail.json · meetings/ · passoff/ · notes/ · tickets/
 *
 *   node scripts/project-context.mjs current [--json]
 *   node scripts/project-context.mjs set <slug>
 *   node scripts/project-context.mjs root [<slug>]
 *   node scripts/project-context.mjs roster|crew [<slug>] [--json]
 *   node scripts/project-context.mjs roster-add|crew-add <hero> [<slug>] [--move]
 *   node scripts/project-context.mjs roster-remove|crew-remove <hero> [<slug>]
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
import { heroKind } from "./hero-kind.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Overridable for tests via GOTCHIBOT_SESSIONS_DIR (read lazily at call time). */
export function sessionsDir() {
  const o = process.env.GOTCHIBOT_SESSIONS_DIR;
  return o ? resolve(o) : join(ROOT, "sessions");
}

export function pstackRoot() {
  return join(sessionsDir(), "pstack");
}

function dossierCurrentPath() {
  return join(sessionsDir(), ".pstack-dossier-current");
}
function projectCurrentPath() {
  return join(sessionsDir(), ".project-current");
}
function storagePrefsPath() {
  return join(sessionsDir(), ".project-storage.json");
}

/** Desk default: local only. IPFS is opt-in via cockpit Settings. */
export function loadProjectStoragePrefs() {
  try {
    const j = JSON.parse(readFileSync(storagePrefsPath(), "utf8"));
    return { ipfsEnabled: j.ipfsEnabled === true };
  } catch {
    return { ipfsEnabled: false };
  }
}

export function saveProjectStoragePrefs(patch = {}) {
  mkdirSync(sessionsDir(), { recursive: true });
  const next = { ...loadProjectStoragePrefs(), ...patch };
  next.ipfsEnabled = next.ipfsEnabled === true;
  next.updatedAt = new Date().toISOString();
  writeFileSync(storagePrefsPath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function isIpfsStorageEnabled() {
  return loadProjectStoragePrefs().ipfsEnabled === true;
}

export function slugOk(slug) {
  return typeof slug === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(slug);
}

export function currentProjectSlug() {
  for (const path of [dossierCurrentPath(), projectCurrentPath()]) {
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
  mkdirSync(sessionsDir(), { recursive: true });
  writeFileSync(dossierCurrentPath(), `${slug}\n`, "utf8");
  writeFileSync(projectCurrentPath(), `${slug}\n`, "utf8");
  ensureProjectDirs(slug);
  return slug;
}

/** Clear desk project selection (new nest install / fresh onboard / cart transfer). */
export function clearCurrentProject() {
  for (const path of [dossierCurrentPath(), projectCurrentPath()]) {
    try {
      if (existsSync(path)) writeFileSync(path, "", "utf8");
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * Empty projects slice for a signed checkpoint after cart transfer.
 * Dossier dirs stay on the seller's disk; cart gameState must not carry them.
 */
export function emptyProjectCheckpointSlice(reason = "transfer") {
  return {
    current: null,
    slugs: [],
    entries: [],
    storage: {
      mode: "cleared",
      localRoot: "sessions/pstack",
      ipfsEnabled: isIpfsStorageEnabled(),
      stateUri: null,
    },
    updatedAt: new Date().toISOString(),
    clearedReason: reason,
  };
}

export function projectRoot(slug = currentProjectSlug()) {
  if (!slug) return null;
  return join(pstackRoot(), slug);
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

export function listProjectSlugsOnDisk() {
  const root = pstackRoot();
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root)
      .filter((name) => {
        try {
          return existsSync(join(root, name, "dossier.json"));
        } catch {
          return false;
        }
      })
      .filter((name) => slugOk(name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Dual storage for a project stamp:
 *   local  — desk sealed room path (always present when on this machine)
 *   ipfs   — optional CID URI after pin (cart / transfer-friendly)
 * Both can coexist; on-chain checkpointSave keeps stateHash + stateUri (prefer IPFS).
 */
export function projectStoragePaths(slug) {
  if (!slug || !slugOk(slug)) return null;
  const localRel = `sessions/pstack/${slug}`;
  const localAbs = join(pstackRoot(), slug);
  let ipfs = null;
  // IPFS pointers only surface when Settings → IPFS storage is on.
  if (isIpfsStorageEnabled()) {
    const tip = join(localAbs, "storage.json");
    try {
      if (existsSync(tip)) {
        const j = JSON.parse(readFileSync(tip, "utf8"));
        const uri = String(j.ipfsUri || j.ipfs || j.cid || "").trim();
        if (uri) ipfs = uri.startsWith("ipfs://") || uri.startsWith("http") ? uri : `ipfs://${uri}`;
      }
    } catch {
      /* ignore */
    }
  }
  return {
    slug,
    local: localRel,
    localAbs,
    ipfs,
  };
}

/** Persist / update IPFS pointer for a project (local path unchanged). Requires Settings → IPFS on. */
export function setProjectIpfsUri(slug, ipfsUri) {
  if (!slugOk(slug)) throw new Error(`invalid project slug: ${slug}`);
  if (!isIpfsStorageEnabled()) {
    throw new Error(
      "IPFS storage is off (local is default). Enable it in cockpit → Settings → IPFS storage.",
    );
  }
  ensureProjectDirs(slug);
  const tip = join(pstackRoot(), slug, "storage.json");
  let prev = {};
  try {
    if (existsSync(tip)) prev = JSON.parse(readFileSync(tip, "utf8"));
  } catch {
    prev = {};
  }
  const uri = String(ipfsUri || "").trim();
  const next = {
    ...prev,
    project: slug,
    local: `sessions/pstack/${slug}`,
    ipfsUri: uri
      ? uri.startsWith("ipfs://") || uri.startsWith("http")
        ? uri
        : `ipfs://${uri}`
      : null,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(tip, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

/**
 * Slice for cartridge checkpoint gameState.projects —
 * desk sealed rooms mirrored onto the cart via signed save (not a mint line).
 * Local is always present. IPFS entries / stateUri only when Settings enables it.
 */
export function projectCheckpointSlice() {
  const current = currentProjectSlug();
  const slugs = listProjectSlugsOnDisk();
  const ipfsOn = isIpfsStorageEnabled();
  const entries = slugs.map((slug) => {
    const s = projectStoragePaths(slug);
    return {
      slug,
      local: s?.local || `sessions/pstack/${slug}`,
      ipfs: ipfsOn ? s?.ipfs || null : null,
    };
  });
  const preferredIpfs = ipfsOn
    ? (current && projectStoragePaths(current)?.ipfs) ||
      entries.find((e) => e.ipfs)?.ipfs ||
      null
    : null;
  return {
    current: current || null,
    slugs,
    entries,
    storage: {
      mode: ipfsOn && preferredIpfs ? "dual" : ipfsOn ? "local+ipfs-ready" : "local",
      localRoot: "sessions/pstack",
      ipfsEnabled: ipfsOn,
      /** Prefer this for on-chain checkpointSave stateUri when IPFS is enabled + pinned. */
      stateUri: preferredIpfs,
    },
    updatedAt: new Date().toISOString(),
  };
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

/**
 * Scan sessions/pstack/<slug>/roster.json for crews that include heroId.
 * @param {string} heroId
 * @param {{ exceptSlug?: string|null }} [opts]
 * @returns {string[]} project slugs
 */
export function findCrewsForHero(heroId, { exceptSlug = null } = {}) {
  const id = String(heroId || "").trim();
  if (!id) return [];
  const root = pstackRoot();
  if (!existsSync(root)) return [];
  const hits = [];
  let names = [];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  for (const name of names) {
    if (!slugOk(name)) continue;
    if (exceptSlug && name === exceptSlug) continue;
    const rp = join(root, name, "roster.json");
    if (!existsSync(rp)) continue;
    try {
      const j = JSON.parse(readFileSync(rp, "utf8"));
      const heroes = Array.isArray(j.heroes) ? j.heroes.map(String) : [];
      if (heroes.includes(id)) hits.push(name);
    } catch {
      /* skip bad roster */
    }
  }
  return hits.sort();
}

/**
 * Rule 1: owned → always ok (wallet gotchi may sit on many crews).
 * Rule 2: starter → refuse if already on another project's crew.
 * Unknown → ok with warning (conservative).
 *
 * @returns {{ ok: boolean, kind: string, conflicts: string[], warning?: string, message?: string }}
 */
export function checkCrewConflict(heroId, slug) {
  const id = String(heroId || "").trim();
  const kind = heroKind(id);
  if (!id) {
    return { ok: false, kind, conflicts: [], message: "hero id required" };
  }

  // Rule 1 — wallet gotchi (owned-*): explicit allow; may be in MANY crews.
  if (kind === "owned") {
    return { ok: true, kind, conflicts: [] };
  }

  // Rule 2 — base collateral starter: only ONE project crew at a time.
  if (kind === "starter") {
    const conflicts = findCrewsForHero(id, { exceptSlug: slug || null });
    if (conflicts.length) {
      const others = conflicts.join(", ");
      const fixSlug = conflicts[0];
      return {
        ok: false,
        kind,
        conflicts,
        message:
          `starter ${id} is already on project crew(s): ${others}. ` +
          `Remove first: node scripts/project-context.mjs crew-remove ${id} ${fixSlug} ` +
          `or re-run with --move`,
      };
    }
    return { ok: true, kind, conflicts: [] };
  }

  // Unknown kinds: conservative = warn and allow.
  return {
    ok: true,
    kind,
    conflicts: [],
    warning: `unknown hero kind for ${id} — allowing crew assign (conservative)`,
  };
}

/** Throws Error with code CREW_CONFLICT when starter is locked to another crew. */
export function assertCrewAssignable(heroId, slug) {
  const r = checkCrewConflict(heroId, slug);
  if (!r.ok) {
    const err = new Error(r.message || "crew conflict");
    err.code = "CREW_CONFLICT";
    err.conflicts = r.conflicts;
    err.kind = r.kind;
    throw err;
  }
  return r;
}

function removeHeroFromCrew(heroId, slug) {
  const id = String(heroId);
  const r = loadRoster(slug);
  const next = r.heroes.filter((h) => h !== id);
  if (next.length === r.heroes.length) return r;
  // Direct write — do not re-enter saveRoster conflict checks for removals.
  ensureProjectDirs(slug);
  const body = {
    project: slug,
    heroes: next,
    updatedAt: new Date().toISOString(),
    note: r.note || "Closed roster — only listed heroes meet, pass notes, and work this project.",
  };
  writeFileSync(rosterPath(slug), `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return body;
}

/**
 * Persist project crew (roster.json). Enforces starter one-project lock for
 * heroes being added so direct callers cannot bypass rosterAdd.
 * @param {{ heroes?: string[], note?: string }} roster
 * @param {string} [slug]
 * @param {{ move?: boolean, force?: boolean }} [opts]
 */
export function saveRoster(roster, slug = currentProjectSlug(), opts = {}) {
  const { move = false, force = false } = opts;
  if (!slug) throw new Error("no project selected");
  ensureProjectDirs(slug);
  const prev = loadRoster(slug);
  const prevSet = new Set(prev.heroes.map(String));
  const heroes = [...new Set((roster.heroes || []).map(String))];
  const warnings = [];

  for (const id of heroes) {
    if (prevSet.has(id)) continue; // already on this crew — not a new add
    const kind = heroKind(id);
    if (kind === "owned") continue; // Rule 1
    if (kind === "unknown") {
      warnings.push(`unknown hero kind for ${id} — allowing (conservative)`);
      continue;
    }
    if (kind === "starter") {
      const check = checkCrewConflict(id, slug);
      if (!check.ok) {
        if (move) {
          for (const other of check.conflicts) removeHeroFromCrew(id, other);
        } else if (!force) {
          const err = new Error(check.message);
          err.code = "CREW_CONFLICT";
          err.conflicts = check.conflicts;
          err.kind = check.kind;
          throw err;
        }
      }
    }
  }

  const rp = rosterPath(slug);
  const body = {
    project: slug,
    heroes,
    updatedAt: new Date().toISOString(),
    note: roster.note || "Closed roster — only listed heroes meet, pass notes, and work this project.",
  };
  writeFileSync(rp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  if (warnings.length) body._warnings = warnings;
  return body;
}

export function rosterHas(heroId, slug = currentProjectSlug()) {
  if (!heroId) return false;
  const { heroes } = loadRoster(slug);
  if (!heroes.length) return true; // empty roster = not yet sealed; allow until first add
  return heroes.includes(String(heroId));
}

/**
 * Add hero to project crew. Starter locked to one crew unless {move:true}.
 * @param {string} heroId
 * @param {string} [slug]
 * @param {{ move?: boolean, force?: boolean }} [opts]
 */
export function rosterAdd(heroId, slug = currentProjectSlug(), opts = {}) {
  const { move = false, force = false } = opts;
  if (!heroId) throw new Error("hero id required");
  if (!slug) throw new Error("no project selected");
  ensureProjectDirs(slug);
  const id = String(heroId);
  const check = checkCrewConflict(id, slug);
  if (check.warning) {
    console.error(`warning: ${check.warning}`);
  }
  if (!check.ok) {
    if (move) {
      for (const other of check.conflicts) removeHeroFromCrew(id, other);
    } else if (!force) {
      const err = new Error(check.message);
      err.code = "CREW_CONFLICT";
      err.conflicts = check.conflicts;
      err.kind = check.kind;
      throw err;
    }
  }
  const r = loadRoster(slug);
  if (!r.heroes.includes(id)) r.heroes.push(id);
  // Already resolved conflicts / move — write without re-checking adds.
  ensureProjectDirs(slug);
  const body = {
    project: slug,
    heroes: [...new Set(r.heroes.map(String))],
    updatedAt: new Date().toISOString(),
    note: r.note || "Closed roster — only listed heroes meet, pass notes, and work this project.",
  };
  writeFileSync(rosterPath(slug), `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return body;
}

/** Remove hero from a project crew. */
export function rosterRemove(heroId, slug = currentProjectSlug()) {
  if (!heroId) throw new Error("hero id required");
  if (!slug) throw new Error("no project selected");
  return removeHeroFromCrew(String(heroId), slug);
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
  return { root: join(sessionsDir(), "meetings"), project: null, scoped: false };
}

export function resolvePassoffRoot() {
  const slug = currentProjectSlug();
  if (slug) {
    ensureProjectDirs(slug);
    return { root: projectPassoffDir(slug), project: slug, scoped: true };
  }
  return { root: join(sessionsDir(), "passoff"), project: null, scoped: false };
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
  const fallback = join(sessionsDir(), "inbox");
  mkdirSync(fallback, { recursive: true });
  return { root: fallback, project: null, scoped: false };
}

function usage() {
  console.error(`usage:
  project-context current [--json]
  project-context set <slug>
  project-context clear
  project-context root [<slug>]
  project-context storage [<slug>] [--json]
  project-context storage-set <slug> <ipfsUri|cid>
  project-context ipfs [on|off|status]
  project-context roster|crew [<slug>] [--json]
  project-context roster-add|crew-add <hero> [<slug>] [--move]
  project-context roster-remove|crew-remove <hero> [<slug>]
  project-context mail show [<slug>] [--json]
  project-context mail set [<slug>] --address <email> [--inbox-id <id>]
  project-context ensure [<slug>]`);
  process.exit(2);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--help" || cmd === "-h" || cmd === "help") usage();
  const json = rest.includes("--json");
  const move = rest.includes("--move");
  const args = rest.filter((a) => a !== "--json" && a !== "--move");
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
  if (cmd === "clear") {
    clearCurrentProject();
    console.log("project → (none)");
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
  if (cmd === "storage") {
    const slug = args[0] || currentProjectSlug();
    if (!slug) {
      console.error("no project selected");
      process.exit(1);
    }
    const s = projectStoragePaths(slug) || { slug, local: `sessions/pstack/${slug}`, ipfs: null };
    const prefs = loadProjectStoragePrefs();
    if (json) console.log(JSON.stringify({ ...s, ipfsEnabled: prefs.ipfsEnabled }, null, 2));
    else {
      console.log(`project     ${s.slug}`);
      console.log(`local       ${s.local}`);
      console.log(`ipfs        ${s.ipfs || "(none)"}`);
      console.log(`ipfs setting ${prefs.ipfsEnabled ? "on" : "off (local default)"}`);
    }
    return;
  }
  if (cmd === "ipfs") {
    const sub = args[0] || "status";
    if (sub === "on") {
      const p = saveProjectStoragePrefs({ ipfsEnabled: true });
      console.log("IPFS storage → on (local remains default desk path; pin + storage-set to attach CIDs)");
      console.log(JSON.stringify(p));
      return;
    }
    if (sub === "off") {
      const p = saveProjectStoragePrefs({ ipfsEnabled: false });
      console.log("IPFS storage → off (local only)");
      console.log(JSON.stringify(p));
      return;
    }
    const p = loadProjectStoragePrefs();
    console.log(`IPFS storage  ${p.ipfsEnabled ? "on" : "off"}  (local is always on)`);
    return;
  }
  if (cmd === "storage-set") {
    const slug = args[0];
    const uri = args[1];
    if (!slug || !uri) usage();
    const next = setProjectIpfsUri(slug, uri);
    console.log(`storage ${slug}`);
    console.log(`  local  ${next.local}`);
    console.log(`  ipfs   ${next.ipfsUri}`);
    return;
  }
  if (cmd === "roster" || cmd === "crew") {
    const slug = args[0] || currentProjectSlug();
    const r = loadRoster(slug);
    if (json) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(`project ${r.project || "(none)"} (crew)`);
      console.log(`heroes (${r.heroes.length}): ${r.heroes.join(", ") || "(empty)"}`);
    }
    return;
  }
  if (cmd === "roster-add" || cmd === "crew-add") {
    const hero = args[0];
    const slug = args[1] || currentProjectSlug();
    if (!hero || !slug) usage();
    try {
      const r = rosterAdd(hero, slug, { move });
      console.log(`crew ${slug}: ${r.heroes.join(", ")}`);
    } catch (e) {
      if (e?.code === "CREW_CONFLICT") {
        console.error(e.message);
        process.exit(2);
      }
      throw e;
    }
    return;
  }
  if (cmd === "roster-remove" || cmd === "crew-remove") {
    const hero = args[0];
    const slug = args[1] || currentProjectSlug();
    if (!hero || !slug) usage();
    const r = rosterRemove(hero, slug);
    console.log(`crew ${slug}: ${r.heroes.join(", ") || "(empty)"}`);
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
