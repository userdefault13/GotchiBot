#!/usr/bin/env node
/**
 * One-shot Solo bootstrap: wallet → infra register → cartridge init → doctor.
 *
 *   ./scripts/gotchibot onboard
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getTopology, setTopology, topologyFileExists } from "./topology.mjs";
import { hasInstallToken, hasOperatorServiceKey } from "./infra-client.mjs";
import { readWallet, registerInstall, hasAbra } from "./infra-token.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WALLET_PATH = `${ROOT}/sessions/.wallet.json`;
const IDENTITY_PATH = `${ROOT}/sessions/.identity.json`;

const step = (n, total, msg) => console.log(`\n[${n}/${total}] ${msg}`);
const ok = (msg) => console.log(`    ✓ ${msg}`);
const die = (msg, code = 1) => {
  console.error(`    ✗ ${msg}`);
  process.exit(code);
};

function which(bin) {
  return spawnSync("bash", ["-c", `command -v ${bin}`], { encoding: "utf8" }).status === 0;
}

function abraRun(script, args = []) {
  const nodeArgs = [script, ...args];
  if (hasAbra() && !process.env.SSH_PRIVATE_KEY) {
    return spawnSync("abra", ["run", "gotchibot", "--", "node", ...nodeArgs], {
      cwd: ROOT,
      stdio: "inherit",
      encoding: "utf8",
    });
  }
  return spawnSync(process.execPath, nodeArgs, { cwd: ROOT, stdio: "inherit", encoding: "utf8" });
}

function hasCartridge() {
  try {
    return Boolean(JSON.parse(readFileSync(IDENTITY_PATH, "utf8")).cartridgeId);
  } catch {
    return false;
  }
}

function connectWallet() {
  console.log("    opening wallet-connect in browser…");
  const r = spawnSync(process.execPath, [`${ROOT}/scripts/wallet-connect.mjs`], {
    cwd: ROOT,
    stdio: "inherit",
    encoding: "utf8",
  });
  if (r.status !== 0) die("wallet connect failed — retry onboard");
  if (!readWallet()) die("wallet not saved");
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");

  const total = 5;
  console.log("GotchiBot Solo onboard");
  console.log("======================");
  console.log("One command: wallet → register → cartridge → doctor\n");

  if (!force && hasCartridge() && readWallet()) {
    console.log("Already set up (wallet + cartridge cached).");
    console.log("  ./scripts/gotchibot tmux");
    console.log("  ./scripts/gotchibot doctor   re-check env");
    console.log("  ./scripts/gotchibot onboard --force   redo register/init");
    process.exit(0);
  }

  step(1, total, "check deps");
  if (!which("tmux")) die("tmux missing — brew install tmux");
  ok("node + tmux");
  if (!hasAbra()) {
    console.log("    ! abra not found — install abracadabra for secret storage");
    console.log("      https://github.com/user-defaults/abracadabra");
  } else {
    ok("abra on PATH");
  }

  const fleetish = Boolean(
    process.env.REMOTE_HOST ||
      process.env.GOTCHIBOT_REMOTE_HOST ||
      process.env.GOTCHIBOT_REMOTE_USER ||
      process.env.REMOTE_USER,
  );
  if (fleetish || hasOperatorServiceKey()) {
    console.log("\n    operator / fleet env detected — Solo onboard skipped.");
    console.log("    Use: abra run gotchibot -- ./scripts/gotchibot init");
    process.exit(0);
  }

  if (!topologyFileExists() && getTopology().mode !== "fleet") {
    setTopology("solo");
    ok("topology → solo");
  }

  step(2, total, "connect wallet");
  if (readWallet()) {
    ok(`wallet ${readWallet()}`);
  } else {
    connectWallet();
    ok(`wallet ${readWallet()}`);
  }

  step(3, total, "register install (infra token)");
  if (hasInstallToken()) {
    ok("GOTCHIBOT_INFRA_TOKEN already in env");
  } else {
    try {
      await registerInstall({ saveAbra: true, preferBrowser: true, quiet: true });
      ok("install registered + token saved to abra");
    } catch (e) {
      die(e?.message || String(e));
    }
  }

  step(4, total, "sim-mint cartridge");
  if (hasCartridge()) {
    ok("cartridge already cached — skipping init");
  } else {
    const r = abraRun(`${ROOT}/scripts/init.mjs`);
    if (r.status !== 0) die("init failed — fix above, then rerun: ./scripts/gotchibot onboard", r.status || 1);
    ok("cartridge ready");
  }

  step(5, total, "doctor");
  const dr = abraRun(`${ROOT}/scripts/doctor.mjs`);
  if (dr.status !== 0) die("doctor reported failures — fix above", dr.status || 1);

  console.log("\n════════════════════════════════════");
  console.log("Solo onboard complete.");
  console.log("  ./scripts/gotchibot tmux          open the cockpit");
  console.log("  ./scripts/gotchibot openclaw install   if OpenClaw CLI not yet installed");
  console.log("════════════════════════════════════\n");
}

function isDirectRun() {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((e) => {
    console.error(e?.message || e);
    process.exit(1);
  });
}
