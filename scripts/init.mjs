#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { saveMeta } from "./identity.mjs";
import { readSepoliaHeroesForOwner } from "./cartridge-sepolia.mjs";
import { getTopology, setTopology, topologyFileExists } from "./topology.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WALLET_PATH = `${ROOT}/sessions/.wallet.json`;

const step = (n, msg) => console.log(`\n[${n}] ${msg}`);
const ok = (msg) => console.log(`    ✓ ${msg}`);

function readWallet() {
  try {
    return JSON.parse(readFileSync(WALLET_PATH, "utf8")).address ?? null;
  } catch {
    return null;
  }
}

function connectWalletBlocking() {
  console.log("    opening wallet-connect page in your browser…");
  try {
    execFileSync(process.execPath, [`${ROOT}/scripts/wallet-connect.mjs`], { stdio: "inherit" });
  } catch {}
}

async function main() {
  console.log("GotchiBot init — cartridge setup");
  console.log("====================================");

  let address = readWallet();
  if (!address && !process.env.GOTCHIBOT_OWNER) {
    step(1, "connect a wallet");
    connectWalletBlocking();
    address = readWallet();
    if (!address) {
      console.error("    ✗ wallet not connected — rerun init to retry");
      process.exit(1);
    }
  }

  const owner =
    process.env.GOTCHIBOT_OWNER ??
    (() => {
      try { return JSON.parse(readFileSync(`${ROOT}/sessions/.wallet.json`, "utf8")).address; }
      catch { return null; }
    })();
  if (!owner) {
    console.error("no wallet available");
    process.exit(1);
  }
  step(1, `wallet: ${owner}`);

  step(2, "gotchibot cartridge (Base Sepolia)");
  const sep = await readSepoliaHeroesForOwner(owner);
  if (!sep.cartridgeId) {
    console.error("    ✗ no GotchiBot cartridge on Base Sepolia for this wallet");
    console.error("      mint one: https://www.aarcadeghst.com/concierge/terminal");
    saveMeta({ owner });
    process.exit(2);
  }
  saveMeta({ cartridgeId: sep.cartridgeId, owner, cartridgeSource: "sepolia" });
  ok(`cartridge ${sep.cartridgeId} (Base Sepolia)`);
  step(3, "roster summary");
  ok(`heroes: ${sep.heroes.length}${sep.heroes.length ? " (" + sep.heroes.map((h) => h.id).join(", ") + ")" : ""}`);
  const active = sep.activeHeroId ?? sep.heroes[0]?.id;
  if (active) {
    saveMeta({ activeHeroId: active });
    ok(`orchestrator hero: ${active}`);
  }

  // Fresh Solo default only — never retro-write UserDefault/fleet installs that
  // already have REMOTE_* (abra) or an existing topology file/env.
  try {
    const t = getTopology();
    const fleetish = Boolean(
      process.env.REMOTE_HOST ||
        process.env.GOTCHIBOT_REMOTE_HOST ||
        process.env.GOTCHIBOT_REMOTE_USER ||
        process.env.REMOTE_USER,
    );
    if (!topologyFileExists() && t.source === "default" && !fleetish) {
      setTopology("solo");
      ok("topology → solo (fresh default; change with gotchibot topology fleet)");
    } else if (!topologyFileExists() && fleetish) {
      ok("topology left legacy (REMOTE_* present — run gotchibot topology fleet to pin)");
    }
  } catch {}

  console.log("\ninit complete. next steps:");
  console.log("  ./scripts/gotchibot avatar <heroId>          # pin orchestrator avatar");
  console.log("  abra run gotchibot -- ./scripts/gotchibot tmux   # open the cockpit");
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
