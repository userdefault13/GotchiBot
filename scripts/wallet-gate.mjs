#!/usr/bin/env node
/**
 * Pre-spawn gate: wallet connected + cartridge + at least one cAavegotchi.
 * Exit 0 + JSON on stdout when allowed; exit 1 + human message on stderr when blocked.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { call, loadMeta, GAME_ID } from "./identity.mjs";

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

  if (cartridgeId) {
    const snap = await call(`/cartridges/${cartridgeId}`);
    if (snap.ok) {
      const c = snap.data.cartridge ?? snap.data;
      heroes = c.cAavegotchis ?? [];
      activeHeroId = activeHeroId ?? c.activeCAavegotchi?.id ?? heroes[0]?.id ?? null;
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

function isDirectRun() {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
