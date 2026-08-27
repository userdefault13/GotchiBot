#!/usr/bin/env node
/**
 * Push this MacBook's GotchiBot tree to the iMac over Tailscale SSH.
 * Needed when GitHub remote is empty — clone alone has no files.
 *
 * Uses open-source Tailscale (tailscaled) reachability; abra SSH key.
 *
 *   abra run gotchibot -- node scripts/remote-push.mjs
 */
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { assertRemoteReady, materializeKey } from "./remote-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG = join(ROOT, ".cursor", "debug-892b96.log");

function dbg(hypothesisId, message, data) {
  // #region agent log
  const payload = {
    sessionId: "892b96",
    runId: "remote-push",
    hypothesisId,
    location: "remote-push.mjs",
    message,
    data,
    timestamp: Date.now(),
  };
  try {
    appendFileSync(LOG, `${JSON.stringify(payload)}\n`);
  } catch {}
  fetch("http://127.0.0.1:7576/ingest/0147507d-1fe4-4821-a7bb-afea994177ef", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "892b96" },
    body: JSON.stringify(payload),
  }).catch(() => {});
  // #endregion
}

function shellQuote(s) {
  // Allow $HOME/... unquoted so the remote shell expands it.
  if (/^\$HOME\/[A-Za-z0-9_./-]+$/.test(s)) return s;
  if (/^[A-Za-z0-9_./~-]+$/.test(s)) return s;
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function ssh(cfg, keyPath, remoteCommand, opts = {}) {
  // Always one remote command string (see remote-lib sshArgs note).
  const cmd = typeof remoteCommand === "string" ? remoteCommand : remoteCommand.join(" ");
  return spawnSync(
    "ssh",
    [
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-i",
      keyPath,
      `${cfg.user}@${cfg.host}`,
      cmd,
    ],
    { encoding: "utf8", ...opts },
  );
}

const cfg = assertRemoteReady();
const key = materializeKey(cfg.key);

try {
  const home = `/Users/${cfg.user}`;
  const remoteRoot = `${home}/Dev/GotchiBot`;
  dbg("G", "resolved remote root", { remoteRoot, home });

  ssh(cfg, key.path, `mkdir -p '${remoteRoot}'`, { stdio: "inherit" });

  const excludes = [
    "--exclude",
    ".git/",
    "--exclude",
    "node_modules/",
    "--exclude",
    "sessions/s*/",
    "--exclude",
    ".cursor/debug-*.log",
    "--exclude",
    ".DS_Store",
  ];

  console.log(`rsync → ${cfg.user}@${cfg.host}:${remoteRoot}/`);
  const rsync = spawnSync(
    "rsync",
    [
      "-az",
      "--delete",
      ...excludes,
      "-e",
      `ssh -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -i ${key.path}`,
      `${ROOT}/`,
      `${cfg.user}@${cfg.host}:${remoteRoot}/`,
    ],
    { stdio: "inherit", encoding: "utf8" },
  );
  dbg("H", "rsync finished", { status: rsync.status });
  if (rsync.status !== 0) process.exit(rsync.status ?? 1);

  for (const rel of ["sessions/.wallet.json", "sessions/.identity.json", "sessions/.onboarding.json"]) {
    const local = join(ROOT, rel);
    if (!existsSync(local)) continue;
    spawnSync(
      "scp",
      ["-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-i", key.path, local, `${cfg.user}@${cfg.host}:${remoteRoot}/${rel}`],
      { stdio: "inherit" },
    );
  }

  const verifyCmd = `bash -lc ${shellQuote(
    `export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"; cd '${remoteRoot}' && test -f scripts/wallet-gate.mjs && node scripts/wallet-gate.mjs && test -f scripts/opencode-serve.sh && echo PUSH_OK`,
  )}`;
  const verify = ssh(cfg, key.path, verifyCmd, { stdio: "pipe" });
  process.stdout.write(verify.stdout || "");
  process.stderr.write(verify.stderr || "");
  dbg("I", "verify after push", { status: verify.status, out: (verify.stdout || "").slice(0, 400) });
  process.exit(verify.status ?? 1);
} finally {
  key.dispose();
}
