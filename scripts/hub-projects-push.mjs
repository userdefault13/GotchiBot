#!/usr/bin/env node
/**
 * Desk → Hub project portfolio push (phone app project cards + crew pane).
 *
 * pstack rooms, hero caches and avatars live on the desk; the Hub renders the
 * same whitelisted files after a push (services/gotchibot-api/projects.mjs).
 * Auth = desk token from `gotchibot hub join` (sessions/.hub.json).
 *
 *   gotchibot hub projects push [--force] [--dry-run] [--json]
 *   gotchibot hub projects watch                      # foreground, event-driven
 *   gotchibot hub projects service install | uninstall | status
 *   gotchibot hub cockpit push [--force] [--dry-run] [--json]
 *
 * push skips when nothing changed since the last successful push (--force
 * sends anyway). watch uses recursive fs.watch (FSEvents on macOS, inotify on
 * Linux, Node >= 20) and pushes ~2s after a whitelisted file changes. service
 * keeps watch running: LaunchAgent on macOS, systemd user unit on Linux.
 * watch also pushes the cockpit snapshot (services/gotchibot-api/cockpit.mjs)
 * with each project push and every 60s, since roster/kanban/inbox change
 * outside the watched files.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";
import { contentHashOf } from "./chat-canonical.mjs";
import { hubRequest } from "./chat-hub-client.mjs";
import { collectProjectSnapshot, snapshotPathOk } from "../services/gotchibot-api/projects.mjs";
import { collectCockpitSnapshot } from "../services/gotchibot-api/cockpit.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = join(ROOT, "sessions/.hub-projects-push.json");
const LOG_DIR = join(ROOT, "sessions/hub-projects-push-logs");
export const SERVICE_LABEL = "com.gotchibot.hub-projects-watch";
export const SYSTEMD_UNIT = "gotchibot-hub-projects-watch.service";
const DEBOUNCE_MS = 2000;
const COCKPIT_INTERVAL_MS = 60_000;
const RETRY_MS = 30_000;
const RETRY_MAX_MS = 5 * 60_000;
const TOP_SESSION_FILES = new Set([".hero-agent-state.json", ".project-current", ".pstack-dossier-current"]);

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeState(patch) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify({ ...readState(), ...patch }, null, 2)}\n`);
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
  writeState({ hash, pushedAt: res.pushedAt });
  return { ok: true, pushedAt: res.pushedAt, hubProjects: res.projects, ...summary };
}

/** Cockpit hash without collectedAt, so an idle desk doesn't push every minute. */
export function cockpitHash(cockpit) {
  const { collectedAt: _at, ...rest } = cockpit;
  return contentHashOf(rest);
}

export async function pushCockpit({ force = false, dryRun = false, root = ROOT } = {}) {
  const cockpit = await collectCockpitSnapshot({ root });
  const hash = cockpitHash(cockpit);
  const summary = {
    agents: cockpit.roster.agents.length,
    cards: cockpit.kanban.columns.reduce((n, c) => n + c.cards.length, 0),
    messages: cockpit.inbox.messages.length,
    bytes: Buffer.byteLength(JSON.stringify(cockpit), "utf8"),
    hash,
  };
  if (dryRun) return { ok: true, dryRun: true, ...summary };
  if (!force && readState().cockpitHash === hash) return { ok: true, skipped: "unchanged", ...summary };
  const res = await hubRequest("POST", "/api/gotchibot/cockpit/push", { body: cockpit });
  writeState({ cockpitHash: hash, cockpitPushedAt: res.pushedAt });
  return { ok: true, pushedAt: res.pushedAt, ...summary };
}

/**
 * Does a change event in one watched dir touch something push sends?
 * @param {"sessions"|"pstack"|"avatars"|"config"} dir
 * @param {string|Buffer|null} filename relative to that dir (null = platform didn't say)
 */
export function watchRelevant(dir, filename) {
  if (filename == null) return true;
  const name = String(filename).split(sep).join("/");
  if (dir === "pstack") return !name.includes("/") || snapshotPathOk(`sessions/pstack/${name}`);
  if (dir === "avatars") return name.endsWith(".svg");
  if (dir === "sessions") return TOP_SESSION_FILES.has(name) || name === "pstack" || name === ".avatars";
  if (dir === "config") return name === "agent-roles.json";
  return false;
}

/**
 * Watch the desk tree and push after changes settle. Directories, not files,
 * are watched so atomic write-then-rename saves are still seen.
 * @param {{ root?: string, debounceMs?: number, retryMs?: number, pushFn?: () => Promise<any>, log?: (line: string) => void }} [opts]
 */
export function watchProjects({
  root = ROOT,
  debounceMs = DEBOUNCE_MS,
  retryMs = RETRY_MS,
  pushFn = () => push({ root }),
  log = (line) => console.log(line),
} = {}) {
  const watchers = new Map();
  let timer = null;
  let running = false;
  let again = false;
  let closed = false;
  let backoff = retryMs;

  function schedule(delay = debounceMs) {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(run, delay);
  }

  async function run() {
    if (closed) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      const r = await pushFn();
      backoff = retryMs;
      if (r && !r.skipped) {
        log(`${new Date().toISOString()} pushed ${r.projects} projects, ${r.files} files`);
      }
    } catch (err) {
      log(`${new Date().toISOString()} push failed: ${err.message || err} — retry in ${Math.round(backoff / 1000)}s`);
      schedule(backoff);
      backoff = Math.min(backoff * 2, RETRY_MAX_MS);
    } finally {
      running = false;
      if (again) {
        again = false;
        schedule();
      }
    }
  }

  function arm(key, dir, recursive) {
    watchers.get(key)?.close();
    watchers.delete(key);
    if (!existsSync(dir)) return;
    let w;
    try {
      w = watch(dir, { recursive }, (_event, filename) => {
        if (key === "sessions" && filename === "pstack") arm("pstack", join(root, "sessions/pstack"), true);
        if (key === "sessions" && filename === ".avatars") arm("avatars", join(root, "sessions/.avatars"), false);
        if (watchRelevant(key, filename)) schedule();
      });
    } catch (err) {
      if (err.code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM") {
        throw new Error("recursive file watch needs Node >= 20 on Linux");
      }
      throw err;
    }
    w.on("error", () => {
      w.close();
      if (watchers.get(key) === w) watchers.delete(key);
    });
    watchers.set(key, w);
  }

  arm("sessions", join(root, "sessions"), false);
  arm("pstack", join(root, "sessions/pstack"), true);
  arm("avatars", join(root, "sessions/.avatars"), false);
  arm("config", join(root, "config"), false);

  return {
    /** Push now (still single-flight). */
    flush: run,
    watching: () => [...watchers.keys()],
    close() {
      closed = true;
      clearTimeout(timer);
      for (const w of watchers.values()) w.close();
      watchers.clear();
    },
  };
}

function xmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function servicePath(nodePath) {
  return `${dirname(nodePath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
}

export function renderLaunchAgent({ nodePath, scriptPath, root, home, logDir }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(scriptPath)}</string>
    <string>watch</string>
  </array>
  <key>WorkingDirectory</key><string>${xmlEscape(root)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xmlEscape(join(logDir, "watch.out.log"))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(join(logDir, "watch.err.log"))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xmlEscape(servicePath(nodePath))}</string>
    <key>HOME</key><string>${xmlEscape(home)}</string>
  </dict>
</dict>
</plist>
`;
}

export function renderSystemdUnit({ nodePath, scriptPath, root }) {
  return `[Unit]
Description=GotchiBot desk → Hub project push (file watcher)
After=network-online.target

[Service]
ExecStart="${nodePath}" "${scriptPath}" watch
WorkingDirectory=${root}
Environment=PATH=${servicePath(nodePath)}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
}

function run(cmd, args) {
  return spawnSync(cmd, args, { encoding: "utf8" });
}

function mustRun(cmd, args) {
  const r = run(cmd, args);
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed: ${String(r.stderr || r.stdout).trim().slice(0, 300)}`);
  }
  return r;
}

function serviceDarwin(action, opts) {
  const target = `gui/${process.getuid()}`;
  const file = join(homedir(), "Library/LaunchAgents", `${SERVICE_LABEL}.plist`);
  if (action === "status") {
    const loaded = run("launchctl", ["print", `${target}/${SERVICE_LABEL}`]).status === 0;
    return { installed: existsSync(file), running: loaded, plist: file, logs: LOG_DIR };
  }
  if (action === "uninstall") {
    run("launchctl", ["bootout", `${target}/${SERVICE_LABEL}`]);
    rmSync(file, { force: true });
    return { uninstalled: true };
  }
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderLaunchAgent({ ...opts, home: homedir(), logDir: LOG_DIR }));
  run("launchctl", ["bootout", `${target}/${SERVICE_LABEL}`]);
  mustRun("launchctl", ["bootstrap", target, file]);
  return { installed: true, plist: file, logs: LOG_DIR };
}

function serviceLinux(action, opts) {
  const file = join(homedir(), ".config/systemd/user", SYSTEMD_UNIT);
  if (action === "status") {
    const active = run("systemctl", ["--user", "is-active", SYSTEMD_UNIT]).stdout.trim();
    return { installed: existsSync(file), running: active === "active", unit: file, logs: `journalctl --user -u ${SYSTEMD_UNIT}` };
  }
  if (action === "uninstall") {
    run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
    rmSync(file, { force: true });
    run("systemctl", ["--user", "daemon-reload"]);
    return { uninstalled: true };
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderSystemdUnit(opts));
  mustRun("systemctl", ["--user", "daemon-reload"]);
  mustRun("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]);
  run("systemctl", ["--user", "restart", SYSTEMD_UNIT]);
  return { installed: true, unit: file, logs: `journalctl --user -u ${SYSTEMD_UNIT}` };
}

function service(action) {
  if (!["install", "uninstall", "status"].includes(action)) {
    throw new Error("usage: hub projects service install | uninstall | status");
  }
  const opts = { nodePath: process.execPath, scriptPath: fileURLToPath(import.meta.url), root: ROOT };
  let out;
  if (process.platform === "darwin") out = serviceDarwin(action, opts);
  else if (process.platform === "linux") out = serviceLinux(action, opts);
  else throw new Error(`service not supported on ${process.platform} — run \`hub projects watch\` under your own supervisor`);
  return { ok: true, ...out, last: readState() };
}

function startWatch() {
  let first = true;
  let cockpitFirst = true;
  let cockpitRunning = false;
  const cockpit = async () => {
    if (cockpitRunning) return;
    cockpitRunning = true;
    const force = cockpitFirst;
    try {
      const r = await pushCockpit({ force });
      cockpitFirst = false;
      if (!r.skipped) {
        console.log(`${new Date().toISOString()} pushed cockpit (${r.agents} agents, ${r.cards} cards, ${r.messages} messages)`);
      }
    } catch (err) {
      console.log(`${new Date().toISOString()} cockpit push failed: ${err.message || err}`);
    } finally {
      cockpitRunning = false;
    }
  };
  const w = watchProjects({
    pushFn: async () => {
      const force = first;
      first = false;
      const r = await push({ force });
      void cockpit();
      return r;
    },
  });
  const tick = setInterval(() => void cockpit(), COCKPIT_INTERVAL_MS);
  console.log(`${new Date().toISOString()} watching ${w.watching().join(", ")} under ${ROOT}`);
  void w.flush();
  const stop = () => {
    clearInterval(tick);
    w.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function main(argv) {
  const [cmd = "push", ...rest] = argv;
  if (cmd === "watch") return startWatch();
  let result;
  if (cmd === "push") {
    result = await push({ force: rest.includes("--force"), dryRun: rest.includes("--dry-run") });
  } else if (cmd === "cockpit") {
    result = await pushCockpit({ force: rest.includes("--force"), dryRun: rest.includes("--dry-run") });
  } else if (cmd === "service") {
    result = service(rest[0] || "status");
  } else {
    console.error(
      "usage: hub projects push [--force] [--dry-run] [--json] | watch | service install|uninstall|status\n" +
        "       hub cockpit push [--force] [--dry-run] [--json]",
    );
    process.exit(2);
  }
  if (rest.includes("--json") || cmd === "service") {
    console.log(JSON.stringify(result, null, 2));
  } else if (cmd === "cockpit") {
    const what = `${result.agents} agents, ${result.cards} cards, ${result.messages} messages`;
    if (result.skipped) console.log(`cockpit unchanged — ${what} (use --force to resend)`);
    else if (result.dryRun) console.log(`would push cockpit: ${what}, ${result.bytes} bytes`);
    else console.log(`pushed cockpit: ${what} at ${result.pushedAt}`);
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
