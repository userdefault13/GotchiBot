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
];

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
  const cfg = loadChainConfig();
  const consoleAddr =
    process.env.CARTRIDGE_CONSOLE_DIAMOND || cfg.consoleDiamond || "";
  const cartAddr = process.env.CARTRIDGE_DIAMOND || cfg.cartridgeDiamond || "";
  if (!consoleAddr || !cartAddr) {
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

  const ethers = await getEthers();
  const rpc = process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org";
  const provider = new ethers.JsonRpcProvider(rpc, CHAIN_ID);
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

async function main() {
  const owner = process.argv[2];
  if (!owner) {
    console.error("usage: cartridge-sepolia.mjs <wallet>");
    process.exit(1);
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
