#!/usr/bin/env node
/**
 * Turn a marketplace template into a roster hero.
 *
 * The hero's identity is the pack (id, role, name). Its worker is an available
 * cAavegotchi when one is already known locally (an id passed in, or the
 * roster / subgraph cache on disk). Nothing here mints, signs, or invents a
 * token id — no cache means an unbound worker slot.
 *
 *   node scripts/template-hero.mjs seat <id> [--gotchi owned-<id>] [--roster <path>] [--sessions <dir>] [--json]
 *   node scripts/template-hero.mjs avatar <id>
 *
 * Suites (bend-crew) seat each member, never one hero for the crew.
 * prof-link-cube is a built-in fleet hero and is rejected.
 * Does not write sessions/.pin and refuses the live aarcadeghst roster.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";
import { normalizeRosterHero } from "./project-context.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Built-in fleet hero. Never a marketplace mint and never a template seat. */
const REJECTED = new Set(["prof-link-cube"]);

const GOTCHI_ID = /^(owned|starter|rental)-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BARE_TOKEN = /^\d{1,12}$/;
const TEMPLATE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Canonical local id. Bare token ids become `owned-<id>`. Junk is null — never invented. */
export function asGotchiId(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (GOTCHI_ID.test(s)) return s;
  if (BARE_TOKEN.test(s)) return `owned-${s}`;
  return null;
}

/** Reserved portrait. Julius drops the file later; missing file keeps the glyph. */
export function templateAvatarRel(id) {
  return `assets/templates/${id}.png`;
}

export function resolveTemplateAvatar(id, { root = ROOT } = {}) {
  const safe = String(id || "").trim();
  const path = templateAvatarRel(safe);
  const absolute = join(root, path);
  const ready = !!safe && existsSync(absolute);
  return {
    id: safe,
    path,
    absolute,
    ready,
    display: ready ? path : "glyph",
    fallback: ready ? null : "glyph",
  };
}

function assertTemplateId(id) {
  if (!TEMPLATE_ID.test(id)) {
    throw new Error(`unknown template "${id}"`);
  }
  if (REJECTED.has(id)) {
    throw new Error(`${id} is a built-in fleet hero, never minted, and cannot be seated from a template`);
  }
}

function packsDir(root) {
  return join(root, "templates", "marketplace", "packs");
}

function readPack(root, id) {
  return readJson(join(packsDir(root), id, "pack.json"));
}

function projectManagerTemplate(root) {
  const agents = join(root, "config", "openclaw", "templates", "AGENTS.project-manager.md");
  const playbooks = readJson(join(root, "config", "agent-role-playbooks.json")) || {};
  const pb = playbooks["project-manager"];
  if (!existsSync(agents) && !pb) return null;
  return {
    id: "project-manager",
    roleId: "project-manager",
    title: pb?.title || "Project Manager",
    kind: "hero",
    source: "config/openclaw/templates/AGENTS.project-manager.md",
  };
}

/**
 * One seatable unit. Suites stay suites (members listed, not expanded here).
 * @returns {object|null}
 */
export function loadTemplate(id, { root = ROOT } = {}) {
  const key = String(id || "").trim();
  assertTemplateId(key);
  if (key === "project-manager") return projectManagerTemplate(root);
  const pack = readPack(root, key);
  if (!pack) return null;
  const members = Array.isArray(pack.members) ? pack.members.map((m) => String(m)) : [];
  const suite = pack.kind === "suite" || members.length > 0;
  return {
    id: pack.id || key,
    roleId: pack.roleId || pack.id || key,
    title: pack.title || pack.roleId || key,
    kind: suite ? "suite" : "hero",
    members: suite ? members : [],
    source: `templates/marketplace/packs/${key}/pack.json`,
  };
}

/** Catalog packs plus project-manager. prof-link-cube is absent. Suites are flagged, not expanded. */
export function listSeatableTemplates({ root = ROOT } = {}) {
  const catalog = readJson(join(root, "templates", "marketplace", "catalog.json"));
  const ids = (catalog?.packs || []).map((p) => p.id).filter(Boolean);
  if (!ids.includes("project-manager")) ids.push("project-manager");
  const out = [];
  for (const id of ids) {
    if (REJECTED.has(id)) continue;
    const tpl = loadTemplate(id, { root });
    if (tpl) out.push(tpl);
  }
  return out;
}

function pinId(sessionsDir) {
  if (!sessionsDir) return null;
  try {
    const id = readFileSync(join(sessionsDir, ".pin"), "utf8").trim();
    return id || null;
  } catch {
    return null;
  }
}

/**
 * cAavegotchi ids already on disk that are free to bind.
 * Prefers hero-agent-state `available`, then unassigned roster rows, then the
 * wallet / subgraph name cache. Busy rows and the orchestrator pin are skipped.
 */
export function listCachedAvailableGotchis(sessionsDir) {
  if (!sessionsDir || !existsSync(sessionsDir)) return [];
  const busy = new Set();
  const preferred = [];
  const rest = [];
  const pin = pinId(sessionsDir);
  if (pin) busy.add(pin);

  const state = readJson(join(sessionsDir, ".hero-agent-state.json"));
  if (state && typeof state === "object") {
    const rows = state.heroes && typeof state.heroes === "object" ? state.heroes : state;
    for (const [id, row] of Object.entries(rows)) {
      const gid = asGotchiId(id);
      if (!gid) continue;
      const st = String(row?.status || row?.agentStatus || "").toLowerCase();
      if (st && st !== "available") busy.add(gid);
      else preferred.push(gid);
    }
  }

  const rosterFiles = [];
  const direct = join(sessionsDir, "roster.json");
  if (existsSync(direct)) rosterFiles.push(direct);
  const pstack = join(sessionsDir, "pstack");
  if (existsSync(pstack)) {
    for (const slug of readdirSync(pstack)) {
      const rp = join(pstack, slug, "roster.json");
      if (existsSync(rp)) rosterFiles.push(rp);
    }
  }
  for (const rp of rosterFiles) {
    const body = readJson(rp);
    for (const entry of body?.heroes || []) {
      const id = typeof entry === "string" ? entry : entry?.id;
      const role = entry && typeof entry === "object" ? entry.role : null;
      const gid = asGotchiId(id);
      const worker = asGotchiId(entry?.worker?.gotchiId);
      if (worker) busy.add(worker);
      if (!gid) continue;
      if (role && role !== "worker" && role !== "unassigned" && role !== "none") busy.add(gid);
      else rest.push(gid);
    }
  }

  const wallet = readJson(join(sessionsDir, ".wallet-gotchis.json"));
  const walletRows = wallet?.gotchis ?? wallet?.rows ?? (Array.isArray(wallet) ? wallet : []);
  for (const g of walletRows) {
    const gid = asGotchiId(g?.gotchiId ?? g?.tokenId ?? g?.id);
    if (gid) rest.push(gid);
  }

  const names = readJson(join(sessionsDir, ".gotchi-names.json"));
  const nameMap = names?.names && typeof names.names === "object" ? names.names : null;
  if (nameMap) {
    for (const [id, row] of Object.entries(nameMap)) {
      if (row?.failed) continue;
      const gid = asGotchiId(id);
      if (gid) rest.push(gid);
    }
  }

  const out = [];
  const seen = new Set();
  for (const id of [...preferred, ...rest]) {
    if (!id || seen.has(id) || busy.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function heroRecord(unit, gotchiId, root) {
  const id = String(unit.roleId || unit.id);
  const avatar = resolveTemplateAvatar(id, { root });
  const worker = gotchiId
    ? { status: "bound", gotchiId }
    : { status: "unbound", gotchiId: null };
  return normalizeRosterHero({
    id,
    name: unit.title || id,
    role: id,
    worker,
    avatar: { path: avatar.path, ready: avatar.ready, fallback: avatar.fallback },
  });
}

function unitsFor(template, root) {
  if (template.kind !== "suite") return [template];
  // One hero per member. arcade-game-monitor is not a suite: no game list, so it stays one hero.
  const units = [];
  for (const member of template.members) {
    const unit = loadTemplate(member, { root });
    if (!unit || unit.kind === "suite") {
      throw new Error(`suite ${template.id} member "${member}" is not a hero pack`);
    }
    units.push(unit);
  }
  if (!units.length) throw new Error(`suite ${template.id} has no members`);
  return units;
}

function refuseLiveRoster(rosterPath) {
  if (!rosterPath) return;
  const norm = resolve(rosterPath);
  if (norm.split(sep).includes("aarcadeghst")) {
    throw new Error("refusing to write the live aarcadeghst roster");
  }
}

/**
 * Seat `templateId`. Writes roster JSON only when `rosterPath` is set (tests
 * pass a temp dir). Never touches the orchestrator pin.
 *
 * @returns {{ templateId: string, kind: string, heroes: object[], rosterPath: string|null }}
 */
export function seatTemplate(templateId, opts = {}) {
  const root = opts.root || ROOT;
  const key = String(templateId || "").trim();
  const template = loadTemplate(key, { root });
  if (!template) throw new Error(`unknown template "${key}"`);
  const units = unitsFor(template, root);

  const explicit = [];
  if (opts.gotchiId != null && opts.gotchiId !== "") explicit.push(opts.gotchiId);
  if (Array.isArray(opts.gotchiIds)) explicit.push(...opts.gotchiIds);
  const explicitIds = [];
  for (const raw of explicit) {
    const gid = asGotchiId(raw);
    if (!gid) throw new Error(`not a cAavegotchi id: ${raw}`);
    explicitIds.push(gid);
  }

  const sessionsDir = opts.sessionsDir === undefined ? join(root, "sessions") : opts.sessionsDir;
  const pinPath = sessionsDir ? join(sessionsDir, ".pin") : null;
  const pinBefore = pinPath && existsSync(pinPath) ? readFileSync(pinPath) : null;

  refuseLiveRoster(opts.rosterPath);
  const existing = [];
  if (opts.rosterPath && existsSync(opts.rosterPath)) {
    const prev = readJson(opts.rosterPath);
    for (const entry of prev?.heroes || []) {
      const hero = normalizeRosterHero(entry);
      if (hero?.id) existing.push(hero);
    }
  }
  const taken = new Set();
  for (const hero of existing) {
    const gid = asGotchiId(hero.worker?.gotchiId);
    if (gid) taken.add(gid);
  }
  const cached = listCachedAvailableGotchis(sessionsDir).filter((id) => !taken.has(id));
  const pool = [];
  const seen = new Set();
  for (const id of [...explicitIds, ...cached]) {
    if (seen.has(id) || taken.has(id)) continue;
    seen.add(id);
    pool.push(id);
  }

  const seated = [];
  const added = [];
  for (const unit of units) {
    const prior = existing.find((h) => h.id === (unit.roleId || unit.id));
    if (prior) {
      seated.push(prior);
      continue;
    }
    const gid = pool.shift() || null;
    if (gid) taken.add(gid);
    const hero = heroRecord(unit, gid, root);
    added.push(hero);
    seated.push(hero);
  }

  let rosterPath = null;
  if (opts.rosterPath) {
    rosterPath = resolve(opts.rosterPath);
    mkdirSync(dirname(rosterPath), { recursive: true });
    const body = {
      project: opts.project || null,
      heroes: [...existing, ...added],
      updatedAt: new Date().toISOString(),
      note: "Template heroes. worker.gotchiId is the bound cAavegotchi when one was known locally; status unbound means the slot is empty. This file is not the orchestrator pin.",
    };
    writeFileSync(rosterPath, `${JSON.stringify(body, null, 2)}\n`);
  }

  if (pinPath && pinBefore != null) {
    const pinAfter = existsSync(pinPath) ? readFileSync(pinPath) : null;
    if (!pinAfter || !pinAfter.equals(pinBefore)) {
      throw new Error("orchestrator pin changed during seat — refusing");
    }
  }

  return {
    templateId: template.id,
    kind: template.kind,
    heroes: seated,
    rosterPath,
  };
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  if (i < 0) return null;
  return argv[i + 1] || null;
}

function main() {
  const [cmd, id, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(`usage:
  template-hero.mjs seat <id> [--gotchi <owned-id>] [--roster <path>] [--sessions <dir>] [--json]
  template-hero.mjs avatar <id>
  template-hero.mjs list [--json]`);
    process.exit(cmd ? 0 : 2);
  }
  if (cmd === "list") {
    const rows = listSeatableTemplates();
    if (rest.includes("--json") || process.argv.includes("--json")) {
      console.log(JSON.stringify(rows, null, 2));
    } else {
      for (const row of rows) {
        const extra = row.kind === "suite" ? ` suite ${row.members.join(",")}` : "";
        console.log(`${row.id}\t${row.title}${extra}`);
      }
    }
    return;
  }
  if (cmd === "avatar") {
    if (!id) {
      console.error("usage: template-hero.mjs avatar <id>");
      process.exit(2);
    }
    console.log(JSON.stringify(resolveTemplateAvatar(id), null, 2));
    return;
  }
  if (cmd !== "seat") {
    console.error(`unknown command ${cmd}`);
    process.exit(2);
  }
  if (!id) {
    console.error("usage: template-hero.mjs seat <id> [--gotchi <owned-id>] [--roster <path>] [--sessions <dir>]");
    process.exit(2);
  }
  const argv = [id, ...rest];
  const seatOpts = {};
  const gotchi = argValue(argv, "--gotchi");
  const roster = argValue(argv, "--roster");
  const sessions = argValue(argv, "--sessions");
  if (gotchi) seatOpts.gotchiId = gotchi;
  if (roster) seatOpts.rosterPath = roster;
  if (sessions) seatOpts.sessionsDir = sessions;
  const result = seatTemplate(id, seatOpts);
  if (rest.includes("--json") || process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  for (const hero of result.heroes) {
    const worker = hero.worker?.status === "bound" ? hero.worker.gotchiId : "unbound";
    console.log(`${hero.id}\t${hero.name}\t${hero.role}\tworker=${worker}\tavatar=${hero.avatar?.path}`);
  }
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(e?.message || e);
    process.exit(1);
  }
}
