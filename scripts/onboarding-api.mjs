#!/usr/bin/env node
/**
 * Thin API runner — invoked via `abra run gotchibot --` when the tmux pane lacks service key.
 */
import { call, loadMeta, saveMeta, GAME_ID } from "./identity.mjs";

const cmd = process.argv[2];

function simCartId(meta) {
  if (meta?.legacySimCartridgeId) return meta.legacySimCartridgeId;
  if (String(meta?.cartridgeId || "").startsWith("sim-")) return meta.cartridgeId;
  return meta?.cartridgeId || null;
}

async function main() {
  const meta = loadMeta();
  const cartId = simCartId(meta);
  switch (cmd) {
    case "ensure": {
      const owner = process.argv[3];
      const r = await call("/cartridges/ensure", {
        method: "POST",
        body: { owner, gameId: GAME_ID, simPay: true },
      });
      if (!r.ok) throw new Error(JSON.stringify(r.data));
      const c = r.data.cartridge ?? r.data;
      const id = c.id ?? c.cartridgeId;
      // Preserve Sepolia nest cart when ensure creates a parallel sim identity cart.
      if (meta?.cartridgeSource === "sepolia" || (meta?.cartridgeId && !String(meta.cartridgeId).startsWith("sim-"))) {
        saveMeta({
          owner,
          legacySimCartridgeId: id,
          cartridgeId: meta.cartridgeId,
          cartridgeSource: meta.cartridgeSource || "sepolia",
          abraCartridgeId: meta.abraCartridgeId,
          abraVerified: meta.abraVerified,
        });
      } else {
        saveMeta({ cartridgeId: id, owner });
      }
      console.log(id);
      break;
    }
    case "bind-starter": {
      const collateral = process.argv[3] ?? "dai";
      if (!cartId) throw new Error("no sim cartridge — run ensure first");
      const { bindStarterHero } = await import("./onboarding-lib.mjs");
      const id = await bindStarterHero(cartId, collateral);
      console.log(id ?? "");
      break;
    }
    case "bind-owned": {
      const tokenId = process.argv[3];
      if (!cartId) throw new Error("no sim cartridge — run ensure first");
      const { bindOwnedGotchi } = await import("./onboarding-lib.mjs");
      const id = await bindOwnedGotchi(cartId, tokenId);
      console.log(id ?? "");
      break;
    }
    case "mint-sub": {
      const collateral = process.argv[3] ?? "dai";
      if (!cartId) throw new Error("no sim cartridge — run ensure first");
      const { mintSubAgentHero } = await import("./onboarding-lib.mjs");
      const id = await mintSubAgentHero(cartId, collateral);
      console.log(id ?? "");
      break;
    }
    case "select-hero": {
      const heroId = process.argv[3];
      if (!cartId) throw new Error("no sim cartridge — run ensure first");
      const r = await call(`/cartridges/${cartId}/select-hero`, {
        method: "POST",
        body: { cAavegotchiId: heroId },
      });
      if (!r.ok) throw new Error(JSON.stringify(r.data));
      console.log(heroId);
      break;
    }
    default:
      console.error("usage: onboarding-api.mjs ensure|bind-starter|bind-owned|mint-sub|select-hero …");
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
