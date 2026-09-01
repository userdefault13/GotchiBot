#!/usr/bin/env node
/**
 * GotchiBot doctor — environment checklist. Prints ok/warn/fail; exit 1 on any FAIL.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getTopology, topologyPath } from "./topology.mjs";
import { authMode, AUTH_CFG } from "./infra-client.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = `${ROOT}/sessions`;
const REFERRAL_PATH = `${ROOT}/config/opencode.referral.json`;

let fails = 0;
const ok = (msg) => console.log(`ok    ${msg}`);
const warn = (msg) => console.log(`warn  ${msg}`);
const fail = (msg) => {
  fails++;
  console.log(`fail  ${msg}`);
};
const which = (bin) =>
  spawnSync("bash", ["-c", `command -v ${bin}`], { encoding: "utf8" }).status === 0;

/* ─── 1. runtime deps ─────────────────────────────────────────── */
ok(`node ${process.version}`);
if (which("tmux")) ok("tmux on PATH");
else fail("tmux missing — brew install tmux");
if (which("abra")) ok("abra on PATH");
else warn("abra missing — secrets require abracadabra (abra run gotchibot -- …)");

/* ─── 2. topology ─────────────────────────────────────────────── */
const topo = getTopology();
if (topo.mode === "legacy") {
  ok(`topology: legacy (no ${topologyPath()}) — today's behavior, remote preferred when up`);
} else {
  ok(`topology: ${topo.mode} (source: ${topo.source})`);
}

/* ─── 3. OpenCode referral + API key ─────────────────────────── */
let referral = null;
try {
  referral = JSON.parse(readFileSync(REFERRAL_PATH, "utf8"));
} catch {}
if (referral?.goUrl) ok(`OpenCode referral: ${referral.label ?? "OpenCode Go"} → ${referral.goUrl}`);
else warn("config/opencode.referral.json missing/unreadable");
process.env.OPENCODE_API_KEY
  ? ok("OPENCODE_API_KEY appears set (value never printed)")
  : warn("OPENCODE_API_KEY unset in env — BYO models; keep it in abra, never in files");

/* ─── 4. wallet / cartridge (soft) ────────────────────────────── */
const walletPath = `${SESSIONS}/.wallet.json`;
const identityPath = `${SESSIONS}/.identity.json`;
let walletSet = false;
try {
  walletSet = Boolean(JSON.parse(readFileSync(walletPath, "utf8")).address);
} catch {}
if (walletSet) ok("wallet connected (sessions/.wallet.json)");
else warn("no wallet connected — run ./scripts/gotchibot connect");
let cartridgeId = null;
try {
  cartridgeId = JSON.parse(readFileSync(identityPath, "utf8")).cartridgeId ?? null;
} catch {}
if (cartridgeId) ok(`cartridge: ${cartridgeId}`);
else warn("no cartridge id cached — run ./scripts/gotchibot onboard");

/* ─── 4b. infra auth (install token vs legacy operator) ─────── */
const mode = authMode();
if (mode === "solo_install_token") {
  ok("infra auth: solo install token (GOTCHIBOT_INFRA_TOKEN set)");
  try {
    const token = String(process.env.GOTCHIBOT_INFRA_TOKEN || "").trim();
    const statusUrl = process.env.GOTCHIBOT_INSTALL_STATUS_URL || AUTH_CFG.statusUrl;
    const res = await fetch(statusUrl, {
      headers: {
        Accept: "application/json",
        [AUTH_CFG.installTokenHeader || "X-GotchiBot-Install-Token"]: token,
      },
    });
    const body = await res.json();
    if (body.ok) {
      const rem = body.remaining ?? body.quotaRemaining ?? "?";
      const kinds = body.usageByKind
        ? ` sub=${body.usageByKind.subgraph ?? 0} cart=${body.usageByKind.cartridge ?? 0}`
        : "";
      ok(`install token valid (wallet ${body.wallet ?? "?"}, remaining ${rem}${kinds})`);
    } else fail(`install token rejected — re-register: ./scripts/gotchibot onboard`);
  } catch (e) {
    fail(`install token status probe failed: ${e?.message ?? e}`);
  }
} else if (mode === "legacy_operator") {
  ok("infra auth: legacy operator secrets (Julius path — no install token required)");
} else if (topo.mode === "solo") {
  warn("solo topology but no GOTCHIBOT_INFRA_TOKEN — run: ./scripts/gotchibot onboard");
} else {
  warn("no infra auth in env — Solo needs infra register; legacy desk uses abra operator secrets");
}

/* ─── 5. fleet-only: Tailscale/SSH probe (warn, never fail) ───── */
async function probeRemote() {
  const env = process.env;
  if (!(env.REMOTE_HOST && (env.REMOTE_USER || env.GOTCHIBOT_REMOTE_USER) && env.SSH_PRIVATE_KEY)) {
    return { ok: false, reason: "REMOTE_HOST/REMOTE_USER/SSH_PRIVATE_KEY not in env (abra run)" };
  }
  try {
    const { assertRemoteReady, materializeKey, runSsh } = await import("./remote-lib.mjs");
    const cfg = assertRemoteReady();
    const mat = materializeKey(cfg.key);
    try {
      const r = runSsh(cfg, mat.path, "echo ok", { stdio: "pipe", timeout: 8000 });
      return r.status === 0 && String(r.stdout || "").includes("ok")
        ? { ok: true }
        : { ok: false, reason: "ssh probe failed" };
    } finally {
      mat.dispose();
    }
  } catch (e) {
    return { ok: false, reason: `probe error: ${e?.message ?? e}` };
  }
}

if (topo.mode === "fleet") {
  const p = await probeRemote();
  if (p.ok) ok("fleet remote: iMac reachable over Tailscale SSH");
  else warn(`topology=fleet but remote down/skipped (${p.reason}) — see gotchibot remote-setup`);
} else if (topo.mode === "legacy") {
  warn("topology legacy — remote probe skipped here; legacy callers probe at spawn time");
}

/* ─── 6. launcher tip ─────────────────────────────────────────── */
console.log("tip   GotchiBot alias must be bare  ./scripts/gotchibot tmux  — never abra-wrapped (TTY)");

process.exit(fails ? 1 : 0);
