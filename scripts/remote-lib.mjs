#!/usr/bin/env node
/**
 * Shared Tailscale/SSH helpers for gotchibot remote.
 * Secrets stay in env (abra run gotchibot -- …); never logged.
 */
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export function remoteConfig() {
  const host = process.env.REMOTE_HOST || process.env.GOTCHIBOT_REMOTE_HOST || "";
  const user = process.env.REMOTE_USER || process.env.GOTCHIBOT_REMOTE_USER || "";
  let dir = (process.env.REMOTE_DIR || process.env.GOTCHIBOT_REMOTE_DIR || "").trim();
  if (!dir || dir.includes("$HOME") || dir.startsWith("~/")) {
    dir = user ? `/Users/${user}/Dev/GotchiBot` : "/Users/juliuswong/Dev/GotchiBot";
  }
  const key = process.env.SSH_PRIVATE_KEY || "";
  return { host, user, dir, key };
}

export function assertRemoteReady({ needKey = true } = {}) {
  const cfg = remoteConfig();
  const missing = [];
  if (!cfg.host) missing.push("REMOTE_HOST");
  if (!cfg.user) missing.push("REMOTE_USER");
  if (needKey && !cfg.key) missing.push("SSH_PRIVATE_KEY");
  if (missing.length) {
    const tip = [
      "Missing: " + missing.join(", "),
      "",
      "On this MacBook (Touch ID):",
      "  abra keygen ssh gotchibot --comment gotchibot-agent@mbp",
      "  abra set gotchibot REMOTE_USER   # iMac macOS username",
      "  abra set gotchibot REMOTE_HOST   # Tailscale MagicDNS or 100.x",
      "  abra get gotchibot SSH_PUBLIC_KEY  # install on iMac authorized_keys",
      "",
      "Then: abra run gotchibot -- ./scripts/gotchibot remote -- <cmd>",
    ].join("\n");
    const err = new Error(tip);
    err.code = "REMOTE_CONFIG";
    throw err;
  }
  return cfg;
}

/** Write SSH_PRIVATE_KEY to a 0600 temp file; caller must dispose(). */
export function materializeKey(privateKey) {
  const dir = mkdtempSync(join(tmpdir(), "gotchibot-ssh-"));
  const path = join(dir, "id_ed25519");
  const body = privateKey.endsWith("\n") ? privateKey : `${privateKey}\n`;
  writeFileSync(path, body, { mode: 0o600 });
  chmodSync(path, 0o600);
  return {
    path,
    dispose() {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

export function sshArgs(cfg, keyPath, remoteCommand) {
  const target = `${cfg.user}@${cfg.host}`;
  const base = [
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-i",
    keyPath,
    target,
  ];
  if (remoteCommand == null) return base;
  // Non-interactive zsh often lacks Homebrew PATH. Pass ONE remote argv so
  // OpenSSH does not split `bash -lc` from the script (otherwise only
  // the first word runs under bash and the rest runs in zsh).
  const inner = `cd ${shellQuote(cfg.dir)} && export PATH="/usr/local/bin:/opt/homebrew/bin:\$HOME/.nvm/versions/node/current/bin:\$PATH" && ${remoteCommand}`;
  return [...base, `bash -lc ${shellQuote(inner)}`];
}

function shellQuote(s) {
  // Allow $HOME/... unquoted so the remote shell expands it.
  if (/^\$HOME\/[A-Za-z0-9_./-]+$/.test(s)) return s;
  if (/^[A-Za-z0-9_./~-]+$/.test(s)) return s;
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function runSsh(cfg, keyPath, remoteCommand, { stdio = "inherit" } = {}) {
  const args = sshArgs(cfg, keyPath, remoteCommand);
  return spawnSync("ssh", args, { stdio, encoding: "utf8" });
}

export function runScp(cfg, keyPath, localPaths, remoteSubdir = "sessions") {
  const baseDir = cfg.dir.replace(/\/$/, "");
  const targetDir = `${cfg.user}@${cfg.host}:${baseDir}/${remoteSubdir}/`;
  const args = [
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-i",
    keyPath,
    ...localPaths,
    targetDir,
  ];
  return spawnSync("scp", args, { stdio: "inherit", encoding: "utf8" });
}

export function localSessionFiles(root) {
  const names = [".wallet.json", ".identity.json", ".onboarding.json", "HANDOFF.md"];
  return names.map((n) => join(root, "sessions", n)).filter((p) => existsSync(p));
}
