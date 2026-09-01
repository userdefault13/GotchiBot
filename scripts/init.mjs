#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { call, loadMeta, saveMeta, GAME_ID } from "./identity.mjs";
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
  console.log("GotchiBot init — sim cartridge setup");
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

  step(2, "sim-minting gotchibot cartridge");
  const hasToken = Boolean(String(process.env.GOTCHIBOT_INFRA_TOKEN || "").trim());
  if (!process.env.AARCADE_GOTCHIBOT_SERVICE_SECRET && !hasToken) {
    console.log("    infra auth not in env — run the Solo one-shot:");
    console.log("      ./scripts/gotchibot onboard");
    console.log("    (wallet step already saved — onboard skips connect if done)");
    saveMeta({ owner });
    process.exit(2);
  }
  const r = await call("/cartridges/ensure", {
    method: "POST",
    body: { owner, gameId: GAME_ID },
  });
  if (!r.ok) {
    console.error(`    ✗ ensure failed: ${JSON.stringify(r.data).slice(0, 200)}`);
    process.exit(1);
  }
  const c = r.data.cartridge ?? r.data;
  const cartridgeId = c.id ?? c.cartridgeId;
  saveMeta({ cartridgeId, owner });
  ok(`cartridge ${cartridgeId}`);

  step(3, "roster summary");
  const snap = await call(`/cartridges/${cartridgeId}`);
  if (snap.ok) {
    const s = snap.data.cartridge ?? snap.data;
    const heroes = s.cAavegotchis ?? [];
    const portals = (s.portalInventory ?? []).filter(Boolean);
    ok(`heroes: ${heroes.length}${heroes.length ? " (" + heroes.map((h) => h.id).join(", ") + ")" : ""}`);
    ok(`portals: ${portals.length} (${portals.filter((p) => String(p.status || "").startsWith("pack")).length} packs)`);
    const active = s.activeCAavegotchi?.id ?? heroes[0]?.id;
    if (active) {
      saveMeta({ activeHeroId: active });
      ok(`orchestrator hero: ${active}`);
    }
  }

  // Fresh Solo default only — never retro-write Julius/fleet installs that
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
  console.log("  ./scripts/gotchibot identity mint            # portal pack for agent identities");
  console.log("  ./scripts/gotchibot avatar <heroId>          # pin orchestrator avatar");
  console.log("  abra run gotchibot -- ./scripts/gotchibot tmux   # open the cockpit");
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
