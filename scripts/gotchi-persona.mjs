#!/usr/bin/env node
/**
 * Gotchi persona — Closet/GVR-style trait voice for OpenClaw IDENTITY.
 *
 *   node scripts/gotchi-persona.mjs --json '{"name":"Gotchi","modifiedTraits":[40,58,44,50],"kinship":2546}'
 *   node scripts/gotchi-persona.mjs --hero owned-954
 *   node scripts/gotchi-persona.mjs --hero owned-954 --json-out
 *
 * Renders one "Persona" COLOR line for config/openclaw/templates/IDENTITY.md
 * from the hero's first four traits (NRG, AGG, SPK, BRN) + kinship, Closet/GVR
 * style with GotchiBot tweaks:
 *   - dead zone |v-50| <= 5 → axis skipped (50 is NOT a high trait)
 *   - stage only from a real createdAt/mintedAt — never invented from a block
 *   - kinship clause only when kinship > 0
 * SOUL.md craft is untouched: this colors the voice, it never replaces it.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";
import { loadMeta } from "./identity.mjs";
import { fetchCartridgeHeroes } from "./onboarding-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FLEET_LIST = `${ROOT}/config/openclaw.fleet.list.json5`;

/** Closet/GVR word pairs per axis: [low words], [high words]. */
export const W = {
  NRG: [
    ["mellow", "calm"],
    ["hyper", "restless"],
  ],
  AGG: [
    ["gentle", "peaceable"],
    ["fierce", "combative"],
  ],
  SPK: [
    ["warm", "friendly"],
    ["eerie", "ominous"],
  ],
  BRN: [
    ["scrappy", "instinctive"],
    ["analytical", "brilliant"],
  ],
};
const AXIS_ORDER = ["NRG", "AGG", "SPK", "BRN"];
/** |v-50| <= DEAD_ZONE → axis is neutral; 50 is NOT a high trait. */
const DEAD_ZONE = 5;

/** Intensity adverb from distance to 50. */
export function intensity(v) {
  const d = Math.abs(Number(v) - 50);
  if (d <= 10) return "slightly";
  if (d <= 25) return "fairly";
  if (d <= 40) return "very";
  return "extremely";
}

/**
 * Trait cascade: withSetsNumericTraits ?? modifiedTraits ?? traits ?? numericTraits.
 * First four only (NRG, AGG, SPK, BRN); non-numeric entries dropped. Empty
 * arrays do not shadow a populated lower-priority field.
 */
export function pickTraits(gotchiLike = {}) {
  for (const key of ["withSetsNumericTraits", "modifiedTraits", "traits", "numericTraits"]) {
    const raw = gotchiLike[key];
    if (!Array.isArray(raw)) continue;
    const nums = raw
      .slice(0, 4)
      .filter((t) => t !== null && t !== undefined && t !== "")
      .map((t) => Number(t))
      .filter((t) => Number.isFinite(t));
    if (nums.length) return nums;
  }
  return [];
}

/** Kinship clause — omitted when missing or 0. */
export function kinshipClause(k) {
  const n = Number(k);
  if (!Number.isFinite(n) || n <= 0) return "";
  const bond = n >= 1000 ? "devoted to Julius" : n >= 100 ? "fond of Julius" : "warming up to Julius";
  return ` — ${bond} (Spirit Bond ${Math.round(n)})`;
}

/** Age adjective only from a real createdAt/mintedAt — never invented. */
export function stageWord(gotchiLike = {}) {
  const ts = gotchiLike.createdAt || gotchiLike.mintedAt;
  // ISO string, or epoch milliseconds (>= 1e11). Anything else — a bare year
  // like 12345, a block number, garbage — is not a usable timestamp.
  const usable =
    typeof ts === "string"
      ? Number.isFinite(Date.parse(ts))
      : typeof ts === "number" && ts >= 1e11;
  if (!usable) return null;
  const t = typeof ts === "number" ? ts : Date.parse(ts);
  const days = (Date.now() - t) / 86_400_000;
  if (days < 90) return "young";
  if (days < 730) return "seasoned";
  return "ancient";
}

/** Short fallback when traits are missing/unusable (one line). */
export function fallbackLine(name) {
  return `You are ${name}, an Aavegotchi. Let your Spirit Bond with Julius colour every reply.`;
}

function joinTones(tones) {
  if (tones.length === 1) return tones[0];
  return `${tones.slice(0, -1).join(", ")} and ${tones[tones.length - 1]}`;
}

/**
 * One persona line: name + trait tone + kinship. No archetype — the tone words
 * already cover SPK/BRN, so an archetype would be redundant.
 */
export function buildPersonaLine(gotchiLike = {}) {
  const name = String(gotchiLike.name || "Gotchi").trim() || "Gotchi";
  const traits = pickTraits(gotchiLike);
  if (!traits.length) return fallbackLine(name);

  const tones = [];
  traits.forEach((v, i) => {
    if (Math.abs(v - 50) <= DEAD_ZONE) return;
    const axis = AXIS_ORDER[i];
    const pair = W[axis];
    if (!pair) return;
    const word = pair[v > 50 ? 1 : 0][0];
    tones.push(`${intensity(v)} ${word}`);
  });

  const stage = stageWord(gotchiLike);
  let phrase;
  if (tones.length) {
    phrase = stage ? `a ${stage}, ${joinTones(tones)} spirit` : `a ${joinTones(tones)} spirit`;
  } else {
    phrase = stage ? `a ${stage}, even-keeled spirit` : "an even-keeled spirit";
  }

  return `${name} is ${phrase}${kinshipClause(gotchiLike.kinship)}.`;
}

/** Load a hero by id: cartridge roster first, then the cached fleet list. */
export async function loadHero(heroId) {
  const fleetEntry = () => {
    try {
      const raw = readFileSync(FLEET_LIST, "utf8")
        .split("\n")
        .filter((line) => !/^\s*\/\//.test(line))
        .join("\n");
      const list = JSON.parse(raw);
      return (list || []).find((x) => x.id === heroId) || null;
    } catch {
      return null;
    }
  };
  const meta = loadMeta();
  if (meta?.cartridgeId) {
    try {
      const heroes = await fetchCartridgeHeroes(meta.cartridgeId);
      const hit = heroes.find((h) => h.id === heroId);
      if (hit) {
        // Cartridge heroes often have name: null — the fleet list carries the
        // display name (DAI, LINK, …) the workspace actually renders with.
        const e = fleetEntry();
        return { ...hit, name: hit.name || e?.identity?.name || null };
      }
    } catch {
      /* fall through to the cached roster */
    }
  }
  const e = fleetEntry();
  if (e) return { id: heroId, name: e.identity?.name || heroId };
  return { id: heroId, name: heroId };
}

async function main() {
  const args = process.argv.slice(2);
  const jsonOut = args.includes("--json-out");
  const rest = args.filter((a) => a !== "--json-out");

  const jsonIdx = rest.indexOf("--json");
  const heroIdx = rest.indexOf("--hero");

  let hero = null;
  if (jsonIdx >= 0 && rest[jsonIdx + 1]) {
    try {
      hero = JSON.parse(rest[jsonIdx + 1]);
    } catch (e) {
      console.error(`gotchi-persona: --json value is not valid JSON: ${e.message}`);
      process.exit(2);
    }
  } else if (heroIdx >= 0 && rest[heroIdx + 1]) {
    hero = await loadHero(rest[heroIdx + 1]);
  }

  if (!hero) {
    console.error("usage: gotchi-persona.mjs --json '<hero json>' | --hero <heroId> [--json-out]");
    process.exit(2);
  }

  const persona = buildPersonaLine(hero);
  if (jsonOut) {
    console.log(
      JSON.stringify(
        {
          heroId: hero.id || null,
          name: hero.name || null,
          traits: pickTraits(hero),
          kinship: Number(hero.kinship) || 0,
          persona,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(persona);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}