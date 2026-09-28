#!/usr/bin/env node
/**
 * Where a marketplace template lands: a new cAavegotchi ($5 mint) or an
 * existing one with no assignment (no role, or the generic `worker` seat).
 * The orchestrator, built-in heroes and standing desks are never offered.
 *
 *   node scripts/template-seat.mjs list [--json]
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";
import { loadMeta } from "./identity.mjs";
import { fetchCartridgeHeroes, loadBaseStarterCollaterals } from "./onboarding-lib.mjs";
import { builtinHeroes, heroDisplayName, orchestratorHeroId } from "./openclaw-fleet.mjs";
import { STANDING } from "./ensure-prof-worker.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROLES_PATH = `${ROOT}/config/agent-roles.json`;
const GENERIC_ROLE = "worker";

function readRoles() {
  try {
    return JSON.parse(readFileSync(ROLES_PATH, "utf8")) || {};
  } catch {
    return {};
  }
}

export function heroRole(heroId, roles = readRoles()) {
  const row = roles?.[heroId];
  if (!row) return null;
  if (typeof row === "string") return row;
  return row.roleId || row.role || row.packId || null;
}

/**
 * Can `roleId` be seated on `heroId` without taking it from another job?
 * Re-applying the hero's own role is allowed (standing-duty rewiring).
 * @returns {{ ok: boolean, reason?: string, role?: string|null }}
 */
export function seatCheck(heroId, roleId = null) {
  const id = String(heroId || "").trim();
  if (!id) return { ok: false, reason: "hero id required" };
  if (builtinHeroes().some((b) => b.id === id)) {
    return { ok: false, reason: `${id} is a built-in hero, not a cAavegotchi seat` };
  }
  const role = heroRole(id);
  if (roleId && role === roleId) return { ok: true, role };
  if (id === orchestratorHeroId()) return { ok: false, role, reason: `${id} is the orchestrator` };
  if (STANDING.has(id)) return { ok: false, role, reason: `${id} is a standing desk` };
  if (role && role !== GENERIC_ROLE) return { ok: false, role, reason: `${id} is already seated as ${role}` };
  return { ok: true, role };
}

async function cartridgeHeroIds(cartridgeId) {
  return (await fetchCartridgeHeroes(cartridgeId)).map((h) => String(h.id));
}

/** Cartridge cAavegotchis a template can take right now. */
export async function unassignedHeroes() {
  const meta = loadMeta();
  if (!meta?.cartridgeId) return [];
  const ids = await cartridgeHeroIds(meta.cartridgeId);
  return ids
    .filter((id) => seatCheck(id).ok)
    .map((id) => ({ id, name: heroDisplayName(id), role: heroRole(id) }));
}

/** Starter collaterals keyed `<spirit>` (haunt 1) or `<spirit>:h2` — both haunts share spirit ids. */
export function mintCollaterals() {
  return loadBaseStarterCollaterals().map((c) => ({
    ...c,
    key: Number(c.hauntId) === 2 ? `${c.id}:h2` : c.id,
  }));
}

function findMintCollateral(key) {
  return mintCollaterals().find((c) => c.key === String(key || "").trim().toLowerCase()) || null;
}

/** Mint a new cAavegotchi for a template ($5) — MetaMask bindStarter on Base Sepolia. */
export async function mintTemplateHero(collateral) {
  const option = findMintCollateral(collateral);
  if (!option) throw new Error(`unknown starter collateral "${collateral}"`);
  const { bindStarterToDesk } = await import("./cartridge-mint-sepolia.mjs");
  console.log(`  MetaMask bindStarter · ${option.libraryName} · $5 — confirm in the browser…`);
  return bindStarterToDesk(option);
}

async function main() {
  const [cmd = "list", ...rest] = process.argv.slice(2);
  if (cmd !== "list") {
    console.error("usage: template-seat.mjs list [--json]");
    process.exit(2);
  }
  const heroes = await unassignedHeroes();
  if (rest.includes("--json")) {
    console.log(JSON.stringify({ heroes }, null, 2));
    return;
  }
  if (!heroes.length) {
    console.log("no unassigned cAavegotchis — mint one: templates apply <id> --mint <collateral> --yes");
    return;
  }
  for (const h of heroes) console.log(`${h.id}\t${h.name || ""}\t${h.role || "-"}`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e?.message || e);
    process.exit(1);
  });
}
