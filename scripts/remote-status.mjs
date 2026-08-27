#!/usr/bin/env node
/**
 * Probe full-remote readiness (no secrets printed).
 *   node scripts/remote-status.mjs
 *   abra run gotchibot -- node scripts/remote-status.mjs
 */
import { existsSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { remoteConfig } from "./remote-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG = join(ROOT, ".cursor", "debug-892b96.log");

function dbg(hypothesisId, message, data) {
  // #region agent log
  const payload = {
    sessionId: "892b96",
    hypothesisId,
    location: "remote-status.mjs",
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

const cfg = remoteConfig();
const whichTs = spawnSync("bash", ["-lc", "command -v tailscale || ls /Applications/Tailscale.app 2>/dev/null"], {
  encoding: "utf8",
});
const tailscaleOk = whichTs.status === 0 && Boolean(whichTs.stdout.trim());

let tsPeers = null;
if (tailscaleOk) {
  const st = spawnSync("tailscale", ["status", "--json"], { encoding: "utf8" });
  if (st.status === 0) {
    try {
      const j = JSON.parse(st.stdout);
      tsPeers = Object.keys(j.Peer || {}).length;
    } catch {
      tsPeers = "parse-err";
    }
  } else {
    tsPeers = "cli-fail";
  }
}

const localState = [".wallet.json", ".identity.json", ".onboarding.json"].map((n) => ({
  n,
  ok: existsSync(join(ROOT, "sessions", n)),
}));

const report = {
  REMOTE_HOST: cfg.host ? "set" : "MISSING",
  REMOTE_USER: cfg.user ? "set" : "MISSING",
  SSH_PRIVATE_KEY: cfg.key ? "set" : "MISSING",
  SSH_PUBLIC_KEY: process.env.SSH_PUBLIC_KEY ? "set" : "MISSING",
  tailscaleInstalled: tailscaleOk,
  tailscalePeers: tsPeers,
  localIdentityFiles: localState,
};

// Hypotheses: A=no host, B=no tailscale, C=no key, D=no user, E=no local state
dbg("A", "REMOTE_HOST check", { hostSet: Boolean(cfg.host) });
dbg("B", "Tailscale check", { tailscaleOk, tsPeers });
dbg("C", "SSH key check", { keySet: Boolean(cfg.key), pubSet: Boolean(process.env.SSH_PUBLIC_KEY) });
dbg("D", "REMOTE_USER check", { userSet: Boolean(cfg.user) });
dbg("E", "local identity files", { localState });

console.log(JSON.stringify(report, null, 2));

let sshProbe = null;
if (cfg.host && cfg.user && cfg.key) {
  const { materializeKey, runSsh } = await import("./remote-lib.mjs");
  const key = materializeKey(cfg.key);
  try {
    const r = runSsh(cfg, key.path, "echo ok && hostname && pwd", { stdio: "pipe" });
    sshProbe = {
      status: r.status,
      stdout: (r.stdout || "").trim().slice(0, 200),
      stderr: (r.stderr || "").trim().slice(0, 200),
    };
    dbg("F", "SSH probe", sshProbe);
    console.log("sshProbe:", JSON.stringify(sshProbe));
  } finally {
    key.dispose();
  }
} else {
  dbg("F", "SSH probe skipped", { reason: "missing config" });
  console.log("sshProbe: skipped (fix REMOTE_HOST + install Tailscale + authorize key on iMac)");
}

const blockers = [];
if (!cfg.host) blockers.push("set REMOTE_HOST (Tailscale MagicDNS or 100.x)");
if (!cfg.user) blockers.push("set REMOTE_USER");
if (!cfg.key) blockers.push("abra keygen ssh gotchibot");
if (!tailscaleOk) blockers.push("install+login Tailscale on MBP (needs sudo password)");
if (blockers.length) {
  console.log("\nblockers:");
  for (const b of blockers) console.log(" -", b);
  process.exit(1);
}
process.exit(0);
