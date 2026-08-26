#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const endpoints = JSON.parse(readFileSync(`${ROOT}/config/subgraph.endpoints.json`, "utf8"));
const CORE = endpoints.subgraphs["aavegotchi-core-base"].url;

function walletAddress() {
  const argIdx = process.argv.indexOf("--wallet");
  const direct = process.argv[argIdx + 1];
  if (direct && /^0x[a-fA-F0-9]{40}$/.test(direct)) return direct.toLowerCase();
  try {
    const w = JSON.parse(readFileSync(`${ROOT}/sessions/.wallet.json`, "utf8"));
    if (w.address) return w.address;
  } catch {}
  console.error("no wallet connected — run: gotchibot connect  (or pass --wallet 0x…)");
  process.exit(1);
}

async function fromSubgraph(owner) {
  const res = await fetch(CORE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `{
        aavegotchis(first: 100, where: { owner: "${owner}" }, orderBy: gotchiId) {
          gotchiId name hauntId collateral
          numericTraits modifiedNumericTraits kinship level
          equippedWearables
        }
      }`,
    }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(body.errors[0].message);
  return body.data.aavegotchis;
}

async function fromChain(owner) {
  const cast = "/Users/juliuswong/.foundry/bin/cast";
  const diamond = "0xA99c4B08201F2913Db8D28e71d020c4298F29dBF";
  const rpc = process.env.GOTCHIBOT_BASE_RPC ?? "https://mainnet.base.org";
  const { execFileSync } = await import("node:child_process");
  const balHex = execFileSync(cast, [
    "call", diamond, "balanceOf(address)(uint256)", owner, "--rpc-url", rpc,
  ], { encoding: "utf8" }).trim();
  const balance = Number(BigInt(balHex));
  if (!balance) return [];
  const out = [];
  for (let i = 0; i < Math.min(balance, 100); i++) {
    const tokenId = execFileSync(cast, [
      "call", diamond, "tokenOfOwnerByIndex(address,uint256)(uint256)", owner, String(i),
      "--rpc-url", rpc,
    ], { encoding: "utf8" }).trim();
    out.push({ gotchiId: BigInt(tokenId).toString(), source: "onchain" });
  }
  return out;
}

const owner = walletAddress();
console.log(`owner: ${owner}`);
try {
  const gotchis = await fromSubgraph(owner);
  console.log(`${gotchis.length} gotchi(es) via subgraph`);
  for (const g of gotchis) {
    const name = g.name || `#${g.gotchiId}`;
    const traits = (g.modifiedNumericTraits ?? g.numericTraits ?? []).map((t) => Math.round(t)).join("/");
    console.log(
      `  #${g.gotchiId}  ${name.padEnd(20)} haunt${g.hauntId}  ${String(g.collateral).slice(0, 10).padEnd(10)} BRS-traits[${traits}] kin:${Math.round(g.kinship)} lvl:${g.level}`
    );
  }
} catch (e) {
  console.error(`subgraph failed (${e.message}), falling back to chain…`);
  const gotchis = await fromChain(owner);
  console.log(`${gotchis.length} gotchi(es) via on-chain`);
  for (const g of gotchis) console.log(`  #${g.gotchiId}`);
}
