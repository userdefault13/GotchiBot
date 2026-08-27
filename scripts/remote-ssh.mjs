#!/usr/bin/env node
/**
 * Run a command on the iMac over Tailscale SSH (abra-injected key).
 *
 *   abra run gotchibot -- node scripts/remote-ssh.mjs -- ./scripts/wallet-gate.mjs
 *   abra run gotchibot -- ./scripts/gotchibot remote -- hostname
 *
 * Never prints SSH_PRIVATE_KEY.
 */
import { assertRemoteReady, materializeKey, runSsh } from "./remote-lib.mjs";

const args = process.argv.slice(2);
const sep = args.indexOf("--");
const remoteParts = sep >= 0 ? args.slice(sep + 1) : args;

if (!remoteParts.length) {
  console.error(`usage: remote-ssh.mjs -- <remote-command…>
example: abra run gotchibot -- node scripts/remote-ssh.mjs -- ./scripts/wallet-gate.mjs`);
  process.exit(2);
}

let cfg;
try {
  cfg = assertRemoteReady();
} catch (e) {
  console.error(e.message || e);
  process.exit(2);
}

const key = materializeKey(cfg.key);
try {
  // Quote each arg for remote shell
  const remoteCmd = remoteParts
  .map((a) => {
    if (/^[A-Za-z0-9_./:=+-]+$/.test(a)) return a;
    // Single argv with spaces = shell fragment; do not wrap as one literal command name.
    if (/\s/.test(a)) return a;
    return `'${String(a).replace(/'/g, `'\\''`)}'`;
  })
  .join(" ");
  const r = runSsh(cfg, key.path, remoteCmd);
  process.exit(r.status ?? 1);
} finally {
  key.dispose();
}
