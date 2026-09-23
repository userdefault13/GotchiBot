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
import { readGotchiBotCartridgeSepolia } from "./cartridge-sepolia.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WALLET = `${ROOT}/sessions/.wallet.json`;

const CONCIERGE_URL = "https://www.aarcadeghst.com/concierge/terminal";
const SETUP_URL = "https://www.aarcadeghst.com/gotchibot/setup";
const LICENSE_STEPS = [
  "Mint the GotchiBot license NFT at the Concierge terminal",
  "Seal it into a cartridge (nested license)",
  "Open the sealed cartridge",
  "Bind / activate it for GotchiBot",
];

function readWallet() {
  try {
    const w = JSON.parse(readFileSync(WALLET, "utf8"));
    return w.address ?? null;
  } catch {
    return null;
  }
}

function fail(code, message, fix, extra = {}) {
  const assist =
    code === "cartridge" || code === "sealed" || code === "heroes"
      ? { fixUrl: CONCIERGE_URL, setupUrl: SETUP_URL, howto: LICENSE_STEPS }
      : {};
  const out = { ok: false, code, message, fix, ...assist, ...extra };
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.error(`✗ ${message}`);
    if (fix) console.error(`  → ${fix}`);
    if (out.fixUrl) console.error(`  mint: ${out.fixUrl}`);
    if (out.setupUrl) console.error(`  setup: ${out.setupUrl}`);
  }
  process.exit(code === "wallet" ? 10 : code === "cartridge" || code === "sealed" ? 11 : 12);
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

  // Base Sepolia nest is authoritative. SIM is legacy — only used when Sepolia
  // is explicitly opted out (GOTCHIBOT_CARTRIDGE_CHAIN=sim) or diamond config is missing.
  const preferSepolia =
    process.env.GOTCHIBOT_CARTRIDGE_CHAIN !== "sim" &&
    process.env.GOTCHIBOT_CARTRIDGE_CHAIN !== "local" &&
    (process.env.GOTCHIBOT_CARTRIDGE_CHAIN === "sepolia" ||
      process.env.GOTCHIBOT_CARTRIDGE_CHAIN === "84532" ||
      process.env.GOTCHIBOT_PREFER_SEPOLIA === "1" ||
      process.env.GOTCHIBOT_PREFER_SEPOLIA !== "0");
  if (preferSepolia) {
    try {
      const sep = await readGotchiBotCartridgeSepolia(owner);
      if (sep.reason === "missing_diamond_config") {
        return {
          ok: false,
          code: "cartridge",
          message: "Base Sepolia diamond config missing — cannot use nest desk.",
          fix: "Set cartridgeDiamond / nest in config/cartridgeChain.base-sepolia.json · Concierge: " + CONCIERGE_URL,
          fixUrl: CONCIERGE_URL,
          setupUrl: SETUP_URL,
          howto: LICENSE_STEPS,
          source: "sepolia",
        };
      } else if (!sep.cartridgeId) {
        return {
          ok: false,
          code: "cartridge",
          message: "No gotchibot cartridge on Base Sepolia yet — mint and open one first.",
          fix:
            "Mint at Concierge: " +
            CONCIERGE_URL +
            " · setup: " +
            SETUP_URL +
            " · steps: " +
            LICENSE_STEPS.join(" → "),
          fixUrl: CONCIERGE_URL,
          setupUrl: SETUP_URL,
          howto: LICENSE_STEPS,
          source: "sepolia",
        };
      } else if (sep.ok) {
        return {
          ok: true,
          owner,
          cartridgeId: sep.cartridgeId,
          heroCount: sep.heroCount,
          activeHeroId: sep.heroes[0] || activeHeroId,
          heroes: sep.heroes.map((id) => ({ id, role: null })),
          source: "sepolia",
          portalStatus: sep.portalStatus,
          licenseNested: sep.licenseNested,
        };
      } else if (sep.reason === "sealed_open_required") {
        return {
          ok: false,
          code: "sealed",
          message: "GotchiBot cartridge is sealed — open it before binding heroes.",
          fix:
            "Open on-chain (GotchiBotNestFacet.open) then bind owned/starter/rental. Mint/open at Concierge: " +
            CONCIERGE_URL +
            " · setup: " +
            SETUP_URL,
          fixUrl: CONCIERGE_URL,
          setupUrl: SETUP_URL,
          howto: LICENSE_STEPS,
          owner,
          cartridgeId: sep.cartridgeId,
          portalStatus: sep.portalStatus,
          licenseNested: sep.licenseNested,
          source: "sepolia",
        };
      } else if (sep.reason === "no_heroes_bind_required") {
        return {
          ok: false,
          code: "heroes",
          message: "Open cartridge has no cAavegotchis — bind a starter or owned gotchi.",
          fix:
            "Bind via Aarcade / ChainCartridgeProvider bindStarter|bindOwned. Mint/open at Concierge: " +
            CONCIERGE_URL +
            " · setup: " +
            SETUP_URL,
          fixUrl: CONCIERGE_URL,
          setupUrl: SETUP_URL,
          howto: LICENSE_STEPS,
          owner,
          cartridgeId: sep.cartridgeId,
          portalStatus: sep.portalStatus,
          licenseNested: sep.licenseNested,
          source: "sepolia",
        };
      }
    } catch (e) {
      if (!quiet) {
        console.error(`[gate] sepolia read failed: ${e?.message || e} — not falling back to SIM`);
      }
      return {
        ok: false,
        code: "cartridge",
        message: `Base Sepolia read failed: ${e?.message || e}`,
        fix: "Check RPC / diamond config, or mint/open at Concierge: " + CONCIERGE_URL,
        fixUrl: CONCIERGE_URL,
        setupUrl: SETUP_URL,
        howto: LICENSE_STEPS,
        source: "sepolia",
      };
    }
    // Prefer Sepolia but no usable cart result above — fail closed (no SIM).
    return {
      ok: false,
      code: "cartridge",
      message: "No usable GotchiBot cartridge on Base Sepolia.",
      fix: "Mint/open at Concierge: " + CONCIERGE_URL + " · setup: " + SETUP_URL,
      fixUrl: CONCIERGE_URL,
      setupUrl: SETUP_URL,
      howto: LICENSE_STEPS,
      source: "sepolia",
    };
  }

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
      message: "No gotchibot cartridge yet — mint and open one first.",
      fix:
        "Mint at Concierge: " +
        CONCIERGE_URL +
        " · setup: " +
        SETUP_URL +
        " · steps: " +
        LICENSE_STEPS.join(" → "),
      fixUrl: CONCIERGE_URL,
      setupUrl: SETUP_URL,
      howto: LICENSE_STEPS,
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
      fix:
        "Mint/open at Concierge: " +
        CONCIERGE_URL +
        " · setup: " +
        SETUP_URL +
        " · steps: " +
        LICENSE_STEPS.join(" → "),
      fixUrl: CONCIERGE_URL,
      setupUrl: SETUP_URL,
      howto: LICENSE_STEPS,
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
  if (!gate.ok) {
    fail(gate.code, gate.message, gate.fix, {
      ...(gate.fixUrl ? { fixUrl: gate.fixUrl } : {}),
      ...(gate.setupUrl ? { setupUrl: gate.setupUrl } : {}),
      ...(gate.howto ? { howto: gate.howto } : {}),
      ...(gate.owner ? { owner: gate.owner } : {}),
      ...(gate.cartridgeId ? { cartridgeId: gate.cartridgeId } : {}),
    });
  }
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
