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
import { readWallet, registerInstall } from "./infra-token.mjs";
import {
  commandExists,
  hasAbra,
  runAbraDoctor,
  runNodeWithAbra,
  abraInstallHint,
  tmuxInstallHint,
  platformLabel,
} from "./platform.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IDENTITY_PATH = `${ROOT}/sessions/.identity.json`;

const step = (n, total, msg) => console.log(`\n[${n}/${total}] ${msg}`);
const ok = (msg) => console.log(`    ✓ ${msg}`);
const die = (msg, code = 1) => {
  console.error(`    ✗ ${msg}`);
  process.exit(code);
};

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

  if (!force) {
    spawnSync(process.execPath, [`${ROOT}/scripts/update-check.mjs`, "--launch"], {
      cwd: ROOT,
      stdio: "inherit",
      encoding: "utf8",
    });
  }

  const total = 5;
  console.log("GotchiBot Solo onboard");
  console.log("======================");
  console.log(`Platform: ${platformLabel()}`);
  console.log("One command: wallet → register → cartridge → doctor\n");

  if (!force && hasCartridge() && readWallet()) {
    console.log("Already set up (wallet + cartridge cached).");
    console.log("  ./scripts/gotchibot tmux");
    console.log("  abra run gotchibot -- ./scripts/gotchibot doctor");
    console.log("  ./scripts/gotchibot onboard --force   redo register/init");
    process.exit(0);
  }

  step(1, total, "check deps");
  if (!commandExists("tmux")) die(`tmux missing — ${tmuxInstallHint()}`);
  ok("node + tmux");
  if (!hasAbra()) die(`abracadabra required — ${abraInstallHint()}`);
  ok("abra on PATH");
  const ad = runAbraDoctor();
  if (!ad.ok) {
    if (ad.stdout) console.log(ad.stdout);
    if (ad.stderr) console.error(ad.stderr);
    die("abra doctor failed — see docs/SOLO-LINUX-WINDOWS.md");
  }
  ok("abra doctor");

  const themeInst = spawnSync(process.execPath, [`${ROOT}/scripts/install-gotchi-theme.mjs`], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (themeInst.status === 0) {
    ok("gotchi OpenCode theme → ~/.config/opencode/themes/");
  } else {
    console.warn(`    ! theme install skipped: ${(themeInst.stderr || themeInst.stdout || "").trim() || `exit ${themeInst.status}`}`);
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
    const r = runNodeWithAbra(`${ROOT}/scripts/init.mjs`, [], { cwd: ROOT, stdio: "inherit" });
    if (r.status !== 0) die("init failed — fix above, then rerun: ./scripts/gotchibot onboard", r.status || 1);
    ok("cartridge ready");
  }

  step(5, total, "doctor");
  const dr = runNodeWithAbra(`${ROOT}/scripts/doctor.mjs`, [], { cwd: ROOT, stdio: "inherit" });
  if (dr.status !== 0) die("doctor reported failures — fix above", dr.status || 1);

  console.log("\n════════════════════════════════════");
  console.log("Solo onboard complete.");
  console.log("  ./scripts/gotchibot tmux          open the cockpit");
  console.log("  abra run gotchibot -- ./scripts/gotchibot doctor");
  console.log("  ./scripts/gotchibot openclaw install   if OpenClaw CLI not yet installed");
  console.log("  docs/SOLO-LINUX-WINDOWS.md        Linux / Windows notes");
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
