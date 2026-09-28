/**
 * Read-only project portfolio for the phone app.
 *
 * Source of truth is the Hub's own repo tree (sessions/pstack/<slug>/ —
 * dossier, roster, kanban, status.md) plus the hero caches the desk keeps
 * (sessions/.hero-agent-state.json, config/agent-roles.json,
 * sessions/.avatars/<hero>.svg). Nothing here writes.
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

/**
 * @param {{ root: string, heroName?: (heroId: string) => string|null }} opts
 */
export function createProjectSource({ root, heroName } = {}) {
  const pstackRoot = join(root, "sessions/pstack");

  function currentSlug() {
    for (const name of [".pstack-dossier-current", ".project-current"]) {
      const s = readText(join(root, "sessions", name))?.trim();
      if (s && projectSlugOk(s)) return s;
    }
    return null;
  }

  function heroTable() {
    const state = readJson(join(root, "sessions/.hero-agent-state.json"), {}) || {};
    const roles = readJson(join(root, "config/agent-roles.json"), {}) || {};
    return { state, roles };
  }

  function heroRecord(id, table, orchIds) {
    const st = table.state?.[id] || {};
    const roleRaw = table.roles?.[id];
    const role = typeof roleRaw === "string" ? roleRaw : roleRaw?.roleId || roleRaw?.role || null;
    let name = null;
    if (heroName) {
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
      orchestrator: role === "orchestrator" || orchIds.has(id),
      collateral: st.collateral || null,
      color: cssColor(st.primary),
      colorSecondary: cssColor(st.secondary),
      status: String(st.status || "unknown").toLowerCase(),
      host: st.host || null,
      model: st.model || null,
      sessionId: st.sessionId || null,
      updatedAt: st.at || null,
      hasAvatar: existsSync(join(root, "sessions/.avatars", `${id}.svg`)),
    };
  }

  function loadProjectFiles(slug) {
    const dir = join(pstackRoot, slug);
    const dossierPath = join(dir, "dossier.json");
    const dossier = readJson(dossierPath);
    const overview = readText(join(dir, "overview.md"));
    const statusMd = readText(join(dir, "status.md"));
    const roster = readJson(join(dir, "roster.json"), {}) || {};
    const kanban = readJson(join(dir, "kanban.json"), {}) || {};
    const fields = dossier?.fields || {};
    const cards = Array.isArray(kanban.cards) ? kanban.cards : [];
    const heroes = Array.isArray(roster.heroes)
      ? roster.heroes.filter((h) => heroIdOk(String(h)))
      : [];
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
        mtimeIso(join(dir, "status.md")),
        mtimeIso(join(dir, "overview.md")),
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

  /** Every pstack room with a dossier, overview or status (smoke rooms hidden). */
  function listSlugs() {
    if (!existsSync(pstackRoot)) return [];
    let names = [];
    try {
      names = readdirSync(pstackRoot);
    } catch {
      return [];
    }
    return names.filter((name) => {
      if (!projectSlugOk(name) || /smoke/i.test(name)) return false;
      const dir = join(pstackRoot, name);
      return ["dossier.json", "overview.md", "status.md"].some((f) => existsSync(join(dir, f)));
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
    return roster.sort((a, b) => {
      if (a.orchestrator !== b.orchestrator) return a.orchestrator ? -1 : 1;
      return (rank[a.status] ?? 4) - (rank[b.status] ?? 4);
    });
  }

  function listProjects() {
    const current = currentSlug();
    const table = heroTable();
    const orchIds = orchestratorIds(table);
    const projects = listSlugs().map((slug) => {
      const files = loadProjectFiles(slug);
      const roster = rankRoster(files.heroes.map((id) => heroRecord(id, table, orchIds)));
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
      files.heroes.map((id) => heroRecord(id, table, orchestratorIds(table))),
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
    const p = avatarPath(heroId);
    if (!p) return null;
    return normalizeAvatarSvg(readText(p));
  }

  return { listProjects, getProject, avatarPath, readAvatarSvg, currentSlug };
}
