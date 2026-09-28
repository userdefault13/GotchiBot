#!/usr/bin/env node
/**
 * Reset local desk identity for first-run testing. The Base Sepolia cartridge
 * is an NFT and stays on-chain; the next connect reads it again.
 */
import { unlinkSync, rmSync, readdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMeta, saveMeta, owner } from "./identity.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = `${ROOT}/sessions`;
const IDENTITY = `${SESSIONS}/.identity.json`;
const WALLET = `${SESSIONS}/.wallet.json`;
const ONBOARDING = `${SESSIONS}/.onboarding.json`;
const PIN = `${SESSIONS}/.pin`;

function usage() {
  console.error(`usage: identity-reset.mjs [--full] [--yes]

  Clears local sessions/.identity.json, onboarding and pin. Keeps wallet connected
  unless --full. The Base Sepolia cartridge is not touched.

  --full         also remove wallet + sub-agent session dirs
  --yes          skip confirmation prompt`);
  process.exit(2);
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function clearLocalIdentity({ full = false } = {}) {
  const addr = owner();
  if (existsSync(IDENTITY)) unlinkSync(IDENTITY);
  if (existsSync(ONBOARDING)) unlinkSync(ONBOARDING);
  if (existsSync(PIN)) unlinkSync(PIN);
  if (!full) {
    saveMeta({ owner: addr });
    return;
  }
  if (existsSync(WALLET)) unlinkSync(WALLET);
  for (const name of readdirSync(SESSIONS)) {
    if (name.startsWith("s") && name.length > 1) {
      rmSync(`${SESSIONS}/${name}`, { recursive: true, force: true });
    }
  }
}

async function main() {
  if (process.argv.includes("-h") || process.argv.includes("--help")) usage();

  const full = hasFlag("--full");
  const yes = hasFlag("--yes");

  let walletAddr;
  try {
    walletAddr = owner();
  } catch {
    if (full) {
      console.log("no wallet connected — clearing local identity only");
      if (existsSync(IDENTITY)) unlinkSync(IDENTITY);
      console.log("done");
      return;
    }
    throw new Error("connect wallet first: ./scripts/gotchibot connect");
  }

  const meta = loadMeta();
  console.log("GotchiBot cartridge reset (gotchibot game only)");
  console.log("===============================================");
  console.log(`wallet:     ${walletAddr}`);
  console.log(`cartridge:  ${meta?.cartridgeId ?? "(none on file)"} — stays on-chain`);
  console.log(`full wipe:  ${full}${full ? " (wallet + sub-agent sessions)" : ""}`);
  console.log("");
  console.log("Other Aarcade games / cartridges are NOT touched.");

  if (!yes) {
    console.error("Re-run with --yes to confirm.");
    process.exit(1);
  }

  clearLocalIdentity({ full });
  console.log(full ? "✓ cleared local identity, wallet, and sub-agent sessions" : "✓ cleared local identity (wallet kept)");

  console.log("\nnext: ./scripts/gotchibot tmux");
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
