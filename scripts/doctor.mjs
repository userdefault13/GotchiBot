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
import {
  commandExists,
  hasAbra,
  runAbraDoctor,
  abraInstallHint,
  tmuxInstallHint,
  platformLabel,
  isWsl,
  isNativeWindows,
  WSL_DOC,
} from "./platform.mjs";

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

/* ─── 1. runtime deps ─────────────────────────────────────────── */
ok(`platform ${platformLabel()}`);
if (isWsl()) ok("runtime: WSL2 (full Linux path — tmux cockpit supported)");
else if (isNativeWindows()) warn(`native Windows — tmux cockpit unavailable; use WSL2 (${WSL_DOC})`);
ok(`node ${process.version}`);
if (commandExists("tmux")) ok("tmux on PATH");
else if (isNativeWindows()) warn(`tmux missing on native Windows — run inside WSL2: gotchibot wsl`);
else fail(`tmux missing — ${tmuxInstallHint()}`);

const topoEarly = getTopology();
if (hasAbra()) {
  ok("abra on PATH");
  const ad = runAbraDoctor();
  if (ad.ok) ok("abra doctor");
  else if (topoEarly.mode === "solo") fail("abra doctor failed — see docs/SOLO-LINUX-WINDOWS.md");
  else warn("abra doctor failed — secrets may not inject until fixed");
} else if (topoEarly.mode === "solo") {
  fail(`abracadabra required — ${abraInstallHint()}`);
} else {
  warn(`abra missing — fleet/legacy: abra run gotchibot -- … (${abraInstallHint()})`);
}
if (commandExists("aseprite")) ok("aseprite CLI on PATH (gotchibot aseprite check)");
else warn("aseprite missing — pixel art export unavailable; install Aseprite or set ASEPRITE_BIN");

try {
  const aseCfg = JSON.parse(readFileSync(`${ROOT}/config/aseprite.json`, "utf8"));
  const home = process.env.HOME || "";
  const expand = (p) => {
    const m = String(p).match(/^\$\{([A-Z0-9_]+):-([^}]*)\}$/);
    const raw = m ? process.env[m[1]] || m[2] : p;
    if (String(raw).startsWith("~/")) return `${home}/${String(raw).slice(2)}`;
    return raw;
  };
  for (const [key, envName, marker] of [
    ["svgImporter", "GOTCHIBOT_SVG_IMPORTER", "svg-importer-cli.lua"],
    ["svgExporter", "GOTCHIBOT_SVG_EXPORTER", "svg-generator.lua"],
  ]) {
    const dir = expand(aseCfg.extensions?.[key] || "");
    if (dir && existsSync(`${dir}/${marker}`)) ok(`aseprite ${key}: ${dir}`);
    else warn(`aseprite ${key} missing — set ${envName} or config/aseprite.json extensions.${key}`);
  }
} catch {
  warn("config/aseprite.json unreadable — SVG import/export paths unknown");
}

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

const themeSrc = `${ROOT}/.opencode/themes/gotchi.json`;
const themeUser = `${process.env.XDG_CONFIG_HOME || `${process.env.HOME}/.config`}/opencode/themes/gotchi.json`;
if (!existsSync(themeSrc)) {
  warn("repo OpenCode theme missing (.opencode/themes/gotchi.json)");
} else {
  const inst = spawnSync("bash", [`${ROOT}/scripts/install-opencode-theme.sh`, "--quiet"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (inst.status === 0 && existsSync(themeUser)) ok(`OpenCode theme gotchi → ${themeUser}`);
  else if (inst.status === 0) ok("OpenCode theme gotchi (project .opencode/themes)");
  else warn("OpenCode theme install failed — run: ./scripts/gotchibot theme install");
}

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
