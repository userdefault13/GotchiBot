#!/usr/bin/env node
/**
 * Pack wearables — marketplace bot templates nested on the cart and equipped
 * onto a cAavegotchi slot as the **assignment label**.
 *
 * Model:
 *   marketplace pack → nest on cart inventory → equip slot on hero = role label
 *   L1 aesthetic wearables stay slots 0–14; GotchiBot assignment uses slot 15.
 *
 * Desk SoT: sessions/.pack-wearables.json
 * Also mirrors into config/agent-roles.json (hero → packId) for existing readers.
 * Checkpoint: gameState.equippedPacks (via packWearableCheckpointSlice).
 *
 *   node scripts/pack-wearable.mjs list [--json]
 *   node scripts/pack-wearable.mjs nest <packId>
 *   node scripts/pack-wearable.mjs equip <hero> <packId> [--slot 15]
 *   node scripts/pack-wearable.mjs unequip <hero>
 *   node scripts/pack-wearable.mjs trust <hero> probation|trusted   # hire sheet trust ramp
 *   node scripts/pack-wearable.mjs status [<hero>] [--json]
 *   node scripts/pack-wearable.mjs clear-all [--reason transfer]
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { isMainModule } from "./is-main.mjs";
import { currentProjectSlug, rosterAssign } from "./project-context.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = join(ROOT, "sessions");
const STATE_PATH = join(SESSIONS, ".pack-wearables.json");
const ROLES_PATH = join(ROOT, "config", "agent-roles.json");
const CATALOG_PATH = join(ROOT, "templates", "marketplace", "catalog.json");
const PACKS_DIR = join(ROOT, "templates", "marketplace", "packs");

/** Reserved cGotchi slot for marketplace role assignment (L1 aesthetic = 0–14). */
export const ASSIGNMENT_SLOT = 15;

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

function emptyState() {
  return {
    version: 1,
    assignmentSlot: ASSIGNMENT_SLOT,
    nested: {},
    equipped: {},
    updatedAt: new Date().toISOString(),
    note:
      "Marketplace packs nested on cart + equipped to cAavegotchi slot 15 = assignment label. L1 aesthetic wearables stay 0–14.",
  };
}

export function loadPackWearables() {
  const s = readJson(STATE_PATH, null);
  if (!s || typeof s !== "object") return emptyState();
  return {
    ...emptyState(),
    ...s,
    nested: s.nested && typeof s.nested === "object" ? s.nested : {},
    equipped: s.equipped && typeof s.equipped === "object" ? s.equipped : {},
    assignmentSlot:
      typeof s.assignmentSlot === "number" ? s.assignmentSlot : ASSIGNMENT_SLOT,
  };
}

export function savePackWearables(state) {
  const next = {
    ...emptyState(),
    ...state,
    updatedAt: new Date().toISOString(),
  };
  writeJson(STATE_PATH, next);
  return next;
}

function loadCatalogPackIds() {
  const cat = readJson(CATALOG_PATH, { packs: [] });
  const ids = new Set();
  for (const p of cat.packs || []) {
    if (p.id) ids.add(String(p.id));
    if (p.roleId) ids.add(String(p.roleId));
  }
  return ids;
}

function resolvePackId(packId) {
  const id = String(packId || "").trim();
  if (!id) throw new Error("pack id required");
  const packJson = join(PACKS_DIR, id, "pack.json");
  if (existsSync(packJson)) {
    const j = readJson(packJson, {});
    return String(j.id || j.roleId || id);
  }
  const ids = loadCatalogPackIds();
  if (ids.has(id)) return id;
  // roleId alias in catalog
  const cat = readJson(CATALOG_PATH, { packs: [] });
  const hit = (cat.packs || []).find((p) => p.roleId === id || p.id === id);
  if (hit) return String(hit.id || hit.roleId);
  throw new Error(`unknown marketplace pack "${id}"`);
}

function syncAgentRole(heroId, packIdOrNull) {
  // The current project's workbench is where the role lives: the same gotchi
  // may hold another role (or none) in other projects.
  const slug = currentProjectSlug();
  if (slug) {
    try {
      rosterAssign(String(heroId), packIdOrNull ? String(packIdOrNull) : "none", slug);
      // Every reader is on the workbench: the desk-wide table is not touched
      // from inside a project, so this role does not leak into other projects.
      return null;
    } catch (e) {
      console.error(`  (workbench ${slug}: ${e?.message || e} — recorded desk-wide instead)`);
    }
  }
  // No project selected (or the workbench refused it): the desk-wide table.
  const roles = readJson(ROLES_PATH, {}) || {};
  if (packIdOrNull) {
    roles[String(heroId)] = String(packIdOrNull);
  } else {
    delete roles[String(heroId)];
  }
  writeJson(ROLES_PATH, roles);
  return roles;
}

/** Nest a pack onto the cart inventory (desk mirror). Idempotent. */
export function nestPack(packId) {
  const id = resolvePackId(packId);
  const state = loadPackWearables();
  if (!state.nested[id]) {
    state.nested[id] = {
      packId: id,
      nestedAt: new Date().toISOString(),
      source: "marketplace",
    };
  } else {
    state.nested[id] = {
      ...state.nested[id],
      packId: id,
      refreshedAt: new Date().toISOString(),
    };
  }
  return savePackWearables(state);
}

/**
 * Equip pack onto hero assignment slot (= role label).
 * Nests the pack first if missing. Syncs config/agent-roles.json.
 */
export function equipPack(heroId, packId, { slot = ASSIGNMENT_SLOT } = {}) {
  if (!heroId) throw new Error("hero id required");
  const id = resolvePackId(packId);
  let state = nestPack(id);
  const slotIndex = Number.isFinite(slot) ? Number(slot) : ASSIGNMENT_SLOT;
  // One assignment pack per hero — replace prior equip.
  state = loadPackWearables();
  const prior = state.equipped[String(heroId)] || null;
  // A new role is a new hire: probation until UserDefault promotes it.
  // Re-equipping the same pack keeps the trust it already earned.
  const trust = prior?.packId === id && prior?.trust ? prior.trust : "probation";
  state.equipped[String(heroId)] = {
    packId: id,
    slot: slotIndex,
    equippedAt: new Date().toISOString(),
    trust,
    ...(trust === "probation" ? { hiredAt: new Date().toISOString() } : prior?.hiredAt ? { hiredAt: prior.hiredAt } : {}),
  };
  savePackWearables(state);
  syncAgentRole(heroId, id);
  return state.equipped[String(heroId)];
}

/** Unequip assignment pack from hero; clears agent-roles entry. */
export function unequipPack(heroId) {
  if (!heroId) throw new Error("hero id required");
  const state = loadPackWearables();
  const prev = state.equipped[String(heroId)] || null;
  delete state.equipped[String(heroId)];
  savePackWearables(state);
  syncAgentRole(heroId, null);
  return prev;
}

/** Clear all nested + equipped (cart transfer). Keeps dossier packs on disk. */
export function clearAllPackWearables(reason = "transfer") {
  const prev = loadPackWearables();
  const equippedHeroes = Object.keys(prev.equipped || {});
  const empty = emptyState();
  empty.clearedReason = reason;
  empty.clearedAt = new Date().toISOString();
  savePackWearables(empty);
  // Drop assignment labels only for heroes that had a pack equipped.
  if (equippedHeroes.length) {
    const roles = readJson(ROLES_PATH, {}) || {};
    for (const h of equippedHeroes) delete roles[h];
    writeJson(ROLES_PATH, roles);
  }
  return empty;
}

/** Set a hero's trust on its current assignment (probation | trusted). */
export function setTrust(heroId, level) {
  if (!heroId) throw new Error("hero id required");
  if (!["probation", "trusted"].includes(level)) throw new Error('trust must be "probation" or "trusted"');
  const state = loadPackWearables();
  const eq = state.equipped[String(heroId)];
  if (!eq) throw new Error(`${heroId} has no assigned role — equip a pack first`);
  eq.trust = level;
  if (level === "trusted") eq.promotedAt = new Date().toISOString();
  savePackWearables(state);
  return eq;
}

/** Re-render hero workspaces (AGENTS.md hire sheets). */
function refreshWorkspaces({ background = false } = {}) {
  const args = [join(ROOT, "scripts", "openclaw-fleet.mjs"), "refresh-workspaces", "--quiet"];
  if (background) {
    try {
      const child = spawn(process.execPath, args, { cwd: ROOT, stdio: "ignore", detached: true });
      child.unref();
      return true;
    } catch {
      return false;
    }
  }
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "ignore", timeout: 60000 });
  return r.status === 0;
}

export function getEquipped(heroId) {
  const state = loadPackWearables();
  return state.equipped[String(heroId)] || null;
}

/** Slice for cartridge checkpoint gameState.equippedPacks */
export function packWearableCheckpointSlice() {
  const state = loadPackWearables();
  const byHero = {};
  for (const [hero, eq] of Object.entries(state.equipped || {})) {
    byHero[hero] = {
      packId: eq.packId,
      slot: eq.slot ?? ASSIGNMENT_SLOT,
      equippedAt: eq.equippedAt || null,
    };
  }
  return {
    assignmentSlot: state.assignmentSlot ?? ASSIGNMENT_SLOT,
    nested: Object.keys(state.nested || {}),
    byHero,
    updatedAt: state.updatedAt || new Date().toISOString(),
    _comment:
      "Marketplace bot templates nested on cart; equipped slot 15 = assignment label (not L1 aesthetic).",
  };
}

function usage() {
  console.error(`usage:
  pack-wearable list [--json]
  pack-wearable nest <packId>
  pack-wearable equip <hero> <packId> [--slot 15]
  pack-wearable unequip <hero>
  pack-wearable trust <hero> probation|trusted
  pack-wearable status [<hero>] [--json]
  pack-wearable clear-all [--reason transfer]`);
  process.exit(2);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const json = rest.includes("--json");
  const args = rest.filter((a) => a !== "--json");
  if (!cmd) usage();

  if (cmd === "list") {
    const state = loadPackWearables();
    if (json) {
      console.log(JSON.stringify(state, null, 2));
      return;
    }
    console.log(`assignment slot  ${state.assignmentSlot}`);
    console.log(`nested (${Object.keys(state.nested).length}):`);
    for (const id of Object.keys(state.nested).sort()) {
      console.log(`  · ${id}`);
    }
    console.log(`equipped (${Object.keys(state.equipped).length}):`);
    for (const [hero, eq] of Object.entries(state.equipped).sort()) {
      console.log(`  · ${hero} → ${eq.packId}  (slot ${eq.slot})`);
    }
    return;
  }

  if (cmd === "nest") {
    const packId = args[0];
    if (!packId) usage();
    const state = nestPack(packId);
    console.log(`nested ${packId}`);
    console.log(`  inventory: ${Object.keys(state.nested).join(", ")}`);
    return;
  }

  if (cmd === "equip") {
    const hero = args[0];
    const packId = args[1];
    if (!hero || !packId) usage();
    let slot = ASSIGNMENT_SLOT;
    const si = args.indexOf("--slot");
    if (si >= 0 && args[si + 1]) slot = Number(args[si + 1]);
    const eq = equipPack(hero, packId, { slot });
    console.log(`equipped ${hero} → ${eq.packId}  (slot ${eq.slot})  trust ${eq.trust}`);
    const proj = currentProjectSlug();
    console.log(proj ? `  role set in project ${proj} (its workbench; other projects unchanged)` : "  role set desk-wide (no project selected)");
    // Re-render workspaces so the hero's AGENTS.md carries the new hire sheet.
    // Background: the avatar's Assign role waits on this command.
    refreshWorkspaces({ background: true });
    return;
  }

  if (cmd === "trust") {
    const hero = args[0];
    const level = args[1];
    if (!hero || !level) usage();
    const eq = setTrust(hero, level);
    console.log(`${hero} → ${eq.packId}  trust ${eq.trust}`);
    const ok = refreshWorkspaces({ background: false });
    console.log(ok ? "  workspaces re-rendered (hire sheet updated)" : "  re-render failed — run: node scripts/openclaw-fleet.mjs refresh-workspaces");
    return;
  }

  if (cmd === "unequip") {
    const hero = args[0];
    if (!hero) usage();
    const prev = unequipPack(hero);
    console.log(prev ? `unequipped ${hero} (was ${prev.packId})` : `${hero} had no pack`);
    return;
  }

  if (cmd === "status") {
    const hero = args[0];
    const state = loadPackWearables();
    if (hero) {
      const eq = state.equipped[hero] || null;
      if (json) console.log(JSON.stringify({ hero, equipped: eq }, null, 2));
      else if (eq) console.log(`${hero} → ${eq.packId}  slot ${eq.slot}`);
      else console.log(`${hero} → (no pack equipped)`);
      return;
    }
    if (json) console.log(JSON.stringify(packWearableCheckpointSlice(), null, 2));
    else {
      console.log(JSON.stringify(packWearableCheckpointSlice(), null, 2));
    }
    return;
  }

  if (cmd === "clear-all") {
    let reason = "transfer";
    const ri = args.indexOf("--reason");
    if (ri >= 0 && args[ri + 1]) reason = args[ri + 1];
    clearAllPackWearables(reason);
    console.log(`pack wearables cleared (${reason})`);
    return;
  }

  usage();
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e?.message || e);
    process.exit(1);
  });
}
