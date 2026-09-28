#!/usr/bin/env node
/**
 * Base Sepolia gotchibot ACART reads — nest / portal / heroes for desk gate.
 * RPC: BASE_SEPOLIA_RPC or https://sepolia.base.org
 * Addresses: config/subgraph.endpoints.json identityLayer + env overrides.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHAIN_ID = 84532;

function loadChainConfig() {
  const candidates = [
    resolve(ROOT, "../AarcadeGh-t/config/cartridgeChain.base-sepolia.json"),
    resolve(ROOT, "config/cartridgeChain.base-sepolia.json"),
  ];
  for (const p of candidates) {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      /* try next */
    }
  }
  return {
    consoleDiamond: process.env.CARTRIDGE_CONSOLE_DIAMOND || "",
    cartridgeDiamond: process.env.CARTRIDGE_DIAMOND || "",
    gotchiBotLicense: process.env.GOTCHIBOT_LICENSE_NFT || "",
  };
}

async function getEthers() {
  try {
    return await import("ethers");
  } catch {
    const path = resolve(ROOT, "../AarcadeGh-t/node_modules/ethers/lib.esm/index.js");
    return await import(path);
  }
}

const CONSOLE_ABI = [
  "function playerCartridge(bytes32 gameId, address player) view returns (uint256)",
];
const CART_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getNest(uint256 cartridgeId) view returns (bool nested, uint8 tier, uint8 status, uint256 lockedGbotTokenId)",
  "function heroIds(uint256 cartridgeId) view returns (bytes32[])",
  "function portalStatus(uint256 cartridgeId) view returns (uint8)",
  "function licenseNested(uint256 cartridgeId) view returns (bool)",
  "function isSoulbound(uint256 cartridgeId) view returns (bool)",
  "function getActiveHeroId(uint256 cartridgeId) view returns (bytes32)",
  "function getHero(uint256 cartridgeId, bytes32 heroId) view returns (tuple(bytes32 id, uint256 sourceTokenId, uint8 bindType, int16[6] numericTraits, int16[6] modifiedTraits, uint16[16] equippedWearables, uint256 level, uint256 kinship, uint256 experience, bytes32 svgIsoHash, bytes32 svgTopdownHash, bytes32 svgSidescrollHash, string svgBundleUri))",
];

async function loadProvider() {
  const cfg = loadChainConfig();
  const consoleAddr =
    process.env.CARTRIDGE_CONSOLE_DIAMOND || cfg.consoleDiamond || "";
  const cartAddr = process.env.CARTRIDGE_DIAMOND || cfg.cartridgeDiamond || "";
  if (!consoleAddr || !cartAddr) {
    return { cfg, consoleAddr: "", cartAddr: "", ethers: null, provider: null };
  }
  const ethers = await getEthers();
  const rpc = new ethers.FetchRequest(process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org");
  rpc.timeout = sepoliaTimeoutMs();
  // staticNetwork: an unreachable RPC must reject, not retry network detection forever.
  const provider = new ethers.JsonRpcProvider(rpc, CHAIN_ID, { staticNetwork: true });
  return { cfg, consoleAddr, cartAddr, ethers, provider };
}

/**
 * @param {string} owner
 * @returns {Promise<{
 *   ok: boolean,
 *   chainId: number,
 *   cartridgeId: string|null,
 *   portalStatus: number|null,
 *   licenseNested: boolean,
 *   licenseTier: number|null,
 *   heroCount: number,
 *   heroes: string[],
 *   reason?: string,
 * }>}
 */
export async function readGotchiBotCartridgeSepolia(owner) {
  const { consoleAddr, cartAddr, ethers, provider } = await loadProvider();
  if (!consoleAddr || !cartAddr || !ethers || !provider) {
    return {
      ok: false,
      chainId: CHAIN_ID,
      cartridgeId: null,
      portalStatus: null,
      licenseNested: false,
      licenseTier: null,
      heroCount: 0,
      heroes: [],
      reason: "missing_diamond_config",
    };
  }

  const consoleC = new ethers.Contract(consoleAddr, CONSOLE_ABI, provider);
  const cartC = new ethers.Contract(cartAddr, CART_ABI, provider);
  const gid = ethers.id("gotchibot");
  const cartId = BigInt(await consoleC.playerCartridge(gid, owner));
  if (cartId === 0n) {
    return {
      ok: false,
      chainId: CHAIN_ID,
      cartridgeId: null,
      portalStatus: null,
      licenseNested: false,
      licenseTier: null,
      heroCount: 0,
      heroes: [],
      reason: "no_cartridge",
    };
  }

  const nest = await cartC.getNest(cartId);
  let heroes = [];
  try {
    const ids = await cartC.heroIds(cartId);
    heroes = (ids || []).map((h) => String(h));
  } catch {
    heroes = [];
  }

  const portalStatus = Number(nest.status);
  const licenseNested = Boolean(nest.nested);
  const openOk = portalStatus !== 1; // 1 = sealed
  const heroCount = heroes.length;

  return {
    ok: openOk && heroCount > 0,
    chainId: CHAIN_ID,
    cartridgeId: cartId.toString(),
    portalStatus,
    licenseNested,
    licenseTier: Number(nest.tier),
    heroCount,
    heroes,
    reason: !openOk
      ? "sealed_open_required"
      : heroCount === 0
        ? "no_heroes_bind_required"
        : undefined,
  };
}

function sepoliaTimeoutMs() {
  const n = Number(process.env.GOTCHIBOT_SEPOLIA_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 8_000;
}

/** Sepolia cartridge ids are uint256 decimals. */
export function isSepoliaCartridgeId(id) {
  return /^\d+$/.test(String(id ?? "").trim()) && String(id).trim() !== "0";
}

const BIND_TYPES = ["none", "owned", "rented", "starter"];

/**
 * Chain hero keys are keccak256("owned-", tokenId) / ("rental-", tokenId) /
 * ("starter-", templateId, "-", index). Owned + rented keys map back to the
 * desk's hero id (`owned-22899`); starter keys stay as the bytes32 hex.
 */
function heroFromChain(key, h, activeKey) {
  const bindType = BIND_TYPES[Number(h?.bindType ?? 0)] || null;
  const tok = h?.sourceTokenId != null ? BigInt(h.sourceTokenId) : 0n;
  const id =
    bindType === "owned" && tok > 0n ? `owned-${tok}`
      : bindType === "rented" && tok > 0n ? `rental-${tok}`
        : key;
  return {
    id,
    heroKey: key,
    source: "sepolia",
    bindType: bindType === "none" ? null : bindType,
    sourceTokenId: tok > 0n ? tok.toString() : null,
    level: h ? Number(h.level) : null,
    kinship: h ? Number(h.kinship) : null,
    experience: h ? Number(h.experience) : null,
    numericTraits: h ? [...h.numericTraits].map(Number) : null,
    modifiedTraits: h ? [...h.modifiedTraits].map(Number) : null,
    equippedWearables: h ? [...h.equippedWearables].map(Number) : null,
    active: Boolean(activeKey) && activeKey === key,
  };
}

/**
 * Heroes on a Base Sepolia cartridge.
 * Throws when Sepolia is unreachable or unconfigured.
 * @returns {Promise<{ cartridgeId: string, activeHeroId: string|null, heroes: object[] }>}
 */
export async function readSepoliaHeroes(cartridgeId) {
  if (!isSepoliaCartridgeId(cartridgeId)) {
    throw new Error(`not a Base Sepolia cartridge id: ${cartridgeId}`);
  }
  const { cartAddr, ethers, provider } = await loadProvider();
  if (!cartAddr || !ethers || !provider) throw new Error("missing_diamond_config");
  const cartC = new ethers.Contract(cartAddr, CART_ABI, provider);
  const cartId = BigInt(cartridgeId);
  const keys = ((await cartC.heroIds(cartId)) || []).map((k) => String(k));
  let activeKey = null;
  try {
    activeKey = String(await cartC.getActiveHeroId(cartId));
  } catch {
    activeKey = null;
  }
  const heroes = await Promise.all(
    keys.map(async (key) => {
      try {
        return heroFromChain(key, await cartC.getHero(cartId, key), activeKey);
      } catch {
        return heroFromChain(key, null, activeKey);
      }
    }),
  );
  const active = heroes.find((h) => h.active);
  return { cartridgeId: cartId.toString(), activeHeroId: active?.id ?? null, heroes };
}

/**
 * Owner's gotchibot cartridge + heroes on Base Sepolia (null cartridgeId when
 * none minted). Throws when Sepolia is unreachable or unconfigured.
 */
export async function readSepoliaHeroesForOwner(owner) {
  const snap = await readGotchiBotCartridgeSepolia(owner);
  if (snap.reason === "missing_diamond_config") throw new Error("missing_diamond_config");
  if (!snap.cartridgeId) return { ...snap, activeHeroId: null, heroes: [] };
  const { activeHeroId, heroes } = await readSepoliaHeroes(snap.cartridgeId);
  return { ...snap, heroKeys: snap.heroes, activeHeroId, heroes };
}

/**
 * Abracadabra ACART on Base Sepolia — nested Abra License + soulbound.
 * verified = cartridge exists + license nested.
 * @param {string} owner
 */
export async function readAbraCartridgeSepolia(owner) {
  const { consoleAddr, cartAddr, ethers, provider } = await loadProvider();
  if (!consoleAddr || !cartAddr || !ethers || !provider) {
    return {
      ok: false,
      verified: false,
      chainId: CHAIN_ID,
      cartridgeId: null,
      portalStatus: null,
      licenseNested: false,
      soulbound: false,
      reason: "missing_diamond_config",
    };
  }

  const consoleC = new ethers.Contract(consoleAddr, CONSOLE_ABI, provider);
  const cartC = new ethers.Contract(cartAddr, CART_ABI, provider);
  const gid = ethers.id("abracadabra");
  const cartId = BigInt(await consoleC.playerCartridge(gid, owner));
  if (cartId === 0n) {
    return {
      ok: false,
      verified: false,
      chainId: CHAIN_ID,
      cartridgeId: null,
      portalStatus: null,
      licenseNested: false,
      soulbound: false,
      reason: "no_cartridge",
    };
  }

  const nest = await cartC.getNest(cartId);
  const portalStatus = Number(nest.status);
  const licenseNested = Boolean(nest.nested);
  let soulbound = false;
  try {
    soulbound = Boolean(await cartC.isSoulbound(cartId));
  } catch {
    soulbound = true; // Abra nest always soulbounds; facet may predate diamond cut
  }
  const openOk = portalStatus !== 1;
  const verified = licenseNested;

  return {
    ok: verified && openOk,
    verified,
    chainId: CHAIN_ID,
    cartridgeId: cartId.toString(),
    portalStatus,
    licenseNested,
    soulbound,
    reason: !licenseNested
      ? "license_not_nested"
      : !openOk
        ? "sealed_open_required"
        : undefined,
  };
}

/** One-line cockpit label for Abra Sepolia cart. */
export function formatAbraCartLine(abra) {
  if (!abra || abra.reason === "missing_diamond_config") {
    return "(diamond config missing)";
  }
  if (!abra.cartridgeId) {
    return "(none — mint on Base Sepolia)";
  }
  const bits = [`#${abra.cartridgeId}`];
  if (abra.verified) bits.unshift("verified");
  else bits.unshift("not verified");
  if (abra.licenseNested) bits.push("nested");
  if (abra.soulbound) bits.push("soulbound");
  if (abra.portalStatus === 1) bits.push("sealed");
  else if (abra.portalStatus != null) bits.push("open");
  return bits.join(" · ");
}

async function main() {
  const owner = process.argv[2];
  if (!owner) {
    console.error("usage: cartridge-sepolia.mjs <wallet> [--abra|--heroes]");
    process.exit(1);
  }
  if (process.argv.includes("--heroes")) {
    const snap = await readSepoliaHeroesForOwner(owner);
    console.log(JSON.stringify(snap, null, 2));
    process.exit(snap.cartridgeId && snap.heroes.length ? 0 : 1);
  }
  if (process.argv.includes("--abra")) {
    const abra = await readAbraCartridgeSepolia(owner);
    console.log(JSON.stringify({ ...abra, line: formatAbraCartLine(abra) }, null, 2));
    process.exit(abra.verified ? 0 : 1);
  }
  const snap = await readGotchiBotCartridgeSepolia(owner);
  console.log(JSON.stringify(snap, null, 2));
  process.exit(snap.ok ? 0 : 1);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
