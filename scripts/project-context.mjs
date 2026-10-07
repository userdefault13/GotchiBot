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
 *     dossier.json · roster.json (id + per-project role; array order is the avatar roster display order) · mail.json · meetings/ · passoff/ · notes/ · tickets/ · jobs/
 *
 *   node scripts/project-context.mjs current [--json]
 *   node scripts/project-context.mjs set <slug> [--pointer-only]
 *   node scripts/project-context.mjs root [<slug>]
 *   node scripts/project-context.mjs roster [<slug>] [--json]
 *   node scripts/project-context.mjs roster-add <hero> [<slug>]
 *   node scripts/project-context.mjs mail show|set [<slug>] [--address …] [--inbox-id …]
 *   node scripts/project-context.mjs repo show|clear [<slug>] [--json]
 *   node scripts/project-context.mjs repo set <path|git-url|owner/repo> [<slug>]
 *   node scripts/project-context.mjs ensure [<slug>]
 */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";
import { projectRoomHasFiles } from "../services/gotchibot-api/projects.mjs";
import { publishProjectWrite } from "./hub-project-sync.mjs";
import { assertChatDeskAllowed, deskAuthHeaders, readHubPin } from "./infra-client.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Sibling checkouts (~/Dev) — where bare repo names and URL checkouts are looked up. */
const DEV_ROOT = dirname(ROOT);
const SESSIONS = join(ROOT, "sessions");
const PSTACK_ROOT = join(SESSIONS, "pstack");
const DOSSIER_CURRENT = join(SESSIONS, ".pstack-dossier-current");
const PROJECT_CURRENT = join(SESSIONS, ".project-current");
const STORAGE_PREFS = join(SESSIONS, ".project-storage.json");

/** Desk default: local only. IPFS is opt-in via cockpit Settings. */
export function loadProjectStoragePrefs() {
  try {
    const j = JSON.parse(readFileSync(STORAGE_PREFS, "utf8"));
    return { ipfsEnabled: j.ipfsEnabled === true };
  } catch {
    return { ipfsEnabled: false };
  }
}

export function saveProjectStoragePrefs(patch = {}) {
  mkdirSync(SESSIONS, { recursive: true });
  const next = { ...loadProjectStoragePrefs(), ...patch };
  next.ipfsEnabled = next.ipfsEnabled === true;
  next.updatedAt = new Date().toISOString();
  writeFileSync(STORAGE_PREFS, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function isIpfsStorageEnabled() {
  return loadProjectStoragePrefs().ipfsEnabled === true;
}

export function slugOk(slug) {
  return typeof slug === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(slug);
}

export function currentProjectSlug() {
  // A command run from a project's chat on the Hub carries that chat's project
  // (set by .opencode/plugins/gotchi-shell-env.js): the Hub machine's own
  // current project is some other desk's choice.
  const env = String(process.env.GOTCHIBOT_PROJECT || "").trim();
  if (env && slugOk(env)) return env;
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

/** True for leftover nest/smoke dossiers — never auto-select as desk current. */
export function isSmokeProjectSlug(slug) {
  if (!slug) return false;
  return /smoke/i.test(String(slug));
}

function dossierExists(slug, pstackRoot = PSTACK_ROOT) {
  if (!slugOk(slug)) return false;
  try {
    return existsSync(join(pstackRoot, slug));
  } catch {
    return false;
  }
}

function sessionPaths(sessionsDir = null) {
  const sessions = sessionsDir || SESSIONS;
  return {
    sessions,
    pstack: join(sessions, "pstack"),
    dossierCurrent: join(sessions, ".pstack-dossier-current"),
    projectCurrent: join(sessions, ".project-current"),
    checkpoint: join(sessions, ".checkpoint-local.json"),
  };
}

function readPointerAt(paths) {
  for (const path of [paths.dossierCurrent, paths.projectCurrent]) {
    try {
      const s = readFileSync(path, "utf8").trim();
      if (s && slugOk(s)) return s;
    } catch {
      /* try next */
    }
  }
  return null;
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function reconnectProjectDb(slug, { sessionsDir = null, deskRoot = ROOT } = {}) {
  if (!slugOk(slug)) return null;
  const paths = sessionPaths(sessionsDir);
  const root = join(paths.pstack, slug);

  const db = readJsonFile(join(root, "db.json"));
  if (typeof db?.directory === "string") {
    const dir = db.directory.trim();
    if (dir && dir !== deskRoot) return dir;
  }

  const repo = readJsonFile(join(root, "repo.json"));
  if (repo?.project && repo.project !== slug) return null;
  if (typeof repo?.path === "string") {
    const repoDir = repo.path.trim();
    if (repoDir && repoDir !== deskRoot) return repoDir;
  }

  return null;
}

/** True when sessions/.hub.json (or GOTCHIBOT_HUB_PIN) is a pin object. */
export function deskHubPinPresent(env = process.env) {
  try {
    if (env !== process.env) {
      const override = String(env.GOTCHIBOT_HUB_PIN || "").trim();
      if (!override) return false;
      const pin = JSON.parse(readFileSync(resolve(override), "utf8"));
      return Boolean(pin && typeof pin === "object");
    }
    const pin = readHubPin();
    return Boolean(pin && typeof pin === "object");
  } catch {
    return false;
  }
}

/** Slugs from GET /api/gotchibot/projects (`{ projects: [{ slug }] }`). */
export function slugsFromHubProjectsBody(body) {
  const projects = Array.isArray(body) ? body : body?.projects;
  if (!Array.isArray(projects)) return [];
  const out = [];
  const seen = new Set();
  for (const row of projects) {
    const slug = typeof row === "string" ? row : row?.slug;
    if (!slugOk(slug) || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

/** Local slugs first, then hub slugs not already listed. Invalid slugs dropped. */
export function unionProjectSlugs(local = [], hub = []) {
  return slugsFromHubProjectsBody([...(local || []), ...(hub || [])].map((s) => (typeof s === "string" ? s : s?.slug)));
}

/**
 * Hub portfolio when this desk is paired. No pin, or a failed GET, yields [].
 * Does not log the pin or the desk token.
 */
export async function listHubProjectSlugs({
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = 4000,
} = {}) {
  if (!deskHubPinPresent(env)) return [];
  let base;
  let headers;
  try {
    base = assertChatDeskAllowed(env).base;
    headers = deskAuthHeaders(env);
  } catch {
    return [];
  }
  try {
    const res = await fetchImpl(`${base}/api/gotchibot/projects`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) return [];
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      return [];
    }
    return slugsFromHubProjectsBody(json);
  } catch {
    return [];
  }
}

/**
 * Cockpit project rows. "Create new project…" stays an extra row, never the only one
 * once `slugs` is non-empty.
 */
export function projectMenuOptions(slugs, current = null) {
  const cur = current || null;
  return [
    ...slugs.map((slug) => ({
      key: `proj:${slug}`,
      label: slug === cur ? `${slug}  (current)` : slug,
    })),
    // A repo opens its project (or starts one for it); relinking the current
    // project's repo is a separate, clearly named item.
    { key: "repo-open", label: "Open a project from a GitHub repo…" },
    ...(cur ? [{ key: "repo", label: `Change ${cur}'s GitHub repo…` }] : []),
    { key: "new", label: "Create new project…" },
    { key: "back", label: "Back to cockpit" },
  ];
}

/**
 * Desk project for cockpit: a paired hub pointer (no local room) wins so picking
 * a hub project sticks. Otherwise Sepolia cart/local checkpoint, then a local
 * pointer. Ignores smoke-test leftovers. Syncs pointers when Sepolia wins.
 * `sessionsDir` / `paired` are for tests — production uses the desk sessions and pin.
 */
export function resolveDeskProjectSlug({ preferSepolia = true, sessionsDir = null, paired = null } = {}) {
  const paths = sessionPaths(sessionsDir);
  const localSlugs = new Set(listProjectSlugsOnDisk(paths.pstack));
  const acceptLocal = (slug) =>
    Boolean(slug && slugOk(slug) && !isSmokeProjectSlug(slug) && (localSlugs.has(slug) || dossierExists(slug, paths.pstack)));
  const isPaired = paired == null ? deskHubPinPresent() : Boolean(paired);
  const acceptRemote = (slug) => Boolean(isPaired && slug && slugOk(slug) && !isSmokeProjectSlug(slug));

  let sepoliaCurrent = null;
  if (preferSepolia) {
    try {
      if (existsSync(paths.checkpoint)) {
        const snap = JSON.parse(readFileSync(paths.checkpoint, "utf8"));
        const cur = snap?.gameState?.projects?.current;
        if (acceptLocal(cur)) sepoliaCurrent = String(cur);
      }
    } catch {
      /* no sepolia snapshot */
    }
  }

  const pointer = sessionsDir ? readPointerAt(paths) : currentProjectSlug();
  if (pointer && isSmokeProjectSlug(pointer)) {
    if (sessionsDir) {
      for (const path of [paths.dossierCurrent, paths.projectCurrent]) {
        try {
          if (existsSync(path)) writeFileSync(path, "", "utf8");
        } catch {
          /* ignore */
        }
      }
    } else {
      clearCurrentProject();
    }
  }

  // Hub slug with no local room: keep the pointer. Do not sync Sepolia over it
  // and do not create a blank room.
  const pointerRemote = Boolean(pointer && acceptRemote(pointer) && !acceptLocal(pointer));
  const chosen = pointerRemote ? pointer : sepoliaCurrent || (acceptLocal(pointer) ? pointer : null);
  if (chosen && chosen !== pointer && !pointerRemote) {
    try {
      setCurrentProject(chosen, {
        ensureDirs: !sessionsDir,
        sessionsDir: sessionsDir || undefined,
      });
    } catch {
      /* read-only ok */
    }
  }
  return chosen;
}

/**
 * Keep both pointers identical so passoff / pstack / cockpit agree.
 * `ensureDirs: false` writes the pointer only — used when picking a hub project
 * that has no local room. Default still creates the sealed room.
 */
export function setCurrentProject(slug, { ensureDirs = true, sessionsDir = null } = {}) {
  if (!slugOk(slug)) throw new Error(`invalid project slug: ${slug}`);
  const paths = sessionPaths(sessionsDir);
  mkdirSync(paths.sessions, { recursive: true });
  writeFileSync(paths.dossierCurrent, `${slug}\n`, "utf8");
  writeFileSync(paths.projectCurrent, `${slug}\n`, "utf8");
  if (ensureDirs) {
    if (sessionsDir) throw new Error("refusing to create a project room outside the desk sessions directory");
    ensureProjectDirs(slug);
  }
  reconnectProjectDb(slug, { sessionsDir });
  if (!sessionsDir) syncDeskPanes();
  return slug;
}

/**
 * Tell a running desk its project changed so every pane follows (Files, Terminal,
 * a local chat — orchestrator-layout.sh project-sync; the Hub chat reopens by
 * itself). Detached and best-effort; skipped under node --test or with no tmux.
 */
function syncDeskPanes() {
  if (process.env.NODE_TEST_CONTEXT || process.execArgv.includes("--test") || process.env.GOTCHIBOT_NO_PANE_SYNC === "1") return;
  try {
    const child = spawn("bash", [join(ROOT, "scripts", "orchestrator-layout.sh"), "project-sync"], { cwd: ROOT, detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* no desk running */
  }
}

/** Clear desk project selection (new nest install / fresh onboard / cart transfer). */
export function clearCurrentProject() {
  for (const path of [DOSSIER_CURRENT, PROJECT_CURRENT]) {
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
  publishProjectWrite(mailPath(slug), { root: ROOT });
  return next;
}

export function repoPath(slug = currentProjectSlug()) {
  const root = projectRoot(slug);
  return root ? join(root, "repo.json") : null;
}

/** Connected code repo for a project, or null when none is connected. */
/** "owner/repo" from a GitHub remote URL (https or ssh), lowercased; null if not GitHub. */
export function githubFullName(remote) {
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(String(remote || "").trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/** Project slug for a repo with no project yet: its name, slug-safe ("WondrStack" → "wondrstack"). */
export function slugForRepo(fullName) {
  const name = String(fullName || "").split("/").pop() || "";
  const s = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 64);
  return slugOk(s) ? s : null;
}

/** Other projects whose repo is this GitHub repo (by remote owner/repo). */
export function projectsUsingRepo(fullName, { exclude = null } = {}) {
  const want = String(fullName || "").toLowerCase();
  if (!want) return [];
  let slugs = [];
  try {
    slugs = readdirSync(PSTACK_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && slugOk(d.name) && d.name !== exclude)
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
  return slugs.filter((s) => githubFullName(loadRepo(s)?.remote) === want);
}

export function loadRepo(slug = currentProjectSlug()) {
  const rp = repoPath(slug);
  if (!rp || !existsSync(rp)) return null;
  try {
    return JSON.parse(readFileSync(rp, "utf8"));
  } catch {
    return null;
  }
}

function gitOut(cwd, args) {
  const r = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return r.status === 0 ? String(r.stdout || "").trim() || null : null;
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isGitUrl(s) {
  return /^(https?:\/\/|ssh:\/\/|git:\/\/|[\w.-]+@[\w.-]+:)/.test(s);
}

/** https://user:token@host/… must never land in repo.json. */
function stripUrlCredentials(url) {
  return String(url || "").replace(/^(https?:\/\/)[^@/]+@/i, "$1");
}

/** Comparable form of a remote: host/owner/repo, lowercase, no scheme/user/.git. */
function remoteKey(url) {
  return String(url || "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z+]+:\/\//, "")
    .replace(/^[^@/]+@/, "")
    .replace(/:(?!\d)/, "/")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
}

function repoNameFromRemote(url) {
  return (
    String(url || "")
      .trim()
      .replace(/\.git$/, "")
      .replace(/\/+$/, "")
      .split(/[/:]/)
      .pop() || null
  );
}

function describeCheckout(dir) {
  const top = gitOut(dir, ["rev-parse", "--show-toplevel"]);
  if (!top) return null;
  const origin = gitOut(top, ["remote", "get-url", "origin"]);
  return {
    path: top,
    remote: origin ? stripUrlCredentials(origin) : null,
    branch: gitOut(top, ["rev-parse", "--abbrev-ref", "HEAD"]),
  };
}

/**
 * Resolve what the user typed into a repo binding:
 *   local folder (~/Dev/x, absolute, relative, or a bare name under ~/Dev) → must be a git checkout
 *   git URL or owner/repo (GitHub) → remote, plus the ~/Dev checkout when its origin matches
 */
export function resolveRepoTarget(input, { cwd = process.cwd() } = {}) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("repo path, git URL, or owner/repo required");

  const expanded = raw.replace(/^~(?=$|\/)/, homedir());
  const bare = !/[/~]/.test(raw) && raw !== "." && raw !== "..";
  const candidates = bare ? [join(DEV_ROOT, raw), resolve(cwd, raw)] : [resolve(cwd, expanded)];
  const dir = isGitUrl(raw) ? null : candidates.find(isDir);
  if (dir) {
    const checkout = describeCheckout(dir);
    if (!checkout) throw new Error(`${dir} is not a git repo`);
    return { name: checkout.path.split("/").pop(), ...checkout };
  }

  let remote = null;
  if (isGitUrl(raw)) remote = stripUrlCredentials(raw);
  else if (/^[\w.-]+\/[\w.-]+$/.test(raw)) remote = `https://github.com/${raw.replace(/\.git$/, "")}.git`;
  if (!remote) throw new Error(`no such folder, git URL, or owner/repo: ${raw}`);

  const name = repoNameFromRemote(remote);
  const local = name ? join(DEV_ROOT, name) : null;
  const checkout = local && isDir(local) ? describeCheckout(local) : null;
  if (checkout?.remote && remoteKey(checkout.remote) === remoteKey(remote)) {
    return { name, path: checkout.path, remote, branch: checkout.branch };
  }
  return { name, path: null, remote, branch: null };
}

/** A GitHub repo already linked to another project (one repo, one project). */
export class RepoTakenError extends Error {
  constructor(fullName, owners) {
    super(`${fullName} is already the repo of ${owners.join(", ")} — open that project, or move the link`);
    this.code = "REPO_TAKEN";
    this.owners = owners;
  }
}

/**
 * Link a repo to a project. One GitHub repo belongs to one project: a repo
 * another project has throws RepoTakenError, unless opts.move unlinks it there.
 */
export function connectRepo(input, slug = currentProjectSlug(), opts = {}) {
  if (!slug) throw new Error("no project selected");
  const target = resolveRepoTarget(input, opts);
  const fullName = githubFullName(target.remote);
  const owners = fullName ? projectsUsingRepo(fullName, { exclude: slug }) : [];
  if (owners.length && !opts.move) throw new RepoTakenError(fullName, owners);
  for (const o of owners) disconnectRepo(o);
  ensureProjectDirs(slug);
  const next = {
    project: slug,
    ...target,
    connectedAt: new Date().toISOString(),
  };
  writeFileSync(repoPath(slug), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function disconnectRepo(slug = currentProjectSlug()) {
  const rp = repoPath(slug);
  if (rp && existsSync(rp)) unlinkSync(rp);
}

export function formatRepo(repo) {
  if (!repo) return "(none)";
  const where = repo.path ? repo.path.replace(homedir(), "~") : "no local checkout";
  const branch = repo.branch ? ` @ ${repo.branch}` : "";
  return `${repo.name || "repo"} · ${where}${branch}`;
}

export function ensureProjectDirs(slug = currentProjectSlug()) {
  if (!slug) throw new Error("no project selected — cockpit → Select new project");
  const root = projectRoot(slug);
  mkdirSync(join(root, "meetings"), { recursive: true });
  mkdirSync(join(root, "passoff"), { recursive: true });
  mkdirSync(join(root, "notes"), { recursive: true });
  mkdirSync(join(root, "desks"), { recursive: true });
  mkdirSync(join(root, "tickets"), { recursive: true });
  mkdirSync(join(root, "jobs"), { recursive: true });
  mkdirSync(join(root, "inbox"), { recursive: true });
  const rp = rosterPath(slug);
  if (!existsSync(rp)) {
    writeFileSync(
      rp,
      `${JSON.stringify(
        {
          project: slug,
          workbench: WORKBENCH_VERSION,
          heroes: [],
          updatedAt: new Date().toISOString(),
          note: ROSTER_NOTE,
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
  seedProjectRoster(slug);
  return root;
}

export function listProjectSlugsOnDisk(pstackRoot = PSTACK_ROOT) {
  if (!existsSync(pstackRoot)) return [];
  try {
    return readdirSync(pstackRoot)
      .filter((name) => {
        try {
          // Same predicate the Hub uses, so the phone and `project use` agree on
          // which rooms exist. pstackRoot is honoured so this stays testable.
          return projectRoomHasFiles(name, (slug, f) => existsSync(join(pstackRoot, slug, f)));
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
  const localAbs = join(PSTACK_ROOT, slug);
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
  const tip = join(PSTACK_ROOT, slug, "storage.json");
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

const HERO_ID_RE = /^(owned|starter|rental)-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ROSTER_NOTE =
  "Fresh copy of the main roster. role is this project's assignment; null means unassigned. The same gotchi may hold a different role in another project.";

/** Worker slot on a template hero. Absent on a plain gotchi row. Never invents an id. */
export function normalizeRosterWorker(worker) {
  if (typeof worker === "string") {
    const id = worker.trim();
    if (!id || id === "unbound") return { status: "unbound", gotchiId: null };
    return { status: "bound", gotchiId: id };
  }
  if (!worker || typeof worker !== "object") return { status: "unbound", gotchiId: null };
  const raw = worker.gotchiId == null ? "" : String(worker.gotchiId).trim();
  if (!raw || worker.status === "unbound") return { status: "unbound", gotchiId: null };
  return { status: "bound", gotchiId: raw };
}

/** One roster row. A string entry is an id with no role stored yet. */
export function normalizeRosterHero(entry) {
  if (typeof entry === "string" && entry.trim()) return { id: entry.trim(), role: null };
  if (entry && typeof entry === "object" && entry.id) {
    const raw = entry.role == null ? "" : String(entry.role).trim();
    const role = !raw || raw === "none" || raw === "unassigned" ? null : raw;
    const hero = { id: String(entry.id), role };
    if (typeof entry.name === "string" && entry.name.trim()) hero.name = entry.name.trim();
    if (entry.worker !== undefined && entry.worker !== null) hero.worker = normalizeRosterWorker(entry.worker);
    if (entry.avatar && typeof entry.avatar === "object" && entry.avatar.path) {
      const ready = entry.avatar.ready === true;
      hero.avatar = { path: String(entry.avatar.path), ready, fallback: ready ? null : "glyph" };
    }
    return hero;
  }
  return null;
}

export function rosterHeroId(entry) {
  return normalizeRosterHero(entry)?.id || null;
}

/**
 * Stable display order. Ids listed in roster.json come first, in that sequence.
 * Anything not stored keeps its incoming order after those.
 */
export function orderByRosterIds(items, rosterIds, idOf = (item) => item?.id) {
  const list = Array.isArray(items) ? items : [];
  const rank = new Map();
  for (const id of rosterIds || []) {
    if (id == null || id === "") continue;
    const key = String(id);
    if (!rank.has(key)) rank.set(key, rank.size);
  }
  if (!rank.size) return list.slice();
  return list
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const ka = String(idOf(a.item) ?? "");
      const kb = String(idOf(b.item) ?? "");
      const ra = rank.has(ka) ? rank.get(ka) : Number.MAX_SAFE_INTEGER;
      const rb = rank.has(kb) ? rank.get(kb) : Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb;
      return a.index - b.index;
    })
    .map((row) => row.item);
}

/** Move one roster row by delta (-1 up, +1 down). No-op at the ends or if the id is missing. Roles stay on the row. */
export function moveRosterHero(heroes, id, delta) {
  const list = normalizeRosterList(heroes);
  const step = Number(delta);
  if (!Number.isInteger(step) || step === 0) return list;
  const from = list.findIndex((h) => h.id === String(id));
  if (from < 0) return list;
  return placeRosterHero(list, id, from + 1 + step);
}

function normalizeRosterList(heroes) {
  const list = [];
  for (const entry of heroes || []) {
    const hero = normalizeRosterHero(entry);
    if (hero?.id) list.push(hero);
  }
  return list;
}

/**
 * Move one roster row to a 1-based position (the number on the reorder screen).
 * Out of range, an unknown id, or the row's current position leaves the order
 * unchanged. Roles stay on the row. Does not sort and does not consult the
 * avatar cache — the array you pass is the order you get back.
 */
export function placeRosterHero(heroes, id, position) {
  const list = normalizeRosterList(heroes);
  const dest = Number(position);
  if (!Number.isInteger(dest) || dest < 1 || dest > list.length) return list;
  const from = list.findIndex((h) => h.id === String(id));
  if (from < 0 || from === dest - 1) return list;
  const [row] = list.splice(from, 1);
  list.splice(dest - 1, 0, row);
  return list;
}

/** Ids of the user's cAavegotchis. This is the main roster a project copies. */
export function mainRosterIds() {
  try {
    const j = JSON.parse(readFileSync(join(SESSIONS, ".hero-agent-state.json"), "utf8"));
    return Object.keys(j)
      .filter((id) => HERO_ID_RE.test(id))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Keep roles already stored on this project. Add any main-roster gotchi that
 * is missing, unassigned. Does not copy fleet roles from agent-roles.json.
 */
export function mergeRosterHeroes(existing, mainIds) {
  const out = [];
  const seen = new Set();
  for (const entry of existing || []) {
    const hero = normalizeRosterHero(entry);
    if (!hero?.id || seen.has(hero.id)) continue;
    seen.add(hero.id);
    out.push(hero);
  }
  for (const id of mainIds || []) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, role: null });
  }
  return out;
}

function knownRole(role) {
  try {
    const playbooks = JSON.parse(readFileSync(join(ROOT, "config/agent-role-playbooks.json"), "utf8"));
    return Object.hasOwn(playbooks, role);
  } catch {
    return false;
  }
}

export function loadRoster(slug = currentProjectSlug()) {
  const rp = rosterPath(slug);
  if (!rp || !existsSync(rp)) {
    return { project: slug || null, heroes: [], updatedAt: null };
  }
  try {
    const j = JSON.parse(readFileSync(rp, "utf8"));
    const rows = mergeRosterHeroes(Array.isArray(j.heroes) ? j.heroes : [], []);
    const bench = benchOf({ heroes: rows, bench: j.bench });
    const heroes = rowsFromBench(rows, bench);
    return { project: j.project || slug, ...(j.workbench ? { workbench: j.workbench } : {}), heroes, bench, updatedAt: j.updatedAt || null, note: j.note };
  } catch {
    return { project: slug, heroes: [], updatedAt: null };
  }
}

export function saveRoster(roster, slug = currentProjectSlug()) {
  ensureProjectDirs(slug);
  const rp = rosterPath(slug);
  const rows = mergeRosterHeroes(roster.heroes || [], []);
  // An explicit bench wins; a roster saved without one (old callers that set
  // row roles) has its bench worked out from those roles.
  const bench = benchOf({ heroes: rows, bench: roster.bench });
  const body = {
    project: slug,
    ...(roster.workbench ? { workbench: roster.workbench } : {}),
    heroes: rowsFromBench(rows, bench),
    bench,
    updatedAt: new Date().toISOString(),
    note: roster.note || ROSTER_NOTE,
  };
  writeFileSync(rp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  publishProjectWrite(rp, { root: ROOT });
  // The open avatar pane paints sessions/.avatar-roster.json and only
  // rebuilds that cache when its fingerprint moves. Rewrite it from this
  // heroes array so the next tick (or USR1) draws the saved positions
  // without a desk restart. Pin stays pinned inside avatar-roster.
  refreshOpenAvatarStrip();
  return body;
}

function refreshOpenAvatarStrip() {
  if (process.execArgv.includes("--test") || process.env.NODE_TEST_CONTEXT != null) return;
  if (process.env.GOTCHIBOT_AVATAR_REFRESH === "0") return;
  try {
    spawnSync(process.execPath, [join(ROOT, "scripts/avatar-roster.mjs"), "--json"], {
      cwd: ROOT,
      stdio: "ignore",
      timeout: 20000,
    });
  } catch {
    /* pane refresh still re-reads roster.json */
  }
  try {
    const listed = spawnSync("pgrep", ["-f", "scripts/avatar-pane.sh"], {
      encoding: "utf8",
      timeout: 2000,
    });
    const self = String(listed.pid || "");
    for (const pid of String(listed.stdout || "").split(/\s+/)) {
      if (!/^\d+$/.test(pid) || pid === self) continue;
      try { process.kill(Number(pid), "SIGUSR1"); } catch { /* pane already gone */ }
    }
  } catch {
    /* no open pane */
  }
}

/** Fill this project with the main roster. Existing project roles stay. */
export function seedProjectRoster(slug = currentProjectSlug()) {
  if (!slug) return null;
  const rp = rosterPath(slug);
  const current = rp && existsSync(rp) ? loadRoster(slug) : { project: slug, heroes: [], note: ROSTER_NOTE };
  const heroes = mergeRosterHeroes(current.heroes, mainRosterIds());
  const same =
    heroes.length === current.heroes.length &&
    heroes.every((h, i) => h.id === current.heroes[i]?.id && h.role === current.heroes[i]?.role);
  if (same && rp && existsSync(rp)) return current;
  const dir = projectRoot(slug);
  mkdirSync(dir, { recursive: true });
  const body = {
    project: slug,
    ...(current.workbench ? { workbench: current.workbench } : {}),
    heroes,
    ...(current.bench ? { bench: current.bench } : {}),
    updatedAt: new Date().toISOString(),
    note: current.note || ROSTER_NOTE,
  };
  writeFileSync(join(dir, "roster.json"), `${JSON.stringify(body, null, 2)}\n`, "utf8");
  publishProjectWrite(join(dir, "roster.json"), { root: ROOT });
  return body;
}

export function rosterHas(heroId, slug = currentProjectSlug()) {
  if (!heroId) return false;
  const { heroes } = loadRoster(slug);
  if (!heroes.length) return true; // empty roster = not yet seeded; allow until the copy lands
  return heroes.some((h) => h.id === String(heroId));
}

export function rosterRole(heroId, slug = currentProjectSlug()) {
  const { heroes } = loadRoster(slug);
  return heroes.find((h) => h.id === String(heroId))?.role ?? null;
}

export function rosterAdd(heroId, slug = currentProjectSlug()) {
  if (!heroId) throw new Error("hero id required");
  ensureProjectDirs(slug);
  const r = loadRoster(slug);
  if (!r.heroes.some((h) => h.id === String(heroId))) r.heroes.push({ id: String(heroId), role: null });
  return saveRoster(r, slug);
}

/**
 * How many gotchis may hold a role in one workbench: the playbook's `seats`
 * (a number, or "many"), else 1. Roles are one seat unless a playbook says more.
 */
export function roleSeats(role) {
  try {
    const pb = JSON.parse(readFileSync(join(ROOT, "config/agent-role-playbooks.json"), "utf8"))[role];
    if (pb?.seats === "many") return Infinity;
    const n = Number(pb?.seats);
    return Number.isFinite(n) && n >= 1 ? n : 1;
  } catch {
    return 1;
  }
}

/**
 * Set this project's role for one gotchi. `none` clears it. A one-seat role
 * unseats whoever held it in this workbench (no duplicate roles); other
 * projects are untouched — each workbench seats its own team. The returned
 * roster carries `unseated`: the hero ids that lost the role here.
 */
export function rosterAssign(heroId, role, slug = currentProjectSlug()) {
  if (!heroId) throw new Error("hero id required");
  if (!slug) throw new Error("no project selected");
  const next = !role || role === "none" || role === "unassigned" ? null : String(role).trim();
  // "Gotchi X takes role R" is "X becomes the worker of hero R"; none frees X.
  if (!next) return { ...unbindWorker(String(heroId), slug), unseated: [] };
  return bindWorker(next, String(heroId), slug);
}

// ── bench: template heroes, each worked by a cAavegotchi ──
//
// roster.json `bench` is [{ hero: <template id>, worker: <gotchi id>|null }].
// The hero is the job (its playbook, its memory); the gotchi is the worker that
// runs it, and is swappable. A gotchi works at most one hero per workbench; a
// gotchi working nothing is in the pool. `heroes[].role` (gotchi rows) is worked
// out from the bench so readers of the old shape keep working. The orchestrator
// is desk-wide (the pinned gotchi) and never on a project bench.

/** Normalize a bench list: known shape, one entry per worker, orchestrator dropped. */
export function normalizeBench(list) {
  const out = [];
  const workers = new Set();
  for (const e of Array.isArray(list) ? list : []) {
    const hero = String(e?.hero || "").trim();
    if (!hero || hero === "orchestrator" || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(hero)) continue;
    let worker = e?.worker == null ? null : String(e.worker).trim() || null;
    if (worker && (!HERO_ID_RE.test(worker) || workers.has(worker))) worker = null;
    if (worker) workers.add(worker);
    if (!worker && out.some((x) => x.hero === hero && !x.worker)) continue;
    out.push({ hero, worker });
  }
  return out;
}

/** A roster's bench: stored, or (rooms from before heroes) one per seated gotchi. */
export function benchOf(roster) {
  if (Array.isArray(roster?.bench)) return normalizeBench(roster.bench);
  const rows = mergeRosterHeroes(roster?.heroes || [], []);
  return normalizeBench(rows.filter((h) => h.role && HERO_ID_RE.test(h.id)).map((h) => ({ hero: h.role, worker: h.id })));
}

/** Gotchi rows with `role` = the hero each one works (null in the pool). */
function rowsFromBench(rows, bench) {
  const working = new Map(bench.filter((e) => e.worker).map((e) => [e.worker, e.hero]));
  const out = rows.map((h) => (HERO_ID_RE.test(h.id) ? { ...h, role: working.get(h.id) || null } : h));
  for (const [worker, hero] of working) if (!out.some((h) => h.id === worker)) out.push({ id: worker, role: hero });
  return out;
}

function saveBench(r, bench, slug) {
  return saveRoster({ ...r, bench }, slug);
}

/** This workbench's heroes: [{ hero, worker|null }], the desk-wide orchestrator first. */
export function benchHeroes(slug = currentProjectSlug(), { roles = globalRoles() } = {}) {
  const orchWorker = Object.keys(roles).find((id) => id !== "orchestrator" && roles[id] === "orchestrator") || null;
  const out = [{ hero: "orchestrator", worker: orchWorker, deskWide: true }];
  if (!slug) return out;
  for (const e of loadRoster(slug).bench) out.push({ ...e });
  return out;
}

/** Gotchis on this workbench working no hero (the orchestrator's gotchi works the desk). */
export function benchPool(slug = currentProjectSlug(), { roles = globalRoles() } = {}) {
  const r = loadRoster(slug);
  const busy = new Set(r.bench.map((e) => e.worker).filter(Boolean));
  for (const [id, role] of Object.entries(roles)) if (role === "orchestrator") busy.add(id);
  return r.heroes.filter((h) => HERO_ID_RE.test(h.id) && !busy.has(h.id)).map((h) => h.id);
}

function checkHeroId(hero) {
  const id = String(hero || "").trim();
  if (!id) throw new Error("hero (template id) required");
  if (id === "orchestrator") throw new Error("the orchestrator is desk-wide — change it with the orch pin, not a workbench");
  if (!knownRole(id)) throw new Error(`unknown hero template: ${id}`);
  return id;
}

/** Put a template hero on this workbench, with no worker yet. */
export function addHero(hero, slug = currentProjectSlug()) {
  if (!slug) throw new Error("no project selected");
  const id = checkHeroId(hero);
  ensureProjectDirs(slug);
  const r = loadRoster(slug);
  const bench = [...r.bench];
  if (!bench.some((e) => e.hero === id)) bench.push({ hero: id, worker: null });
  return saveBench(r, bench, slug);
}

/**
 * Make `gotchi` the worker of `hero` here (adds the hero when missing). The
 * gotchi leaves any other hero it worked here (`left`); a one-seat hero's
 * previous worker goes back to the pool (`unseated`).
 */
export function bindWorker(hero, gotchi, slug = currentProjectSlug()) {
  if (!slug) throw new Error("no project selected");
  const id = checkHeroId(hero);
  const gid = String(gotchi || "").trim();
  if (!HERO_ID_RE.test(gid)) throw new Error(`not a cAavegotchi id: ${gotchi}`);
  ensureProjectDirs(slug);
  const r = loadRoster(slug);
  let bench = r.bench.map((e) => ({ ...e }));
  let left = null;
  const prev = bench.find((e) => e.worker === gid);
  if (prev && prev.hero === id) return { ...saveBench(r, bench, slug), unseated: [], left: null };
  if (prev) {
    left = prev.hero;
    prev.worker = null;
  }
  const mine = bench.filter((e) => e.hero === id);
  const unseated = [];
  const free = mine.find((e) => !e.worker);
  if (free) free.worker = gid;
  else if (mine.length < roleSeats(id)) bench.push({ hero: id, worker: gid });
  else {
    // Full: the longest-held seat changes hands.
    unseated.push(mine[0].worker);
    mine[0].worker = gid;
  }
  bench = normalizeBench(bench);
  const saved = saveBench(r, bench, slug);
  return { ...saved, unseated, left };
}

/** Free a hero's worker (by hero id) or a gotchi (by gotchi id). The hero stays, unbound. */
export function unbindWorker(heroOrGotchi, slug = currentProjectSlug()) {
  if (!slug) throw new Error("no project selected");
  const key = String(heroOrGotchi || "").trim();
  if (!key) throw new Error("hero or gotchi id required");
  ensureProjectDirs(slug);
  const r = loadRoster(slug);
  const byGotchi = HERO_ID_RE.test(key);
  const bench = r.bench.map((e) => ((byGotchi ? e.worker === key : e.hero === key) ? { ...e, worker: null } : e));
  return saveBench(r, normalizeBench(bench), slug);
}

/** Take a hero off this workbench; its worker goes back to the pool. */
export function removeHero(hero, slug = currentProjectSlug()) {
  if (!slug) throw new Error("no project selected");
  const r = loadRoster(slug);
  return saveBench(r, r.bench.filter((e) => e.hero !== String(hero)), slug);
}

// ── workbench: each project's own copy of the main roster, with its own roles ──

/**
 * roster.json carries `workbench: 1` once it is the project's role table. A new
 * project starts as a blank workbench (every gotchi available, no roles). A room
 * from before workbenches is migrated once with today's global team, so existing
 * projects keep their roles.
 */
export const WORKBENCH_VERSION = 1;

function globalRoles(root = ROOT) {
  try {
    return JSON.parse(readFileSync(join(root, "config", "agent-roles.json"), "utf8")) || {};
  } catch {
    return {};
  }
}

/** Is this project's roster a workbench (its own role table)? */
export function isWorkbench(slug = currentProjectSlug()) {
  if (!slug) return false;
  return Number(loadRoster(slug).workbench) >= WORKBENCH_VERSION;
}

/**
 * One-time upgrade of a pre-workbench room: every unassigned gotchi takes its
 * current global role (the orchestrator stays desk-wide, never copied), and the
 * room is marked a workbench. Roles already set on this project are kept.
 * Returns true when it migrated.
 */
export function migrateWorkbench(slug = currentProjectSlug(), { roles = globalRoles() } = {}) {
  if (!slug) return false;
  const rp = rosterPath(slug);
  if (!rp || !existsSync(rp)) return false;
  const r = loadRoster(slug);
  if (Number(r.workbench) >= WORKBENCH_VERSION) return false;
  const heroes = mergeRosterHeroes(r.heroes, mainRosterIds()).map((h) => {
    if (h.role) return h;
    const g = roles[h.id];
    return g && g !== "orchestrator" ? { ...h, role: g } : h;
  });
  saveRoster({ ...r, bench: undefined, workbench: WORKBENCH_VERSION, heroes }, slug);
  return true;
}

/**
 * hero → role for a project, the shape config/agent-roles.json has, so every
 * reader can swap `readJson(agent-roles.json)` for this. The orchestrator is
 * desk-wide (main roster) and appears in every project; every other role comes
 * from the project's workbench. No project, or a room not yet a workbench (and
 * not migratable), reads the global file as before.
 */
export function projectRoles(slug = currentProjectSlug(), { roles = globalRoles(), migrate = true } = {}) {
  if (!slug) return roles;
  if (migrate) {
    try {
      migrateWorkbench(slug, { roles });
    } catch {
      /* read-only room: fall through */
    }
  }
  const r = loadRoster(slug);
  if (!(Number(r.workbench) >= WORKBENCH_VERSION)) return roles;
  const out = {};
  for (const [id, role] of Object.entries(roles)) if (role === "orchestrator") out[id] = role;
  for (const h of r.heroes) if (h.role && h.role !== "orchestrator") out[h.id] = h.role;
  return out;
}

/**
 * One line telling a bot its role for this piece of work — roles differ per
 * project, so every consult/passoff carries it rather than the bot's workspace.
 */
export function roleBrief(heroId, slug = currentProjectSlug()) {
  if (!slug || !heroId) return "";
  const role = heroRole(heroId, slug);
  if (!role) return `[project ${slug} · you have no role here yet — help as a generalist and say so]`;
  let summary = "";
  try {
    const pb = JSON.parse(readFileSync(join(ROOT, "config", "agent-role-playbooks.json"), "utf8"))[role];
    summary = String(pb?.summary || "").replace(/\s+/g, " ").trim().slice(0, 220);
  } catch {
    /* role without a playbook */
  }
  return `[project ${slug} · you are the ${role}${summary ? ` — ${summary}` : ""}]`;
}

/**
 * One gotchi's role in every project room on this desk: [{ project, role|null }].
 * The fleet sync renders a bot's workspace from this (one role everywhere → that
 * role's template; different roles → a generic workspace, role per task).
 */
export function heroRolesByProject(heroId) {
  if (!heroId) return [];
  let slugs = [];
  try {
    slugs = readdirSync(PSTACK_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && slugOk(d.name) && existsSync(join(PSTACK_ROOT, d.name, "roster.json")))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
  const out = [];
  for (const slug of slugs) {
    const roles = projectRoles(slug);
    out.push({ project: slug, role: roles[String(heroId)] || null });
  }
  return out;
}

/** The project role of one hero (orchestrator desk-wide), or null when unassigned. */
export function heroRole(heroId, slug = currentProjectSlug()) {
  if (!heroId) return null;
  return projectRoles(slug)[String(heroId)] || null;
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
  project-context current [--json] [--resolve|--desk]
  project-context set <slug> [--pointer-only]
  project-context clear
  project-context root [<slug>]
  project-context storage [<slug>] [--json]
  project-context storage-set <slug> <ipfsUri|cid>
  project-context ipfs [on|off|status]
  project-context roster [<slug>] [--json]
  project-context roster-add <hero> [<slug>]
  project-context roster-assign <hero> <role|none> [<slug>]
  project-context heroes [list] [<slug>] [--json]
  project-context heroes add <template> [<slug>]
  project-context heroes bind <template> <gotchi> [<slug>]
  project-context heroes unbind <template|gotchi> [<slug>]
  project-context heroes remove <template> [<slug>]
  project-context mail show [<slug>] [--json]
  project-context mail set [<slug>] --address <email> [--inbox-id <id>]
  project-context repo show|clear [<slug>] [--json]
  project-context repo set <path|git-url|owner/repo> [<slug>]
  project-context ensure [<slug>]`);
  process.exit(2);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const json = rest.includes("--json");
  const args = rest.filter((a) => a !== "--json");
  if (!cmd) usage();

  if (cmd === "current") {
    const resolve = args.includes("--resolve") || args.includes("--desk");
    const slug = resolve ? resolveDeskProjectSlug() : currentProjectSlug();
    if (json) console.log(JSON.stringify({ project: slug }, null, 2));
    else console.log(slug || "");
    return;
  }
  if (cmd === "set") {
    const pointerOnly = args.includes("--pointer-only");
    const slug = args.find((a) => a !== "--pointer-only");
    if (!slug) usage();
    setCurrentProject(slug, { ensureDirs: !pointerOnly });
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
  if (cmd === "roster") {
    const slug = args[0] || currentProjectSlug();
    const r = loadRoster(slug);
    if (json) console.log(JSON.stringify(r, null, 2));
    else {
      const assigned = r.heroes.filter((h) => h.role);
      console.log(`project ${r.project || "(none)"}`);
      console.log(`heroes ${r.heroes.length} · assigned ${assigned.length}`);
      for (const h of r.heroes) console.log(`  ${h.id}  ${h.role || "unassigned"}`);
    }
    return;
  }
  if (cmd === "roster-add") {
    const hero = args[0];
    const slug = args[1] || currentProjectSlug();
    if (!hero || !slug) usage();
    const r = rosterAdd(hero, slug);
    console.log(`roster ${slug}: ${r.heroes.length} heroes`);
    return;
  }
  if (cmd === "roster-assign") {
    const hero = args[0];
    const role = args[1];
    const slug = args[2] || currentProjectSlug();
    if (!hero || !role || !slug) usage();
    const r = rosterAssign(hero, role, slug);
    const row = r.heroes.find((h) => h.id === hero);
    console.log(`roster ${slug}: ${hero} → ${row?.role || "unassigned"}${r.unseated?.length ? ` · unseated ${r.unseated.join(", ")}` : ""}`);
    return;
  }
  if (cmd === "heroes") {
    const verbs = new Set(["list", "add", "bind", "unbind", "remove"]);
    const sub = verbs.has(args[0]) ? args[0] : "list";
    const a = verbs.has(args[0]) ? args.slice(1) : args;
    const need = { list: 0, add: 1, bind: 2, unbind: 1, remove: 1 }[sub];
    const slug = a[need] || currentProjectSlug();
    if (!slug || a.length < need) usage();
    if (sub === "add") addHero(a[0], slug);
    if (sub === "unbind") unbindWorker(a[0], slug);
    if (sub === "remove") removeHero(a[0], slug);
    if (sub === "bind") {
      const r = bindWorker(a[0], a[1], slug);
      if (r.left) console.log(`  ${a[1]} left ${r.left} (now unbound)`);
      if (r.unseated.length) console.log(`  ${r.unseated.join(", ")} back to the pool`);
    }
    const heroes = benchHeroes(slug);
    const pool = benchPool(slug);
    if (json) {
      console.log(JSON.stringify({ project: slug, heroes, pool }, null, 2));
      return;
    }
    console.log(`project ${slug} · heroes ${heroes.length} · pool ${pool.length}`);
    for (const h of heroes) {
      console.log(`  ${h.hero.padEnd(24)} ${h.worker ? `worked by ${h.worker}` : "needs a worker"}${h.deskWide ? "  (desk-wide)" : ""}`);
    }
    if (pool.length) console.log(`  pool: ${pool.join(", ")}`);
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
  if (cmd === "repo") {
    const sub = args[0] || "show";
    if (sub === "set") {
      const target = args[1];
      const slug = args[2] || currentProjectSlug();
      if (!target) usage();
      if (!slug) {
        console.error("no project selected");
        process.exit(1);
      }
      // One repo, one project: --move takes it from the project that has it.
      const r = connectRepo(target, slug, { move: args.includes("--move") });
      if (json) console.log(JSON.stringify(r, null, 2));
      else console.log(`repo → ${slug}  ${formatRepo(r)}${r.remote ? `  (${r.remote})` : ""}`);
      return;
    }
    const slug = args[1] || currentProjectSlug();
    if (!slug) {
      console.error("no project selected");
      process.exit(1);
    }
    if (sub === "clear") {
      disconnectRepo(slug);
      console.log(`repo → ${slug}  (none)`);
      return;
    }
    if (sub === "show") {
      const r = loadRepo(slug);
      if (json) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(`project  ${slug}`);
        console.log(`repo     ${formatRepo(r)}`);
        if (r?.remote) console.log(`remote   ${r.remote}`);
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
