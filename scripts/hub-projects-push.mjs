#!/usr/bin/env node
/**
 * Desk → Hub project portfolio push (phone app project cards + crew pane).
 *
 * pstack rooms, hero caches and avatars live on the desk; the Hub renders the
 * same whitelisted files after a push (services/gotchibot-api/projects.mjs).
 * Auth = desk token from `gotchibot hub join` (sessions/.hub.json).
 *
 *   gotchibot hub projects push [--force] [--dry-run] [--json]
 *   gotchibot hub projects schedule install [--every SEC] | uninstall | status
 *
 * push skips when nothing changed since the last successful push (--force
 * sends anyway). schedule is a macOS LaunchAgent running push every 5 min.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";
import { contentHashOf } from "./chat-canonical.mjs";
import { hubRequest } from "./chat-hub-client.mjs";
import { collectProjectSnapshot } from "../services/gotchibot-api/projects.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = join(ROOT, "sessions/.hub-projects-push.json");
const LOG_DIR = join(ROOT, "sessions/hub-projects-push-logs");
export const SCHEDULE_LABEL = "com.gotchibot.hub-projects-push";
const DEFAULT_EVERY_SEC = 300;

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

async function heroNameFn() {
  try {
    const mod = await import("./openclaw-fleet.mjs");
    return typeof mod.heroDisplayName === "function" ? mod.heroDisplayName : null;
  } catch {
    return null;
  }
}

/** Hash of what the Hub would store — mtimes excluded so a touch alone doesn't push. */
export function snapshotHash(snapshot) {
  return contentHashOf({
    files: snapshot.files.map((f) => ({ path: f.path, text: f.text })),
    heroNames: snapshot.heroNames,
  });
}

export async function push({ force = false, dryRun = false, root = ROOT } = {}) {
  const snapshot = collectProjectSnapshot({ root, heroName: await heroNameFn() });
  const hash = snapshotHash(snapshot);
  const bytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
  const summary = {
    files: snapshot.files.length,
    projects: new Set(
      snapshot.files
        .map((f) => f.path.match(/^sessions\/pstack\/([^/]+)\//)?.[1])
        .filter(Boolean),
    ).size,
    bytes,
    hash,
  };
  if (dryRun) return { ok: true, dryRun: true, ...summary };
  if (!force && readState().hash === hash) return { ok: true, skipped: "unchanged", ...summary };
  const res = await hubRequest("POST", "/api/gotchibot/projects/push", { body: snapshot });
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify({ hash, pushedAt: res.pushedAt }, null, 2)}\n`);
  return { ok: true, pushedAt: res.pushedAt, hubProjects: res.projects, ...summary };
}

function xmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderSchedulePlist({ nodePath, scriptPath, root, home, everySec, logDir }) {
  const pathEnv = `${dirname(nodePath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SCHEDULE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(scriptPath)}</string>
    <string>push</string>
  </array>
  <key>WorkingDirectory</key><string>${xmlEscape(root)}</string>
  <key>StartInterval</key><integer>${Number(everySec)}</integer>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>${xmlEscape(join(logDir, "push.out.log"))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(join(logDir, "push.err.log"))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xmlEscape(pathEnv)}</string>
    <key>HOME</key><string>${xmlEscape(home)}</string>
  </dict>
</dict>
</plist>
`;
}

function plistPath() {
  return join(homedir(), "Library/LaunchAgents", `${SCHEDULE_LABEL}.plist`);
}

function launchctl(...args) {
  return spawnSync("launchctl", args, { encoding: "utf8" });
}

function schedule(action, { everySec = DEFAULT_EVERY_SEC } = {}) {
  if (process.platform !== "darwin") {
    throw new Error("schedule is macOS-only (LaunchAgent); on Linux run `push` from a systemd timer or cron");
  }
  const target = `gui/${process.getuid()}`;
  const file = plistPath();
  if (action === "status") {
    const loaded = launchctl("print", `${target}/${SCHEDULE_LABEL}`).status === 0;
    return { ok: true, installed: existsSync(file), loaded, plist: file, last: readState() };
  }
  if (action === "uninstall") {
    launchctl("bootout", `${target}/${SCHEDULE_LABEL}`);
    rmSync(file, { force: true });
    return { ok: true, uninstalled: true };
  }
  if (action === "install") {
    const every = Math.max(60, Number(everySec) || DEFAULT_EVERY_SEC);
    mkdirSync(LOG_DIR, { recursive: true });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      renderSchedulePlist({
        nodePath: process.execPath,
        scriptPath: fileURLToPath(import.meta.url),
        root: ROOT,
        home: homedir(),
        everySec: every,
        logDir: LOG_DIR,
      }),
    );
    launchctl("bootout", `${target}/${SCHEDULE_LABEL}`);
    const boot = launchctl("bootstrap", target, file);
    if (boot.status !== 0) {
      throw new Error(`launchctl bootstrap failed: ${String(boot.stderr || boot.stdout).trim().slice(0, 300)}`);
    }
    return { ok: true, installed: true, everySec: every, plist: file, logs: LOG_DIR };
  }
  throw new Error("usage: hub projects schedule install [--every SEC] | uninstall | status");
}

function flagValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv) {
  const [cmd = "push", ...rest] = argv;
  const asJson = rest.includes("--json");
  let result;
  if (cmd === "push") {
    result = await push({ force: rest.includes("--force"), dryRun: rest.includes("--dry-run") });
  } else if (cmd === "schedule") {
    result = schedule(rest[0] || "status", { everySec: flagValue(rest, "--every") });
  } else {
    console.error("usage: hub projects push [--force] [--dry-run] [--json] | schedule install|uninstall|status");
    process.exit(2);
  }
  if (asJson || cmd === "schedule") {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.skipped) {
    console.log(`unchanged — ${result.projects} projects, ${result.files} files (use --force to resend)`);
  } else if (result.dryRun) {
    console.log(`would push ${result.projects} projects, ${result.files} files, ${result.bytes} bytes`);
  } else {
    console.log(`pushed ${result.projects} projects, ${result.files} files at ${result.pushedAt}`);
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`[hub-projects-push] ${new Date().toISOString()} ${err.message || err}`);
    process.exit(1);
  });
}
