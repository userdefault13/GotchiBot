#!/usr/bin/env node
/**
 * Diff Base-mainnet wallet gotchis vs Sepolia Mock L1 ownership, then seed missing.
 *
 *   node scripts/seed-mock-l1.mjs [--wallet 0x…] [--dry-run] [--json] [--apply]
 *
 * --apply runs forge via abra (AarcadeGh-t) with SEED_TOKEN_IDS=missing.
 * Without --apply, prints the ids + the abra command (no broadcast).
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchWalletGotchis, readWalletFile } from "./onboarding-lib.mjs";
import { isMainModule } from "./is-main.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AARCADE = resolve(ROOT, "../AarcadeGh-t");
const CFG = `${ROOT}/config/cartridgeChain.base-sepolia.json`;
const MOCK_CFG = `${AARCADE}/config/mock-l1.base-sepolia.json`;
const DEFAULT_WALLET = "0x2127AA7265D573Aa467f1D73554D17890b872E76";
const RPC = process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org";

function loadMockAddr() {
  for (const p of [CFG, MOCK_CFG]) {
    try {
      const j = JSON.parse(readFileSync(p, "utf8"));
      if (j.l1AavegotchiDiamond) return String(j.l1AavegotchiDiamond);
    } catch {
      /* next */
    }
  }
  return process.env.MOCK_L1 || "0x92aE9134346A2A084c2Aa7b1EBe60e7e18Fc3457";
}

function ownerOf(mock, tokenId) {
  const r = spawnSync(
    "cast",
    ["call", mock, "ownerOf(uint256)(address)", String(tokenId), "--rpc-url", RPC],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return null;
  return String(r.stdout || "")
    .trim()
    .toLowerCase();
}

async function plan(wallet) {
  const mock = loadMockAddr();
  const want = String(wallet).toLowerCase();
  console.error(`Fetching Base gotchis for ${wallet}…`);
  const gotchis = await fetchWalletGotchis(wallet);
  const ids = gotchis
    .map((g) => String(g.gotchiId ?? g.id))
    .filter((id) => /^\d+$/.test(id))
    .sort((a, b) => Number(a) - Number(b));

  const seeded = [];
  const missing = [];
  for (const id of ids) {
    const o = ownerOf(mock, id);
    if (o && o === want) seeded.push(id);
    else missing.push(id);
  }

  return {
    wallet,
    mock,
    total: ids.length,
    seeded,
    missing,
    seedCsv: missing.join(","),
  };
}

function printApplyHint(plan) {
  const csv = plan.seedCsv || "(none)";
  console.log(`
# Seed ${plan.missing.length} missing id(s) onto Mock L1 ${plan.mock}
abra run AarcadeGh-t -- bash -c '
  PRIVATE_KEY=$AARCADEGHST_PRIVATE_KEY \\
  SEED_OWNER=${plan.wallet} \\
  MOCK_L1=${plan.mock} \\
  SEED_TOKEN_IDS=${csv} \\
  ./scripts/seed-mock-l1-gotchis.sh
'
`);
}

async function applyViaAbra(plan) {
  if (!plan.missing.length) {
    console.log("Nothing to seed — Mock L1 already has every Base gotchi for this wallet.");
    return { ok: true, minted: 0 };
  }
  if (!existsSync(`${AARCADE}/scripts/seed-mock-l1-gotchis.sh`)) {
    throw new Error(`missing ${AARCADE}/scripts/seed-mock-l1-gotchis.sh`);
  }
  const inner = [
    "PRIVATE_KEY=$AARCADEGHST_PRIVATE_KEY",
    `SEED_OWNER=${plan.wallet}`,
    `MOCK_L1=${plan.mock}`,
    `SEED_TOKEN_IDS=${plan.seedCsv}`,
    "./scripts/seed-mock-l1-gotchis.sh",
  ].join(" ");
  const abra = spawnSync("abra", ["run", "AarcadeGh-t", "--", "bash", "-c", inner], {
    cwd: AARCADE,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (abra.stdout) process.stdout.write(abra.stdout);
  if (abra.stderr) process.stderr.write(abra.stderr);
  if (abra.status !== 0) {
    // Fallback project name
    const abra2 = spawnSync("abra", ["run", "aarcadeghst", "--", "bash", "-c", inner], {
      cwd: AARCADE,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (abra2.stdout) process.stdout.write(abra2.stdout);
    if (abra2.stderr) process.stderr.write(abra2.stderr);
    if (abra2.status !== 0) {
      throw new Error(`abra seed failed (exit ${abra.status ?? abra2.status})`);
    }
  }
  return { ok: true, minted: plan.missing.length };
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const dryRun = args.includes("--dry-run");
  const apply = args.includes("--apply");
  let wallet = DEFAULT_WALLET;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--wallet" && args[i + 1]) wallet = args[++i];
  }
  if (!wallet) wallet = readWalletFile() || DEFAULT_WALLET;

  const p = await plan(wallet);
  if (json) {
    console.log(JSON.stringify(p, null, 2));
  } else {
    console.log(`Mock L1  ${p.mock}`);
    console.log(`Wallet   ${p.wallet}`);
    console.log(`Base     ${p.total} gotchi(s)`);
    console.log(`Seeded   ${p.seeded.length}: ${p.seeded.join(", ") || "—"}`);
    console.log(`Missing  ${p.missing.length}: ${p.missing.join(", ") || "—"}`);
  }

  if (dryRun || (!apply && !json)) {
    if (!json) printApplyHint(p);
  }
  if (apply) {
    await applyViaAbra(p);
    const after = await plan(wallet);
    if (!json) {
      console.log(`\nAfter: seeded ${after.seeded.length}/${after.total} · missing ${after.missing.length}`);
    } else {
      console.log(JSON.stringify({ applied: true, after }, null, 2));
    }
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e?.message || e);
    process.exit(1);
  });
}
