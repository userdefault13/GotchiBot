#!/usr/bin/env node
/**
 * Add a cAavegotchi to the desk's Base Sepolia cartridge (MetaMask page).
 * Prints the new hero id as the last stdout line.
 *
 *   node scripts/onboarding-api.mjs bind-owned <tokenId>            free — wallet gotchi
 *   node scripts/onboarding-api.mjs mint-sub <collateral>           $5 — starter (alias: bind-starter)
 */
import { isMainModule } from "./is-main.mjs";
import { loadBaseStarterCollaterals } from "./onboarding-lib.mjs";

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const { bindOwnedToDesk, bindStarterToDesk } = await import("./cartridge-mint-sepolia.mjs");
  switch (cmd) {
    case "bind-owned": {
      if (!/^\d+$/.test(String(arg || ""))) throw new Error("usage: onboarding-api.mjs bind-owned <tokenId>");
      console.log(await bindOwnedToDesk(arg));
      break;
    }
    case "mint-sub":
    case "bind-starter": {
      const [spirit, haunt] = String(arg || "dai").toLowerCase().split(":h");
      const option = loadBaseStarterCollaterals().find(
        (c) => c.id === spirit && (!haunt || Number(c.hauntId) === Number(haunt)),
      );
      if (!option) throw new Error(`unknown starter collateral "${arg}"`);
      console.log(await bindStarterToDesk(option));
      break;
    }
    default:
      console.error("usage: onboarding-api.mjs bind-owned <tokenId> | mint-sub <collateral>[:h2]");
      process.exit(2);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
