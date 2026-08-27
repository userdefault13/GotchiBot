#!/usr/bin/env node
/**
 * Sync wallet / cAavegotchi identity state to the iMac over Tailscale SSH.
 *
 * Copies (if present):
 *   sessions/.wallet.json
 *   sessions/.identity.json
 *   sessions/.onboarding.json
 *   sessions/HANDOFF.md
 *
 *   abra run gotchibot -- node scripts/remote-sync.mjs
 *   abra run gotchibot -- ./scripts/gotchibot remote-sync
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertRemoteReady,
  materializeKey,
  runScp,
  runSsh,
  localSessionFiles,
} from "./remote-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let cfg;
try {
  cfg = assertRemoteReady();
} catch (e) {
  console.error(e.message || e);
  process.exit(2);
}

const files = localSessionFiles(ROOT);
if (!files.length) {
  console.error("no identity files to sync under sessions/ (.wallet/.identity/.onboarding)");
  process.exit(1);
}

const key = materializeKey(cfg.key);
try {
  // Ensure remote sessions dir exists
  const mkdir = runSsh(cfg, key.path, `mkdir -p ${cfg.dir}/sessions`, { stdio: "pipe" });
  if (mkdir.status !== 0) {
    console.error(mkdir.stderr || "ssh mkdir failed — is Tailscale up and REMOTE_HOST correct?");
    process.exit(mkdir.status ?? 1);
  }

  console.log(`sync → ${cfg.user}@${cfg.host}:${cfg.dir}/sessions/`);
  for (const f of files) {
    console.log(`  ${f.replace(ROOT + "/", "")}`);
  }

  const scp = runScp(cfg, key.path, files, "sessions");
  if (scp.status !== 0) {
    process.exit(scp.status ?? 1);
  }

  console.log("verify wallet-gate on iMac…");
  // Prefer plain node — remote abra often can't unlock Keychain over SSH.
  const gate = runSsh(cfg, key.path, `node ./scripts/wallet-gate.mjs`, { stdio: "inherit" });
  process.exit(gate.status ?? 0);
} finally {
  key.dispose();
}
