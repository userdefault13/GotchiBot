/**
 * Shared gate for template-pack apply / pack-wearable equip / prof-link-cube resummon.
 *
 * Verifies:
 *   (a) hero is on the user's cartridge roster (SIM or sepolia; offline → local fallback + warning)
 *   (b) status is `available` (standing desks + orchestrator excluded — same as assertSandboxHeroAvailable)
 *   (c) if starter, not already on another project's crew
 *
 * `template-pack install` must NEVER call this — install stays free, no hero required.
 *
 * Skip re-check when GOTCHIBOT_APPLY_GATE_OK=1 (set by template-pack apply after it already gated),
 * regardless of `--force`.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { heroKind, isOrchestratorHero } from "./hero-kind.mjs";
import {
  getCachedHeroStatus,
  STANDING_DESK_HEROES,
} from "./hero-agent-state.mjs";
import {
  checkCrewConflict,
  currentProjectSlug,
  findCrewsForHero,
} from "./project-context.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export { STANDING_DESK_HEROES };

function sessionsDir() {
  const o = process.env.GOTCHIBOT_SESSIONS_DIR;
  return o ? resolve(o) : join(ROOT, "sessions");
}

function localHeroIdsFromCache() {
  const ids = new Set();
  const cachePath = join(sessionsDir(), ".hero-agent-state.json");
  try {
    if (existsSync(cachePath)) {
      const cache = JSON.parse(readFileSync(cachePath, "utf8"));
      for (const k of Object.keys(cache || {})) {
        if (k === "heroes" || k === "updatedAt" || k === "version") continue;
        if (cache.heroes && typeof cache.heroes === "object") {
          for (const id of Object.keys(cache.heroes)) ids.add(id);
        }
        if (typeof cache[k] === "object" && cache[k] !== null) ids.add(k);
      }
    }
  } catch {
    /* ignore */
  }
  // Fleet / onboarding crumbs
  for (const rel of [".onboarding.json", ".focus.json"]) {
    try {
      const p = join(sessionsDir(), rel);
      if (!existsSync(p)) continue;
      const j = JSON.parse(readFileSync(p, "utf8"));
      if (Array.isArray(j.heroes)) for (const h of j.heroes) ids.add(String(h.id || h));
      if (j.heroId) ids.add(String(j.heroId));
      if (j.focus) ids.add(String(j.focus));
    } catch {
      /* ignore */
    }
  }
  return [...ids];
}

/**
 * Normalize roster entries: strings or {id, agentStatus, bindType}.
 * @param {unknown[]} heroes
 * @returns {{ id: string, agentStatus?: string, bindType?: string }[]}
 */
export function normalizeRosterEntries(heroes) {
  if (!Array.isArray(heroes)) return [];
  const out = [];
  for (const h of heroes) {
    if (h == null) continue;
    if (typeof h === "string" || typeof h === "number") {
      const id = String(h).trim();
      if (id) out.push({ id });
      continue;
    }
    if (typeof h === "object") {
      const id = String(h.id || h.heroId || "").trim();
      if (!id) continue;
      const entry = { id };
      if (h.agentStatus != null) entry.agentStatus = String(h.agentStatus);
      if (h.bindType != null) entry.bindType = String(h.bindType);
      else if (h.bind != null) entry.bindType = String(h.bind);
      out.push(entry);
    }
  }
  return out;
}

/**
 * Pure Sepolia bytes32 ↔ hero-id matcher (no network).
 * On-chain formulas are authoritative:
 *   owned-<n> → solidityPackedKeccak256(["string","uint256"], ["owned-", n])
 *   starter-* → sessions/.onchain-hero-ids.json mapping (injectable via opts.onchainHeroIds)
 * encodeBytes32String / ethers.id remain as harmless fallbacks only.
 *
 * @param {string} entry hex/bytes32 or plain id
 * @param {string} heroId e.g. owned-123
 * @param {{ encodeBytes32String?: Function, decodeBytes32String?: Function, id?: Function, solidityPackedKeccak256?: Function } | null} [ethersLike]
 * @param {{ onchainHeroIds?: Record<string, {heroIdBytes32?: string}>, loadOnchainHeroIds?: Function }} [opts]
 * @returns {boolean}
 */
export function matchSepoliaHeroBytes32(entry, heroId, ethersLike = null, opts = {}) {
  const raw = String(entry || "").trim();
  const id = String(heroId || "").trim();
  if (!raw || !id) return false;
  if (raw === id) return true;

  // Authoritative: owned-<n> on-chain formula
  const ownedM = /^owned-(\d+)$/i.exec(id);
  if (ownedM && ethersLike && typeof ethersLike.solidityPackedKeccak256 === "function") {
    try {
      const h = String(
        ethersLike.solidityPackedKeccak256(["string", "uint256"], ["owned-", BigInt(ownedM[1])]),
      );
      if (h.toLowerCase() === raw.toLowerCase()) return true;
    } catch {
      /* ignore */
    }
  }

  // Authoritative: starter desk id → recorded bytes32 mapping
  let map = opts.onchainHeroIds;
  if (!map && typeof opts.loadOnchainHeroIds === "function") {
    try {
      map = opts.loadOnchainHeroIds();
    } catch {
      map = null;
    }
  }
  if (!map) {
    try {
      const p = join(sessionsDir(), ".onchain-hero-ids.json");
      map = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      map = null;
    }
  }
  if (map && map[id]?.heroIdBytes32) {
    if (String(map[id].heroIdBytes32).toLowerCase() === raw.toLowerCase()) return true;
  }

  if (!ethersLike) return false;

  try {
    if (typeof ethersLike.encodeBytes32String === "function") {
      if (String(ethersLike.encodeBytes32String(id)).toLowerCase() === raw.toLowerCase()) {
        return true;
      }
    }
  } catch {
    /* not encodable as bytes32 */
  }

  try {
    if (typeof ethersLike.id === "function") {
      if (String(ethersLike.id(id)).toLowerCase() === raw.toLowerCase()) {
        return true;
      }
    }
  } catch {
    /* ignore */
  }

  try {
    if (typeof ethersLike.decodeBytes32String === "function" && /^0x[0-9a-fA-F]{64}$/.test(raw)) {
      const decoded = String(ethersLike.decodeBytes32String(raw) || "").trim();
      if (decoded && decoded === id) return true;
    }
  } catch {
    /* undecodable */
  }

  return false;
}

/**
 * Membership check for a sepolia heroIds() list (bytes32 hex strings).
 * @returns {"yes"|"no"|"unknown"}
 */
export function sepoliaRosterMembership(entries, heroId, ethersLike = null, opts = {}) {
  const list = Array.isArray(entries) ? entries.map(String) : [];
  if (!list.length) return "no";

  for (const entry of list) {
    if (matchSepoliaHeroBytes32(entry, heroId, ethersLike, opts)) return "yes";
  }

  // Without ethers we cannot interpret bytes32 → unknown (caller falls back to local cache).
  if (!ethersLike) return "unknown";

  let anyComparable = false;
  for (const entry of list) {
    if (entry === heroId) {
      anyComparable = true;
      continue;
    }
    if (typeof ethersLike.decodeBytes32String === "function" && /^0x[0-9a-fA-F]{64}$/.test(entry)) {
      try {
        const d = String(ethersLike.decodeBytes32String(entry) || "").trim();
        if (d) anyComparable = true;
      } catch {
        /* undecodable garbage */
      }
    }
  }
  try {
    if (typeof ethersLike.encodeBytes32String === "function") {
      ethersLike.encodeBytes32String(heroId);
      anyComparable = true;
    }
  } catch {
    /* id too long for bytes32 string encoding */
  }
  if (typeof ethersLike.id === "function") {
    try {
      ethersLike.id(heroId);
      anyComparable = true;
    } catch {
      /* ignore */
    }
  }
  if (typeof ethersLike.solidityPackedKeccak256 === "function" && /^owned-\d+$/i.test(heroId)) {
    anyComparable = true;
  }

  if (!anyComparable) return "unknown";
  return "no";
}

async function getEthersForSepolia() {
  try {
    return await import("ethers");
  } catch {
    try {
      return await import(resolve(ROOT, "../AarcadeGh-t/node_modules/ethers/lib.esm/index.js"));
    } catch {
      return null;
    }
  }
}

async function defaultFetchRoster() {
  try {
    const { readWalletFile, fetchCartridgeHeroes } = await import("./onboarding-lib.mjs");
    const { loadMeta } = await import("./identity.mjs");
    const meta = typeof loadMeta === "function" ? loadMeta() : null;
    const cartridgeId = meta?.cartridgeId;
    if (cartridgeId) {
      const heroes = await fetchCartridgeHeroes(cartridgeId);
      if (Array.isArray(heroes) && heroes.length) {
        return {
          heroes: normalizeRosterEntries(heroes),
          source: "sim",
        };
      }
    }
    // Sepolia ACART read (may be offline / no RPC)
    try {
      const { readGotchiBotCartridgeSepolia } = await import("./cartridge-sepolia.mjs");
      const owner = readWalletFile?.() || meta?.owner || meta?.wallet;
      if (owner) {
        const snap = await readGotchiBotCartridgeSepolia(owner);
        if (snap?.ok && Array.isArray(snap.heroes) && snap.heroes.length) {
          return {
            heroes: snap.heroes.map((h) => ({ id: String(h) })),
            source: "sepolia",
          };
        }
      }
    } catch {
      /* fall through */
    }
  } catch (e) {
    return { heroes: null, source: "error", error: e?.message || String(e) };
  }
  return { heroes: null, source: "empty" };
}

function resolveStatus(id, entry, statusOf, rosterSource) {
  // SIM roster available: status from agentStatus (default available) — not local cache.
  if (rosterSource === "sim" && entry) {
    return String(entry.agentStatus || "available").toLowerCase();
  }
  if (typeof statusOf === "function") {
    const s = statusOf(id);
    if (s != null && s !== "") return String(s).toLowerCase();
  }
  const cached = getCachedHeroStatus(id);
  return cached ? String(cached).toLowerCase() : null;
}

/**
 * @param {string} heroId
 * @param {{
 *   project?: string|null,
 *   force?: boolean,
 *   fetchRoster?: () => Promise<{heroes: unknown[]|null, source?: string, error?: string}>,
 *   statusOf?: (id: string) => string|null,
 *   ethersLike?: object|null,
 * }} [opts]
 * @returns {Promise<{ok: boolean, reasons: string[], warnings: string[], fixes?: string[]}>}
 */
export async function assertHeroApplicable(heroId, opts = {}) {
  const {
    project = null,
    force = false,
    fetchRoster = defaultFetchRoster,
    statusOf = getCachedHeroStatus,
    ethersLike = undefined,
  } = opts;

  const reasons = [];
  const warnings = [];
  const fixes = [];
  const id = String(heroId || "").trim();

  // Skip regardless of force — template-pack already gated; avoid re-hitting network in resummon.
  if (process.env.GOTCHIBOT_APPLY_GATE_OK === "1") {
    return {
      ok: true,
      reasons: [],
      warnings: ["GOTCHIBOT_APPLY_GATE_OK=1 — apply gate already passed; skipping re-check"],
    };
  }

  if (!id) {
    reasons.push("hero id is required (empty or missing)");
    fixes.push("Pass --hero <id>, e.g. starter-dai-h1-2");
    return finish(false, reasons, warnings, fixes, force);
  }

  if (isOrchestratorHero(id)) {
    reasons.push(`${id} is the orchestrator — not applicable as a worker hero`);
    fixes.push("Pick a different available hero (not owned-954 / gotchi)");
    return finish(false, reasons, warnings, fixes, force);
  }

  if (STANDING_DESK_HEROES.has(id)) {
    reasons.push(`hero ${id} owns an approved standing desk — not available for apply`);
    fixes.push("Pick a different available hero. Trader/comms/infra stay as they are.");
    return finish(false, reasons, warnings, fixes, force);
  }

  // (a) on cartridge roster
  let rosterEntries = null;
  let rosterSource = "unknown";
  try {
    const snap = await fetchRoster();
    rosterSource = snap?.source || "fetch";
    if (Array.isArray(snap?.heroes)) rosterEntries = normalizeRosterEntries(snap.heroes);
    if (snap?.error) warnings.push(`roster fetch note: ${snap.error}`);
  } catch (e) {
    warnings.push(`roster fetch failed: ${e?.message || e}`);
  }

  if (!rosterEntries) {
    const local = localHeroIdsFromCache();
    if (local.length) {
      rosterEntries = local.map((hid) => ({ id: hid }));
      warnings.push(
        `cartridge roster offline/unavailable (${rosterSource}) — falling back to local hero cache`,
      );
      rosterSource = "local";
    } else {
      warnings.push(
        `cartridge roster offline/unavailable (${rosterSource}) — no local hero cache; cannot confirm membership`,
      );
    }
  }

  let onRoster = null;
  let matchedEntry = null;
  if (rosterEntries) {
    if (rosterSource === "sepolia") {
      const ethers =
        ethersLike !== undefined ? ethersLike : await getEthersForSepolia();
      const membership = sepoliaRosterMembership(
        rosterEntries.map((e) => e.id),
        id,
        ethers,
      );
      if (membership === "yes") {
        onRoster = true;
        matchedEntry = rosterEntries.find((e) => matchSepoliaHeroBytes32(e.id, id, ethers)) || {
          id,
        };
      } else if (membership === "unknown") {
        warnings.push(
          "sepolia heroIds are bytes32 and could not be matched — treating membership as unknown; falling back to local cache",
        );
        const local = localHeroIdsFromCache();
        if (local.includes(id)) {
          onRoster = true;
          matchedEntry = { id };
          rosterSource = "local";
        } else if (local.length) {
          onRoster = false;
          rosterEntries = local.map((hid) => ({ id: hid }));
          rosterSource = "local";
        } else {
          onRoster = null; // cannot confirm
        }
      } else {
        onRoster = false;
      }
    } else {
      matchedEntry = rosterEntries.find((e) => e.id === id) || null;
      onRoster = Boolean(matchedEntry);
    }
  }

  if (onRoster === false) {
    reasons.push(`hero ${id} is not on the user's cartridge roster`);
    fixes.push("Mint/bind via onboarding, or pick a hero from the cartridge roster");
  }

  // (b) status available
  const status = resolveStatus(id, matchedEntry, statusOf, rosterSource);
  if (status && status !== "available") {
    reasons.push(`hero ${id} status is "${status}" — apply requires available`);
    fixes.push("Unassign that desk or pick another available hero");
  }

  // (c) starter one-project crew lock
  const kind = heroKind(id, matchedEntry);
  if (kind === "starter") {
    const slug = project || currentProjectSlug() || null;
    if (!slug) {
      const crews = findCrewsForHero(id);
      if (crews.length === 1) {
        warnings.push(
          `starter ${id} is already on project crew "${crews[0]}" (no --project); allowing with warning`,
        );
      } else if (crews.length >= 2) {
        reasons.push(
          `starter ${id} is on multiple project crews (legacy inconsistent): ${crews.join(", ")}`,
        );
        fixes.push(
          `Remove from extra crew(s): node scripts/project-context.mjs crew-remove ${id} <slug>`,
        );
      }
    } else {
      const conflict = checkCrewConflict(id, slug);
      if (!conflict.ok) {
        reasons.push(conflict.message || `starter ${id} is already on another project crew`);
        fixes.push(
          `Remove from other crew(s): node scripts/project-context.mjs crew-remove ${id} <otherSlug>`,
        );
        fixes.push("Or re-run apply after moving the starter with crew-add --move");
      }
    }
  }

  return finish(reasons.length === 0, reasons, warnings, fixes, force);
}

function finish(ok, reasons, warnings, fixes, force) {
  if (!ok && force) {
    warnings.push(
      `WARNING: --force overrides apply gate (${reasons.join("; ")})`,
    );
    return { ok: true, reasons: [], warnings, fixes, forced: true };
  }
  return { ok, reasons, warnings, fixes };
}

/**
 * Heroes eligible to pick when --hero is omitted (non-interactive list).
 * @param {{ fetchRoster?: Function, statusOf?: Function, ethersLike?: object|null }} [opts]
 */
export async function listApplicableHeroes(opts = {}) {
  const {
    fetchRoster = defaultFetchRoster,
    statusOf = getCachedHeroStatus,
    ethersLike = undefined,
  } = opts;
  let entries = [];
  let warnings = [];
  let rosterSource = "unknown";
  try {
    const snap = await fetchRoster();
    rosterSource = snap?.source || "fetch";
    if (Array.isArray(snap?.heroes)) entries = normalizeRosterEntries(snap.heroes);
    else {
      entries = localHeroIdsFromCache().map((id) => ({ id }));
      rosterSource = "local";
      warnings.push("roster offline — listing from local cache");
    }
  } catch {
    entries = localHeroIdsFromCache().map((id) => ({ id }));
    rosterSource = "local";
    warnings.push("roster fetch failed — listing from local cache");
  }

  const ethers =
    rosterSource === "sepolia"
      ? ethersLike !== undefined
        ? ethersLike
        : await getEthersForSepolia()
      : null;

  const available = [];
  for (const entry of entries) {
    let id = entry.id;
    if (rosterSource === "sepolia" && ethers) {
      // Prefer decoded readable id when possible
      try {
        if (ethers.decodeBytes32String && /^0x[0-9a-fA-F]{64}$/.test(id)) {
          const d = String(ethers.decodeBytes32String(id) || "").trim();
          if (d) id = d;
        }
      } catch {
        /* keep hex */
      }
    }
    if (isOrchestratorHero(id)) continue;
    if (STANDING_DESK_HEROES.has(id)) continue;
    const st = resolveStatus(id, entry, statusOf, rosterSource);
    if (st && st !== "available") continue;
    available.push(id);
  }
  return { heroes: available, warnings };
}

/** Print gate failure and suggested fixes; returns exit-style message lines. */
export function formatGateFailure(result) {
  const lines = [];
  for (const r of result.reasons || []) lines.push(`apply gate: ${r}`);
  for (const f of result.fixes || []) lines.push(`  fix: ${f}`);
  for (const w of result.warnings || []) lines.push(`  warning: ${w}`);
  lines.push("  override: pass --force to proceed anyway (prints a WARNING)");
  return lines;
}
