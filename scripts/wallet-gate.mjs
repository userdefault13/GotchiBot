#!/usr/bin/env node
/**
 * Pre-spawn gate: wallet connected + cartridge + at least one cAavegotchi.
 * Exit 0 + JSON on stdout when allowed; exit 1 + human message on stderr when blocked.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { call, loadMeta, GAME_ID } from "./identity.mjs";
import { isMainModule } from "./is-main.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WALLET = `${ROOT}/sessions/.wallet.json`;

function readWallet() {
  try {
    const w = JSON.parse(readFileSync(WALLET, "utf8"));
    return w.address ?? null;
  } catch {
    return null;
  }
}

function fail(code, message, fix) {
  const out = { ok: false, code, message, fix };
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.error(`✗ ${message}`);
    if (fix) console.error(`  → ${fix}`);
  }
  process.exit(code === "wallet" ? 10 : code === "cartridge" ? 11 : 12);
}

/** Heroes this desk has seen before — used only when the API is unreachable. */
function cachedHeroIds() {
  const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
  for (const rel of ["sessions/.hero-agent-state.json", "sessions/.openclaw-agent-map.json"]) {
    try {
      const raw = JSON.parse(readFileSync(`${ROOT_DIR}/${rel}`, "utf8"));
      const ids = rel.includes("agent-map") ? Object.keys(raw?.agents || {}) : Object.keys(raw || {});
      const real = ids.filter((id) => id && id !== "gotchi");
      if (real.length) return real;
    } catch {
      /* try the next cache */
    }
  }
  return [];
}

/** Opt-in escape hatch for "the sim is down but the heroes are real". */
const ALLOW_CACHED = process.env.GOTCHIBOT_GATE_ALLOW_CACHED === "1";

export async function checkSpawnGate({ quiet = false } = {}) {
  const owner = readWallet();
  if (!owner) {
    return {
      ok: false,
      code: "wallet",
      message: "No wallet connected.",
      fix: "./scripts/gotchibot connect",
    };
  }

  const meta = loadMeta();
  let cartridgeId = meta?.cartridgeId ?? null;
  let heroes = [];
  let activeHeroId = meta?.activeHeroId ?? null;

  // Track reachability separately: "the API said you have no heroes" and "the
  // API never answered" are different problems with different fixes, and the
  // second one used to be reported as the first — which sends you to
  // `identity bind`, i.e. towards minting, over a container that is merely down.
  let apiReachable = false;
  let apiError = null;

  if (cartridgeId) {
    const snap = await call(`/cartridges/${cartridgeId}`);
    if (snap.ok) {
      apiReachable = true;
      const c = snap.data.cartridge ?? snap.data;
      heroes = c.cAavegotchis ?? [];
      activeHeroId = activeHeroId ?? c.activeCAavegotchi?.id ?? heroes[0]?.id ?? null;
    } else {
      apiError = snap.data?.error || `HTTP ${snap.status}`;
    }
  }

  if (!cartridgeId || heroes.length === 0) {
    const roster = await call(`/cartridges?owner=${encodeURIComponent(owner)}&gameId=${GAME_ID}`);
    if (roster.ok) {
      const list = roster.data.cartridges ?? roster.data ?? [];
      const cart = Array.isArray(list) ? list[0] : list.cartridge ?? list;
      if (cart) {
        cartridgeId = cart.id ?? cart.cartridgeId ?? cartridgeId;
        heroes = cart.cAavegotchis ?? heroes;
        activeHeroId = activeHeroId ?? cart.activeCAavegotchi?.id ?? heroes[0]?.id ?? null;
      }
    }
  }

  if (!cartridgeId) {
    return {
      ok: false,
      code: "cartridge",
      message: "No gotchibot cartridge yet.",
      fix: "abra run gotchibot -- ./scripts/gotchibot init",
    };
  }

  if (heroes.length === 0 && !apiReachable) {
    const cached = cachedHeroIds();
    if (ALLOW_CACHED && cached.length) {
      console.error(
        `[gate] cartridge API unreachable (${apiError || "no answer"}) — proceeding on ${cached.length} cached hero(es) ` +
          `because GOTCHIBOT_GATE_ALLOW_CACHED=1. Hero state may be stale.`,
      );
      heroes = cached.map((id) => ({ id, role: null }));
      activeHeroId = activeHeroId ?? cached[0];
    } else {
      return {
        ok: false,
        code: "cartridge-unreachable",
        message: `Cartridge API did not answer (${apiError || "no answer"}) — this is an infra problem, not a missing hero.`,
        fix:
          "Check the sim: ./scripts/gotchibot remote -- docker ps --filter name=cartridge (load skill infra-recover). " +
          "If you know your heroes exist and need to work now: GOTCHIBOT_GATE_ALLOW_CACHED=1",
        owner,
        cartridgeId,
        cachedHeroes: cached.length,
      };
    }
  }

  if (heroes.length === 0) {
    return {
      ok: false,
      code: "heroes",
      message: "Cartridge has no cAavegotchis — bind a starter or open a portal pack.",
      fix: "abra run gotchibot -- ./scripts/gotchibot identity bind",
      owner,
      cartridgeId,
    };
  }

  const result = {
    ok: true,
    owner,
    cartridgeId,
    heroCount: heroes.length,
    activeHeroId,
    heroes: heroes.map((h) => ({ id: h.id, role: h.role ?? null })),
  };
  if (!quiet) return result;
  return result;
}

async function main() {
  const gate = await checkSpawnGate();
  if (!gate.ok) fail(gate.code, gate.message, gate.fix);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(gate, null, 2));
  } else {
    console.log(
      `✓ wallet ${gate.owner.slice(0, 6)}…${gate.owner.slice(-4)} | ` +
        `cartridge ${gate.cartridgeId} | ${gate.heroCount} cAavegotchi(s)` +
        (gate.activeHeroId ? ` | hero ${gate.activeHeroId}` : ""),
    );
  }
}


if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
