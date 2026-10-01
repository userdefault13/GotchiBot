/**
 * Read-only project portfolio for the phone app.
 *
 * Source of truth is the Hub's own repo tree (sessions/pstack/<slug>/ —
 * dossier, roster, kanban, status.md) plus the hero caches the desk keeps
 * (sessions/.hero-agent-state.json, config/agent-roles.json,
 * sessions/.avatars/<hero>.svg). Nothing here writes.
 *
 * Those files live on the desk, not the Hub, so the desk pushes the same
 * whitelisted files (collectProjectSnapshot → POST /projects/push) and the Hub
 * renders them through this module unchanged.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const HERO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KANBAN_COLUMNS = ["backlog", "todo", "doing", "review", "done"];
const MAX_CARDS = 60;

export function projectSlugOk(slug) {
  return typeof slug === "string" && SLUG_RE.test(slug);
}

export function heroIdOk(id) {
  return typeof id === "string" && HERO_RE.test(id);
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function mtimeIso(path) {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}

function latestIso(...values) {
  let best = null;
  for (const v of values) {
    if (!v) continue;
    const t = new Date(v).getTime();
    if (Number.isNaN(t)) continue;
    if (best == null || t > best) best = t;
  }
  return best == null ? null : new Date(best).toISOString();
}

/** "Units: 6 (running=2 done=4)" → { total: 6, running: 2, done: 4 } */
export function parseStatusUnits(statusMd) {
  const m = String(statusMd || "").match(/^Units:\s*(\d+)\s*(?:\(([^)]*)\))?/m);
  if (!m) return null;
  const out = { total: Number(m[1]) || 0 };
  for (const part of String(m[2] || "").split(/\s+/)) {
    const kv = part.match(/^([a-z]+)=(\d+)$/i);
    if (kv) out[kv[1].toLowerCase()] = Number(kv[2]);
  }
  return out;
}

/** First "Goal: …" line or first paragraph after the heading of overview.md. */
function goalFromOverview(md) {
  const text = String(md || "");
  const goal = text.match(/^Goal:\s*(.+)$/m);
  if (goal) return goal[1].trim();
  const para = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .find((p) => p && !p.startsWith("#"));
  return para || null;
}

function kanbanCounts(cards) {
  const counts = Object.fromEntries(KANBAN_COLUMNS.map((c) => [c, 0]));
  for (const c of cards) {
    const col = String(c?.column || "");
    if (col in counts) counts[col] += 1;
  }
  return counts;
}

/** "ff7d00" / "0xff7d00" / "#ff7d00" → "#ff7d00" (null when not a hex color). */
export function cssColor(value) {
  const hex = String(value || "").replace(/^(0x|#)/i, "");
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toLowerCase()}` : null;
}

/**
 * sessions/.avatars/*.svg are written from a JSON string field and some keep
 * the JSON escaping (`<svg xmlns=\"…\"`), which no browser parses. Undo that;
 * anything that still isn't an <svg> document → null.
 */
export function normalizeAvatarSvg(text) {
  let svg = String(text || "").trim();
  if (svg.startsWith('"') && svg.endsWith('"')) {
    try {
      svg = JSON.parse(svg);
    } catch {
      /* fall through to the unescape below */
    }
  }
  if (/^<svg[^>]*\\"/.test(svg)) {
    svg = svg.replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
  }
  return /^<svg[\s>]/.test(svg) ? svg : null;
}

export const PROJECT_FILES = ["dossier.json", "overview.md", "status.md", "roster.json", "kanban.json"];

/**
 * A pstack room counts as a project when it holds at least one PROJECT_FILES entry.
 * `hasFile(slug, fileName)` answers "does this room hold that file" so each caller keeps
 * its own path composition — the Hub reads the pushed snapshot, the desk reads its disk.
 * Single source of truth: gate on this, never on a hand-picked subset of PROJECT_FILES.
 */
export function projectRoomHasFiles(slug, hasFile) {
  return PROJECT_FILES.some((f) => hasFile(slug, f));
}
const CURRENT_FILES = ["sessions/.pstack-dossier-current", "sessions/.project-current"];
const HERO_STATE_FILE = "sessions/.hero-agent-state.json";
const ROLES_FILE = "config/agent-roles.json";
const SNAPSHOT_MAX_FILES = 2000;
const SNAPSHOT_MAX_FILE_BYTES = 256 * 1024;
const SNAPSHOT_MAX_NAME = 64;

/** Repo-relative paths a desk may push — exactly what the project source reads. */
export function snapshotPathOk(path) {
  const p = String(path || "");
  if (CURRENT_FILES.includes(p) || p === HERO_STATE_FILE || p === ROLES_FILE) return true;
  let m = p.match(/^sessions\/pstack\/([^/]+)\/([^/]+)$/);
  if (m) return projectSlugOk(m[1]) && PROJECT_FILES.includes(m[2]);
  m = p.match(/^sessions\/\.avatars\/([^/]+)\.svg$/);
  return Boolean(m && heroIdOk(m[1]));
}

function snapshotError(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

/**
 * Validate a pushed project snapshot body.
 * @returns {{ files: Array<{ path: string, text: string, mtime: string|null }>, heroNames: Record<string, string> }}
 */
export function validateProjectSnapshot(body) {
  const files = body?.files;
  if (!Array.isArray(files)) throw snapshotError("files array required");
  if (files.length > SNAPSHOT_MAX_FILES) throw snapshotError("too many files");
  const seen = new Set();
  const out = [];
  for (const f of files) {
    const path = String(f?.path || "");
    if (!snapshotPathOk(path)) throw snapshotError(`path not allowed: ${path.slice(0, 120)}`);
    if (seen.has(path)) throw snapshotError(`duplicate path: ${path}`);
    seen.add(path);
    if (typeof f.text !== "string") throw snapshotError(`text required: ${path}`);
    if (Buffer.byteLength(f.text, "utf8") > SNAPSHOT_MAX_FILE_BYTES) {
      throw snapshotError(`file too large: ${path}`);
    }
    const mtime = f.mtime && !Number.isNaN(new Date(f.mtime).getTime())
      ? new Date(f.mtime).toISOString()
      : null;
    out.push({ path, text: f.text, mtime });
  }
  const heroNames = {};
  for (const [id, name] of Object.entries(body?.heroNames || {})) {
    if (heroIdOk(id) && typeof name === "string" && name.trim()) {
      heroNames[id] = name.trim().slice(0, SNAPSHOT_MAX_NAME);
    }
  }
  return { files: out, heroNames };
}

/**
 * Desk side: gather every file the project source reads (disk only) so the Hub
 * can render the same portfolio. Avatars only for heroes on some roster.
 * @param {{ root: string, heroName?: (heroId: string) => string|null }} opts
 */
export function collectProjectSnapshot({ root, heroName } = {}) {
  const src = createProjectSource({ root });
  const files = [];
  const add = (rel) => {
    const abs = join(root, rel);
    const text = readText(abs);
    if (text != null) files.push({ path: rel, text, mtime: mtimeIso(abs) });
  };
  const heroes = new Set();
  for (const slug of src.listSlugs()) {
    for (const f of PROJECT_FILES) add(`sessions/pstack/${slug}/${f}`);
    const roster = readJson(join(root, "sessions/pstack", slug, "roster.json"), {}) || {};
    for (const h of Array.isArray(roster.heroes) ? roster.heroes : []) {
      const id = typeof h === "string" ? h : h?.id;
      if (heroIdOk(String(id || ""))) heroes.add(String(id));
    }
  }
  for (const rel of [...CURRENT_FILES, HERO_STATE_FILE, ROLES_FILE]) add(rel);
  const heroNames = {};
  for (const id of [...heroes].sort()) {
    add(`sessions/.avatars/${id}.svg`);
    let name = null;
    try {
      name = heroName ? heroName(id) : null;
    } catch {
      name = null;
    }
    if (name) heroNames[id] = String(name);
  }
  return { files, heroNames };
}

/**
 * Reads go to the pushed snapshot first (the desk owns its pstack rooms), then
 * the Hub's own disk, so a Hub with local rooms still shows them.
 * @param {{
 *   root: string,
 *   heroName?: (heroId: string) => string|null,
 *   snapshot?: () => ({ files: Map<string, { text: string, mtime: string|null }>, heroNames: Record<string, string> }|null),
 * }} opts
 */
export function createProjectSource({ root, heroName, snapshot } = {}) {
  const pstackRoot = join(root, "sessions/pstack");
  const snap = () => (typeof snapshot === "function" ? snapshot() : null) || null;

  function fileText(rel) {
    const f = snap()?.files.get(rel);
    return f ? f.text : readText(join(root, rel));
  }

  function fileJson(rel, fallback) {
    const text = fileText(rel);
    if (text == null) return fallback;
    try {
      return JSON.parse(text);
    } catch {
      return fallback;
    }
  }

  function fileExists(rel) {
    return Boolean(snap()?.files.has(rel)) || existsSync(join(root, rel));
  }

  function fileMtime(rel) {
    const f = snap()?.files.get(rel);
    return f ? f.mtime : mtimeIso(join(root, rel));
  }

  function currentSlug() {
    for (const rel of CURRENT_FILES) {
      const s = fileText(rel)?.trim();
      if (s && projectSlugOk(s)) return s;
    }
    return null;
  }

  function heroTable() {
    const state = fileJson(HERO_STATE_FILE, {}) || {};
    const roles = fileJson(ROLES_FILE, {}) || {};
    return { state, roles };
  }

  function heroRecord(id, table, orchIds, projectRole) {
    const st = table.state?.[id] || {};
    const roleRaw = table.roles?.[id];
    const fleetRole = typeof roleRaw === "string" ? roleRaw : roleRaw?.roleId || roleRaw?.role || null;
    // A stored project role wins, including null (unassigned). A plain id falls back to the fleet role.
    const role = projectRole === undefined ? fleetRole : projectRole;
    let name = snap()?.heroNames?.[id] || null;
    if (!name && heroName) {
      try {
        name = heroName(id) || null;
      } catch {
        name = null;
      }
    }
    return {
      id,
      name,
      role,
      orchestrator: projectRole === undefined ? role === "orchestrator" || orchIds.has(id) : role === "orchestrator",
      collateral: st.collateral || null,
      color: cssColor(st.primary),
      colorSecondary: cssColor(st.secondary),
      status: String(st.status || "unknown").toLowerCase(),
      host: st.host || null,
      model: st.model || null,
      sessionId: st.sessionId || null,
      updatedAt: st.at || null,
      hasAvatar: fileExists(`sessions/.avatars/${id}.svg`),
    };
  }

  function loadProjectFiles(slug) {
    const dir = `sessions/pstack/${slug}`;
    const dossier = fileJson(`${dir}/dossier.json`, null);
    const overview = fileText(`${dir}/overview.md`);
    const statusMd = fileText(`${dir}/status.md`);
    const roster = fileJson(`${dir}/roster.json`, {}) || {};
    const kanban = fileJson(`${dir}/kanban.json`, {}) || {};
    const fields = dossier?.fields || {};
    const cards = Array.isArray(kanban.cards) ? kanban.cards : [];
    const heroes = (Array.isArray(roster.heroes) ? roster.heroes : [])
      .map((h) => (typeof h === "string" ? { id: h, role: undefined } : { id: String(h?.id || ""), role: h?.role ? String(h.role) : null }))
      .filter((h) => heroIdOk(h.id));
    return {
      dir,
      dossier,
      fields,
      overview,
      statusMd,
      heroes,
      cards,
      updatedAt: latestIso(
        dossier?.updatedAt,
        roster.updatedAt,
        kanban.updatedAt,
        fileMtime(`${dir}/status.md`),
        fileMtime(`${dir}/overview.md`),
      ),
    };
  }

  function summary(slug, files, current) {
    const title = String(files.fields.title || "").trim() || slug;
    return {
      slug,
      title,
      goal: String(files.fields.goal || "").trim() || goalFromOverview(files.overview),
      playbook: files.fields.playbook || null,
      status: files.dossier?.status || (files.statusMd ? "active" : "draft"),
      current,
      heroCount: files.heroes.length,
      kanban: kanbanCounts(files.cards),
      units: parseStatusUnits(files.statusMd),
      updatedAt: files.updatedAt,
    };
  }

  /**
   * Every pstack room holding at least one PROJECT_FILES entry (smoke rooms hidden).
   * Uses the shared predicate because collectProjectSnapshot discovers slugs through
   * this same function: a room gated out here is never pushed and can never be read back.
   */
  function listSlugs() {
    const names = new Set();
    try {
      for (const name of readdirSync(pstackRoot)) names.add(name);
    } catch {
      /* no local rooms */
    }
    for (const rel of snap()?.files.keys() || []) {
      const m = rel.match(/^sessions\/pstack\/([^/]+)\//);
      if (m) names.add(m[1]);
    }
    return [...names].filter((name) => {
      if (!projectSlugOk(name) || /smoke/i.test(name)) return false;
      return projectRoomHasFiles(name, (slug, f) => fileExists(`sessions/pstack/${slug}/${f}`));
    });
  }

  function orchestratorIds(table) {
    return new Set(
      Object.entries(table.roles || {})
        .filter(([, r]) => (typeof r === "string" ? r : r?.roleId) === "orchestrator")
        .map(([id]) => id),
    );
  }

  function rankRoster(roster) {
    const rank = { working: 0, active: 0, assigned: 1, watching: 1, available: 2, idle: 3 };
    const seated = (h) => (h.role ? 0 : 1);
    return roster.sort((a, b) => {
      if (a.orchestrator !== b.orchestrator) return a.orchestrator ? -1 : 1;
      if (seated(a) !== seated(b)) return seated(a) - seated(b);
      return (rank[a.status] ?? 4) - (rank[b.status] ?? 4);
    });
  }

  function listProjects() {
    const current = currentSlug();
    const table = heroTable();
    const orchIds = orchestratorIds(table);
    const projects = listSlugs().map((slug) => {
      const files = loadProjectFiles(slug);
      const roster = rankRoster(files.heroes.map((h) => heroRecord(h.id, table, orchIds, h.role)));
      return {
        ...summary(slug, files, slug === current),
        accent: roster.find((h) => h.color)?.color || null,
        working: roster.filter((h) => h.status === "working" || h.status === "active").length,
        heroes: roster.slice(0, 5).map((h) => ({
          id: h.id,
          name: h.name,
          collateral: h.collateral,
          color: h.color,
          status: h.status,
          hasAvatar: h.hasAvatar,
        })),
      };
    });
    projects.sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1;
      return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    });
    return projects;
  }

  /** @returns {object|null} */
  function getProject(slug) {
    if (!projectSlugOk(slug) || !listSlugs().includes(slug)) return null;
    const files = loadProjectFiles(slug);
    const table = heroTable();
    const roster = rankRoster(
      files.heroes.map((h) => heroRecord(h.id, table, orchestratorIds(table), h.role)),
    );
    const cards = [...files.cards]
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
      .slice(0, MAX_CARDS)
      .map((c) => ({
        id: String(c.id || ""),
        title: String(c.title || "").slice(0, 200),
        column: String(c.column || "todo"),
        owner: c.owner ? String(c.owner) : null,
        updatedAt: c.updatedAt || null,
      }));
    return {
      ...summary(slug, files, slug === currentSlug()),
      accent: roster.find((h) => h.color)?.color || null,
      working: roster.filter((h) => h.status === "working" || h.status === "active").length,
      scope: files.fields.scope ? String(files.fields.scope) : null,
      roster,
      cards,
    };
  }

  /** Absolute path of a hero's avatar SVG, or null. */
  function avatarPath(heroId) {
    if (!heroIdOk(heroId)) return null;
    const p = join(root, "sessions/.avatars", `${heroId}.svg`);
    return existsSync(p) ? p : null;
  }

  /** Avatar SVG text, or null. See normalizeAvatarSvg for the cache quirk. */
  function readAvatarSvg(heroId) {
    if (!heroIdOk(heroId)) return null;
    return normalizeAvatarSvg(fileText(`sessions/.avatars/${heroId}.svg`));
  }

  return { listProjects, getProject, listSlugs, avatarPath, readAvatarSvg, currentSlug };
}
