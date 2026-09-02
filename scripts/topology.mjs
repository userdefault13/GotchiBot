#!/usr/bin/env node
/**
 * Solo vs Fleet topology.
 *
 *   sessions/.topology.json: { "mode": "solo"|"fleet", "updatedAt": "<iso>" }
 *   Env GOTCHIBOT_TOPOLOGY=solo|fleet wins over the file.
 *   No file + no env → "legacy" (callers must keep today's behavior).
 *
 * CLI (via scripts/gotchibot):
 *   topology solo|fleet|status [--json]
 *   topology setup                 → gotchibot setup (guided solo bootstrap)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = `${ROOT}/sessions`;
const TOPO_PATH = `${SESSIONS}/.topology.json`;
const REFERRAL_PATH = `${ROOT}/config/opencode.referral.json`;
const VALID = ["solo", "fleet"];

export function getTopology(env = process.env) {
  const envMode = String(env.GOTCHIBOT_TOPOLOGY ?? "").trim().toLowerCase();
  if (VALID.includes(envMode)) return { mode: envMode, source: "env" };
  try {
    const t = JSON.parse(readFileSync(TOPO_PATH, "utf8"));
    const m = String(t?.mode ?? "").trim().toLowerCase();
    if (VALID.includes(m)) return { mode: m, source: "file", updatedAt: t.updatedAt ?? null };
  } catch {}
  return { mode: "legacy", source: "default" };
}

export function setTopology(mode, env = process.env) {
  if (!VALID.includes(mode)) throw new Error(`invalid mode: ${mode}`);
  mkdirSync(SESSIONS, { recursive: true });
  writeFileSync(TOPO_PATH, JSON.stringify({ mode, updatedAt: new Date().toISOString() }) + "\n");
  return getTopology(env);
}

export function topologyPath() {
  return TOPO_PATH;
}

export function topologyFileExists() {
  return existsSync(TOPO_PATH);
}

function loadReferral() {
  try {
    return JSON.parse(readFileSync(REFERRAL_PATH, "utf8"));
  } catch {
    return null;
  }
}

function cmdStatus(json = false) {
  const t = getTopology();
  const note =
    t.mode === "legacy"
      ? "no topology file — legacy behavior (remote iMac preferred when Tailscale SSH works)"
      : t.mode === "solo"
        ? "solo — spawn --host auto stays local (explicit --host imac still allowed)"
        : "fleet — remote iMac preferred when Tailscale SSH works";
  if (json) {
    console.log(JSON.stringify({ ...t, path: TOPO_PATH, note }, null, 2));
  } else {
    console.log(`topology: ${t.mode} (source: ${t.source})`);
    if (t.mode === "fleet") console.log("tip: fleet needs the remote path — review: gotchibot remote-setup");
    console.log(note);
  }
  return t;
}

function cmdSetup() {
  const env = process.env;
  const referral = loadReferral();
  console.log("GotchiBot setup — Solo bootstrap\n");
  console.log("  Quick start (one command):");
  console.log("    ./scripts/gotchibot onboard");
  console.log("");
  console.log("  What onboard does:");
  console.log("    1. wallet connect (MetaMask in browser)");
  console.log("    2. register install → saves GOTCHIBOT_INFRA_TOKEN in abra");
  console.log("    3. sim-mint gotchibot cartridge");
  console.log("    4. doctor checklist");
  console.log("");
  console.log("  Before onboard: node ≥ 18, tmux, abra on PATH — see docs/SOLO-LINUX-WINDOWS.md");
  if (referral?.goUrl) {
    console.log(`  After onboard: ${referral.label ?? "OpenCode Go"} → ${referral.goUrl}`);
    console.log("    (BYO models: abra set gotchibot OPENCODE_API_KEY — never in files)");
  }
  console.log("");

  const t = getTopology(env);
  const fleetish = Boolean(env.REMOTE_HOST || env.GOTCHIBOT_REMOTE_HOST || env.GOTCHIBOT_REMOTE_USER);
  if (!topologyFileExists() && !fleetish && t.mode !== "fleet") {
    // fresh solo path — no topology file, no obvious fleet remote config
    setTopology("solo", env);
    console.log(`topology → solo written (${TOPO_PATH})`);
  } else if (t.mode === "solo") {
    console.log(`topology already solo (source: ${t.source}) — nothing to write`);
  } else {
    console.log(
      `topology is ${t.mode}${t.source !== "default" ? ` (${t.source})` : ""} — not writing automatically.`,
    );
    console.log("If you want Solo, run explicitly:  ./scripts/gotchibot topology solo");
  }
}

function main() {
  const args = process.argv.slice(2);
  const sub = (args[0] ?? "status").toLowerCase();
  const json = args.includes("--json");

  if (sub === "status") {
    cmdStatus(json);
    return;
  }
  if (sub === "setup") {
    cmdSetup();
    return;
  }
  if (VALID.includes(sub)) {
    try {
      setTopology(sub);
    } catch (e) {
      console.error(`topology failed: ${e.message}`);
      process.exit(1);
    }
    console.log(`topology → ${sub} (${TOPO_PATH})`);
    if (sub === "fleet") console.log("tip: run ./scripts/gotchibot remote-setup to wire the iMac path");
    return;
  }
  console.error("usage: gotchibot topology solo|fleet|status [--json] | topology setup");
  process.exit(2);
}

function isDirectRun() {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) main();
