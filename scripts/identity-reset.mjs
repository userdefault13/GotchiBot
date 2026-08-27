#!/usr/bin/env node
/**
 * Reset gotchibot cartridge (server SIM + local identity) for first-run testing.
 */
import { unlinkSync, rmSync, readdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { call, loadMeta, saveMeta, owner, serviceKey, GAME_ID } from "./identity.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = `${ROOT}/sessions`;
const IDENTITY = `${SESSIONS}/.identity.json`;
const WALLET = `${SESSIONS}/.wallet.json`;
const ONBOARDING = `${SESSIONS}/.onboarding.json`;
const PIN = `${SESSIONS}/.pin`;

function usage() {
  console.error(`usage: identity-reset.mjs [--local-only] [--full] [--yes]

  Deletes the gotchibot SIM cartridge for your connected wallet (gameId=gotchibot only).
  Clears local sessions/.identity.json. Keeps wallet connected unless --full.

  --local-only   skip server delete (clears local state only)
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

async function resetServer() {
  serviceKey();
  const r = await call("/cartridges/reset", {
    method: "POST",
    body: { owner: owner(), gameId: GAME_ID },
  });
  return r;
}

async function main() {
  if (process.argv.includes("-h") || process.argv.includes("--help")) usage();

  const localOnly = hasFlag("--local-only");
  const full = hasFlag("--full");
  const yes = hasFlag("--yes");

  let walletAddr;
  try {
    walletAddr = owner();
  } catch {
    if (full) {
      console.log("no wallet connected — clearing local identity only");
      if (existsSync(IDENTITY)) unlinkSync(IDENTITY);
      console.log("done (nothing on server without wallet)");
      return;
    }
    throw new Error("connect wallet first: ./scripts/gotchibot connect");
  }

  const meta = loadMeta();
  console.log("GotchiBot cartridge reset (gotchibot game only)");
  console.log("===============================================");
  console.log(`wallet:     ${walletAddr}`);
  console.log(`cartridge:  ${meta?.cartridgeId ?? "(unknown — will lookup on server)"}`);
  console.log(`local-only: ${localOnly}`);
  console.log(`full wipe:  ${full}${full ? " (wallet + sub-agent sessions)" : ""}`);
  console.log("");
  console.log("Other Aarcade games / cartridges are NOT touched.");

  if (!yes) {
    console.error("Re-run with --yes to confirm.");
    process.exit(1);
  }

  if (!localOnly) {
    const r = await resetServer();
    if (r.status === 404) {
      console.error(
        "server reset endpoint not found — deploy AarcadeGh-t cartridge-sim reset route,\n" +
          "or use --local-only and delete the cartridge manually.",
      );
      process.exit(3);
    }
    if (!r.ok) {
      console.error(`server reset failed (${r.status}):`, JSON.stringify(r.data).slice(0, 400));
      process.exit(1);
    }
    const d = r.data;
    if (d.deleted) {
      console.log(`✓ deleted server cartridge ${d.cartridgeId} (${d.checkpointsDeleted ?? 0} checkpoints)`);
    } else {
      console.log(`✓ no server cartridge to delete (${d.reason ?? "already clean"})`);
    }
  } else {
    console.log("✓ skipped server delete (--local-only)");
  }

  clearLocalIdentity({ full });
  console.log(full ? "✓ cleared local identity, wallet, and sub-agent sessions" : "✓ cleared local identity (wallet kept)");

  console.log("\nnext: ./scripts/gotchibot tmux");
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
