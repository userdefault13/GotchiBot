#!/usr/bin/env node
/**
 * Dumb lookup for weak models: where does the gotchibot-bridge extension store
 * its config? There is NO globalStorage/local.gotchibot-bridge/ folder — config
 * lives in VS Code User settings.json + the globalState SQLite (state.vscdb).
 *
 *   node ./scripts/hub-bridge-info.mjs [--json] [--local]
 *   abra run gotchibot -- ./scripts/gotchibot hub bridge-info
 *
 * From Desk it SSHes to the Hub and runs itself with --local. On the Hub
 * machine it reads local paths directly. Never touches secrets.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isHubMachine, loadHubBridgeConfig, hubBridgeHttpUrl, probeBridgeHttp } from "./claude-bridge-role.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
let jsonOut = true;
let forceLocal = false;
for (const a of args) {
  if (a === "--json") jsonOut = true;
  else if (a === "--local") forceLocal = true;
  else if (a === "--text") jsonOut = false;
  else if (a === "-h" || a === "--help") {
    console.error(`usage: hub-bridge-info.mjs [--json] [--local] [--text]
  Print where gotchibot-bridge config lives (settings.json + state.vscdb).
  --local  force local-only lookup (no SSH); --text  human-readable output`);
    process.exit(0);
  }
}

const EXT_ID = "local.gotchibot-bridge";
const NOTE =
  "NO globalStorage/local.gotchibot-bridge/ folder — config is settings.json + state.vscdb";

/** VS Code user dir for the current (Hub) user. */
function vscodeUserDir() {
  return join(homedir(), "Library/Application Support/Code/User");
}

/** Read gotchibotBridge.* keys from User settings.json (no secrets). */
function readSettingsKeys(settingsPath) {
  const out = {};
  try {
    const data = JSON.parse(readFileSync(settingsPath, "utf8"));
    for (const k of Object.keys(data)) {
      if (k.startsWith("gotchibotBridge.")) out[k] = data[k];
    }
  } catch {
    /* missing / unparsable — leave empty */
  }
  return out;
}

/** Dump globalState keys matching %gotchi% from state.vscdb (no values). */
function readGlobalStateKeys(dbPath) {
  const keys = [];
  if (!existsSync(dbPath)) return keys;
  const r = spawnSync(
    "sqlite3",
    [dbPath, "SELECT key FROM ItemTable WHERE key LIKE '%gotchi%';"],
    { encoding: "utf8" },
  );
  if (r.status === 0 && r.stdout) {
    for (const line of String(r.stdout).split("\n")) {
      const k = line.trim();
      if (k) keys.push(k);
    }
  }
  return keys;
}

/** List installed extension dirs for the bridge. */
function extensionDirs() {
  const base = join(homedir(), ".vscode/extensions");
  const dirs = [];
  if (!existsSync(base)) return dirs;
  try {
    for (const name of readdirSync(base)) {
      if (name.startsWith(`${EXT_ID}-`)) dirs.push(join(base, name));
    }
  } catch {}
  return dirs;
}

/** Local (Hub-machine) lookup. */
function localInfo() {
  const userDir = vscodeUserDir();
  const settingsPath = join(userDir, "settings.json");
  const dbPath = join(userDir, "globalStorage/state.vscdb");
  const missingGlobalStorage = join(userDir, "globalStorage/local.gotchibot-bridge");

  const cfg = loadHubBridgeConfig();
  const url = hubBridgeHttpUrl();
  const health = { ok: false, url };
  try {
    health.ok = probeBridgeHttp(url);
  } catch {
    health.ok = false;
  }

  return {
    ok: true,
    extensionId: EXT_ID,
    note: NOTE,
    paths: {
      settings: settingsPath,
      globalStateDb: dbPath,
      globalStorageDirExpectedButMissing: missingGlobalStorage,
      extensionInstallDirs: extensionDirs(),
      hubBridgeUrl: url,
      hubConfigRepo: "config/hub-bridge.json",
    },
    settingsKeys: readSettingsKeys(settingsPath),
    globalStateKeys: readGlobalStateKeys(dbPath),
    bridgeHealth: health,
  };
}

/** Desk: SSH to Hub and run this script with --local, capture JSON. */
async function deskInfo() {
  const { assertRemoteReady, materializeKey, runSsh } = await import(
    join(ROOT, "scripts/remote-lib.mjs")
  );
  const cfg = assertRemoteReady();
  const mat = materializeKey(cfg.key);
  try {
    const remoteCmd = `node ./scripts/hub-bridge-info.mjs --local --json`;
    const r = runSsh(cfg, mat.path, remoteCmd, { stdio: "pipe", timeout: 60_000 });
    const out = String(r.stdout || "").trim();
    if (r.status !== 0) {
      return {
        ok: false,
        error: `SSH to Hub failed (exit ${r.status}): ${String(r.stderr || "").trim()}`,
        host: cfg.host,
      };
    }
    try {
      return JSON.parse(out.split("\n").filter((l) => l.trim().startsWith("{")).join("\n"));
    } catch {
      return { ok: false, error: "unparsable Hub reply", raw: out, host: cfg.host };
    }
  } finally {
    mat.dispose();
  }
}

async function main() {
  let info;
  if (forceLocal) {
    info = localInfo();
  } else if (isHubMachine()) {
    info = localInfo();
  } else {
    info = await deskInfo();
  }
  if (jsonOut) {
    console.log(JSON.stringify(info, null, 2));
  } else {
    console.log(`extensionId: ${info.extensionId}`);
    console.log(`note: ${info.note}`);
    if (info.paths) {
      console.log(`settings: ${info.paths.settings}`);
      console.log(`globalStateDb: ${info.paths.globalStateDb}`);
      console.log(`missing globalStorage dir: ${info.paths.globalStorageDirExpectedButMissing}`);
      console.log(`extension dirs: ${(info.paths.extensionInstallDirs || []).join(", ") || "(none)"}`);
      console.log(`hubBridgeUrl: ${info.paths.hubBridgeUrl}`);
    }
    if (info.settingsKeys) console.log(`settingsKeys: ${JSON.stringify(info.settingsKeys)}`);
    if (info.globalStateKeys) console.log(`globalStateKeys: ${JSON.stringify(info.globalStateKeys)}`);
    if (info.bridgeHealth) console.log(`bridgeHealth: ${JSON.stringify(info.bridgeHealth)}`);
    if (info.error) console.error(`error: ${info.error}`);
  }
  process.exit(info && info.ok === false ? 1 : 0);
}

await main();
