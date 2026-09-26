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
 *   node scripts/pack-wearable.mjs equip <hero> <packId> [--slot 15] [--force] [--project <slug>]
 *   node scripts/pack-wearable.mjs unequip <hero>
 *   node scripts/pack-wearable.mjs status [<hero>] [--json]
 *   node scripts/pack-wearable.mjs clear-all [--reason transfer]
 *
 * Equip runs the apply gate (cartridge roster + available + starter crew) unless
 * GOTCHIBOT_APPLY_GATE_OK=1 (set by template-pack apply) or --force.
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";

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
  state.equipped[String(heroId)] = {
    packId: id,
    slot: slotIndex,
    equippedAt: new Date().toISOString(),
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
  pack-wearable equip <hero> <packId> [--slot 15] [--force] [--project <slug>]
  pack-wearable unequip <hero>
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
    const force = args.includes("--force");
    const pi = args.indexOf("--project");
    const project = pi >= 0 && args[pi + 1] ? args[pi + 1] : null;

    // Apply gate when invoked directly (template-pack apply sets GOTCHIBOT_APPLY_GATE_OK=1).
    const { assertHeroApplicable, formatGateFailure } = await import("./hero-apply-gate.mjs");
    const { currentProjectSlug } = await import("./project-context.mjs");
    const gate = await assertHeroApplicable(hero, {
      project: project || currentProjectSlug() || null,
      force,
    });
    for (const w of gate.warnings || []) console.error(w.startsWith("WARNING") ? w : `warning: ${w}`);
    if (!gate.ok) {
      for (const line of formatGateFailure(gate)) console.error(line);
      process.exit(2);
    }

    const eq = equipPack(hero, packId, { slot });
    console.log(`equipped ${hero} → ${eq.packId}  (slot ${eq.slot})`);
    console.log("  agent-roles.json synced (assignment label)");
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
