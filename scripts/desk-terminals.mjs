#!/usr/bin/env node
/**
 * desk-terminals.mjs — Claude/Cursor Terminal viewports on the iMac desk.
 *
 *   ./scripts/gotchibot desk-terminals status [--json]
 *   ./scripts/gotchibot desk-terminals open [hero…]     driven heroes only if no hero listed
 *   ./scripts/gotchibot desk-terminals use <hero> [-- <cmd…>]
 *       ephemeral: open → (optional cmd) → tear down Terminal + tool window
 *   ./scripts/gotchibot desk-terminals close [hero…]
 *       driven: detach Terminal, keep tool; ephemeral: detach + kill tool window
 *   ./scripts/gotchibot desk-terminals install|uninstall
 *   … --host imac|local   default imac from MBP; on iMac → local
 *   … --dry-run
 *
 * Driven roles (trader / infra / comms) keep a standing Claude window — cycles
 * need sticky context. Worker / orchestrator desks are ephemeral: open only for
 * a turn, use the tool, relay, close. `install` only re-opens driven desks.
 *
 * Grouped tmux sessions (`gotchibot-<hero>`) share windows with `gotchibot` but
 * keep their own current window so each Terminal stays pinned. Claude/Cursor
 * need the console keychain — log in at the iMac screen, not plain SSH.
 *
 * Optional config/desk-terminals.json:
 *   { "skip": ["owned-954"],
 *     "heroes": { "starter-dai-h1-2": { "tool": "cursor" },
 *                 "starter-dai-h1-3": { "window": "dai3-desk", "workspace": "~/Dev/x" } } }
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = homedir();
const BASE_SESSION = process.env.GOTCHIBOT_TMUX_SESSION || "gotchibot";
const LABEL = "com.gotchibot.desk-terminals";
const LOG_DIR = join(ROOT, "sessions/desk-terminals-logs");
const REOPEN_SEC = Number(process.env.DESK_TERMINALS_INTERVAL_SEC || 300);
const COLS = 200;
const ROWS = 50;

const TMUX =
  [process.env.TMUX_BIN, "/opt/homebrew/bin/tmux", "/usr/local/bin/tmux"].find((p) => p && existsSync(p)) || "tmux";
const CLAUDE_BIN =
  process.env.INFRA_CLAUDE_BIN ||
  [`${HOME}/.local/bin/claude`, "/opt/homebrew/bin/claude", "/usr/local/bin/claude"].find((p) => existsSync(p)) ||
  "claude";
const CURSOR_BIN =
  [`${HOME}/.local/bin/cursor-agent`, "/opt/homebrew/bin/cursor-agent", "/usr/local/bin/cursor-agent"].find((p) =>
    existsSync(p),
  ) || "cursor-agent";

const args = process.argv.slice(2);
const dashDash = args.indexOf("--");
const frontArgs = dashDash >= 0 ? args.slice(0, dashDash) : args;
const afterDash = dashDash >= 0 ? args.slice(dashDash + 1) : [];
const positional = frontArgs.filter((a, i) => !a.startsWith("--") && frontArgs[i - 1] !== "--host");
const cmd = positional[0] || "status";
const heroArgs = positional.slice(1);
const json = frontArgs.includes("--json");
const dryRun = frontArgs.includes("--dry-run");
const hostArg = frontArgs.includes("--host") ? frontArgs[frontArgs.indexOf("--host") + 1] : "imac";

const sh = (bin, a, opts = {}) => spawnSync(bin, a, { encoding: "utf8", ...opts });
const tmux = (a) => {
  const r = sh(TMUX, a);
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
};
const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// --- Host routing (same shape as comms-claude-cycle) --------------------------
function onImac() {
  if (process.env.GOTCHIBOT_ON_IMAC === "1") return true;
  const want = String(process.env.REMOTE_HOST || process.env.GOTCHIBOT_REMOTE_HOST || "").toLowerCase().split(".")[0];
  const have = hostname().toLowerCase().split(".")[0];
  return Boolean(want) && want === have;
}

function resolveHost() {
  if (hostArg === "local") return "local";
  if (hostArg !== "imac") throw new Error("--host must be local or imac");
  return onImac() ? "local" : "imac";
}

async function runOnImac() {
  const { assertRemoteReady, materializeKey, runSsh } = await import("./remote-lib.mjs");
  const cfg = assertRemoteReady({ needKey: true });
  const key = materializeKey(cfg.key);
  const remoteRoot = `/Users/${cfg.user}/Dev/GotchiBot`;
  const passthrough = args.filter((a, i) => !(a === "--host" || args[i - 1] === "--host"));
  try {
    const remoteCmd = [
      "set -euo pipefail",
      `cd ${shellQuote(remoteRoot)}`,
      'export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"',
      "export GOTCHIBOT_ON_IMAC=1",
      `node scripts/desk-terminals.mjs --host local ${passthrough.map(shellQuote).join(" ")}`,
    ].join("; ");
    console.error(`[desk-terminals] running on the iMac (${cfg.host})…`);
    const r = runSsh(cfg, key.path, remoteCmd, { stdio: "inherit" });
    return r.status ?? 1;
  } finally {
    key.dispose();
  }
}

// --- Roster ----------------------------------------------------------------------
function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function fleet() {
  const p = join(ROOT, "config/openclaw.fleet.list.json5");
  if (!existsSync(p)) return [];
  const text = readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
  try {
    return JSON.parse(text).filter((a) => a?.id && a.id !== "gotchi");
  } catch {
    return [];
  }
}

// Windows the cycles already drive, keyed by role. The tool list matches the
// cycle's own so a session we start unattended can answer without a permission
// menu; the cycle re-briefs it on first use (lib handles "window alive, no
// record").
const DRIVEN = {
  "aarcade-comms-handler": {
    window: process.env.COMMS_CLAUDE_WINDOW || "comms-claude",
    workspace: process.env.COMMS_CLAUDE_WORKSPACE || `${HOME}/Dev/gotchibot-comms-claude`,
    seed: "config/comms-claude-workspace/CLAUDE.md",
    allowedTools:
      "Bash(git log:*),Bash(git diff:*),Bash(git show:*),Bash(git rev-list:*),Bash(git cat-file:*),Read,Glob,Grep,Write",
    driver: "comms-claude-cycle.mjs",
  },
  "trader-desk": {
    window: process.env.TRADER_VERIFY_WINDOW || "link-verify",
    workspace: process.env.TRADER_VERIFY_WORKSPACE || `${HOME}/Dev/gotchibot-trader-verify`,
    seed: "config/trader-verify-workspace/CLAUDE.md",
    allowedTools: "Bash(curl:*),Read,Glob,Grep",
    driver: "trader-cycle.mjs",
  },
  "infra-monitor": {
    window: process.env.INFRA_CLAUDE_TMUX_WINDOW || "claude-verify",
    workspace: process.env.INFRA_CLAUDE_WORKSPACE || `${HOME}/Dev/gotchibot-infra-verify`,
    seed: "config/infra-verify-workspace/CLAUDE.md",
    allowedTools: "Bash(docker ps:*),Bash(docker info:*),Bash(curl:*)",
    driver: "infra-claude-verify.mjs",
  },
  "moltbook-watch": {
    window: process.env.MOLTBOOK_DESK_WINDOW || "starter-dai-h1-1-desk",
    workspace: process.env.MOLTBOOK_DESK_WORKSPACE || `${HOME}/Dev/gotchibot-desk-starter-dai-h1-1`,
    seed: "config/agent-desk-workspace/CLAUDE.md",
    allowedTools: "Read,Glob,Grep,Bash(curl:*)",
    driver: "moltbook-watch.mjs",
  },
};

const slug = (id) => String(id).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const expandHome = (p) => (p && p.startsWith("~/") ? join(HOME, p.slice(2)) : p);

function plan() {
  const roles = readJson(join(ROOT, "config/agent-roles.json"), {});
  const playbooks = readJson(join(ROOT, "config/agent-role-playbooks.json"), {});
  const overrides = readJson(join(ROOT, "config/desk-terminals.json"), {});
  const skip = new Set(overrides.skip || []);
  const out = [];
  for (const a of fleet()) {
    if (skip.has(a.id)) continue;
    const role = roles[a.id] || null;
    const name = a.identity?.name || a.id;
    const o = overrides.heroes?.[a.id] || {};
    // A resummoned hero keeps its old desk's driven window via standing duty
    // (config/agent-standing-duties.json) — e.g. LINK keeps link-verify after
    // moving from trader-desk to financial-analyst.
    const standing = readJson(join(ROOT, "config/agent-standing-duties.json"), {})[a.id] || null;
    const driven = (role && DRIVEN[role]) || (standing?.driver ? standing : null);
    const tool = o.tool || playbooks[role]?.deskTool || "claude";
    const s = slug(a.id);
    const isDriven = Boolean(driven) && !o.window;
    out.push({
      id: a.id,
      name,
      role,
      roleTitle: playbooks[role]?.title || null,
      tool,
      driven: isDriven,
      ephemeral: o.ephemeral === true || (!isDriven && o.ephemeral !== false),
      driver: driven?.driver || null,
      session: `${BASE_SESSION}-${s}`,
      window: o.window || driven?.window || `${s}-desk`,
      workspace: expandHome(o.workspace) || driven?.workspace || `${HOME}/Dev/gotchibot-desk-${s}`,
      seed: o.seed || driven?.seed || "config/agent-desk-workspace/CLAUDE.md",
      allowedTools: o.allowedTools || driven?.allowedTools || "Read,Glob,Grep",
      title: `GotchiBot ${name} (${a.id}) · ${tool}`,
    });
  }
  const want = heroArgs.length ? new Set(heroArgs) : null;
  return want ? out.filter((h) => want.has(h.id) || want.has(h.name) || want.has(slug(h.id))) : out;
}

// --- tmux / desktop -----------------------------------------------------------------
const hasSession = (s) => tmux(["has-session", "-t", `=${s}`]).ok;
const windowNames = (s) => (tmux(["list-windows", "-t", `=${s}`, "-F", "#{window_name}"]).out || "").split("\n").filter(Boolean);
const windowExists = (s, w) => windowNames(s).includes(w);
const clients = (s) => (tmux(["list-clients", "-t", `=${s}`]).out || "").split("\n").filter(Boolean).length;
const consoleUser = () => (sh("stat", ["-f", "%Su", "/dev/console"]).stdout || "").trim();

function ensureWorkspace(h) {
  const target = join(h.workspace, "CLAUDE.md");
  if (existsSync(target)) return false;
  const src = join(ROOT, h.seed);
  if (!existsSync(src)) throw new Error(`no seed ${h.seed} for ${h.id}`);
  const roleLine = h.roleTitle ? ` whose standing job is ${h.roleTitle} (${h.role})` : "";
  const body = readFileSync(src, "utf8")
    .replace(/\{\{NAME\}\}/g, h.name)
    .replace(/\{\{ID\}\}/g, h.id)
    .replace(/\{\{ROLE_LINE\}\}/g, roleLine);
  mkdirSync(h.workspace, { recursive: true });
  writeFileSync(target, body, "utf8");
  return true;
}

// Claude asks "do you trust the files in this folder?" the first time it opens
// a directory; nobody is there to answer in an unattended window.
function preTrust(workspace) {
  const p = join(HOME, ".claude.json");
  const j = readJson(p, {});
  j.projects = j.projects || {};
  const cur = j.projects[workspace] || {};
  if (cur.hasTrustDialogAccepted === true) return false;
  j.projects[workspace] = { ...cur, hasTrustDialogAccepted: true };
  writeFileSync(p, JSON.stringify(j, null, 2), "utf8");
  return true;
}

function toolCommand(h) {
  const path = `/usr/local/bin:/opt/homebrew/bin:${HOME}/.local/bin:/usr/bin:/bin`;
  const caf = existsSync("/usr/bin/caffeinate") ? "/usr/bin/caffeinate -dimsu " : "";
  if (h.tool === "cursor") return `PATH="${path}" exec ${caf}"${CURSOR_BIN}"`;
  return `PATH="${path}" exec ${caf}"${CLAUDE_BIN}" --allowedTools "${h.allowedTools}"`;
}

function ensureWindow(h, log) {
  if (!hasSession(BASE_SESSION)) {
    if (dryRun) return log(`would create base tmux session ${BASE_SESSION}`);
    tmux(["new-session", "-d", "-s", BASE_SESSION, "-n", "work"]);
  }
  if (windowExists(BASE_SESSION, h.window)) return log(`window ${BASE_SESSION}:${h.window} alive`);
  if (dryRun) return log(`would start ${h.tool} in ${BASE_SESSION}:${h.window} (${h.workspace})`);
  if (ensureWorkspace(h)) log(`seeded ${h.workspace}/CLAUDE.md`);
  if (h.tool === "claude" && preTrust(h.workspace)) log(`pre-trusted ${h.workspace}`);
  const r = tmux(["new-window", "-d", "-t", `=${BASE_SESSION}`, "-n", h.window, "-c", h.workspace, toolCommand(h)]);
  if (!r.ok) throw new Error(`new-window ${h.window}: ${r.err}`);
  tmux(["resize-window", "-t", `=${BASE_SESSION}:${h.window}`, "-x", String(COLS), "-y", String(ROWS)]);
  log(`started ${h.tool} in ${BASE_SESSION}:${h.window}`);
}

function ensureGroupedSession(h, log) {
  if (hasSession(h.session)) return;
  if (dryRun) return log(`would create grouped session ${h.session} → ${BASE_SESSION}`);
  const r = tmux(["new-session", "-d", "-t", `=${BASE_SESSION}`, "-s", h.session]);
  if (!r.ok) throw new Error(`grouped session ${h.session}: ${r.err}`);
  log(`created grouped session ${h.session}`);
}

function showTerminal(h, log) {
  if (dryRun) return log(`would open Terminal "${h.title}" on ${h.session}:${h.window}`);
  const r = sh(
    join(ROOT, "scripts/agent-desktop-terminal.sh"),
    ["--session", h.session, "--window", h.window, "--title", h.title, "--cols", String(COLS), "--rows", String(ROWS)],
    { timeout: 45000 },
  );
  log((r.stdout || r.stderr || "").trim() || `desktop-terminal exit ${r.status}`);
  return r.status === 0;
}

function open(heroes) {
  const user = consoleUser();
  if (!dryRun && (!user || user === "root")) {
    console.error("[desk-terminals] no console user logged in — nothing to draw on (log in at the iMac screen)");
    process.exit(1);
  }
  let failed = 0;
  for (const h of heroes) {
    const log = (m) => console.log(`${h.name} (${h.id}): ${m}`);
    try {
      ensureWindow(h, log);
      ensureGroupedSession(h, log);
      // Pin this hero's session to its window, then attach a Terminal to it.
      if (!dryRun) tmux(["select-window", "-t", `=${h.session}:${h.window}`]);
      if (showTerminal(h, log) === false) failed++;
    } catch (e) {
      failed++;
      log(`FAILED ${e.message}`);
    }
  }
  return failed;
}

function close(heroes) {
  for (const h of heroes) {
    if (dryRun) {
      console.log(
        `${h.name}: would ${h.ephemeral ? "tear down Terminal + tool window" : "detach Terminal (keep tool)"} for ${h.id}`,
      );
      continue;
    }
    if (hasSession(h.session)) {
      tmux(["detach-client", "-s", `=${h.session}`]);
    }
    if (h.ephemeral) {
      if (hasSession(BASE_SESSION) && windowExists(BASE_SESSION, h.window)) {
        tmux(["kill-window", "-t", `=${BASE_SESSION}:${h.window}`]);
      }
      if (hasSession(h.session)) {
        tmux(["kill-session", "-t", `=${h.session}`]);
      }
      console.log(`${h.name}: closed Terminal + tore down ${BASE_SESSION}:${h.window}`);
    } else {
      console.log(`${h.name}: detached ${h.session} (tool kept in ${BASE_SESSION}:${h.window})`);
    }
  }
}

function use(heroes) {
  if (heroes.length !== 1) {
    throw new Error("use requires exactly one hero: desk-terminals use <hero-id> [-- <cmd…>]");
  }
  const h = heroes[0];
  const failed = open([h]);
  if (failed) return failed;
  if (!afterDash.length) {
    console.log(
      `${h.name}: desk open on ${h.session}:${h.window} — finish the Claude/Cursor turn, then: gotchibot desk-terminals close ${h.id}`,
    );
    return 0;
  }
  if (dryRun) {
    console.log(`${h.name}: would run: ${afterDash.join(" ")} then close`);
    return 0;
  }
  let statusCode = 0;
  try {
    const r = spawnSync(afterDash[0], afterDash.slice(1), {
      stdio: "inherit",
      cwd: ROOT,
      env: process.env,
      shell: false,
    });
    statusCode = r.status ?? 1;
  } finally {
    close([h]);
  }
  return statusCode;
}

function status(heroes) {
  return {
    host: hostname(),
    console: consoleUser(),
    baseSession: hasSession(BASE_SESSION),
    heroes: heroes.map((h) => ({
      id: h.id,
      name: h.name,
      role: h.role,
      tool: h.tool,
      driven: h.driven,
      ephemeral: h.ephemeral,
      window: h.window,
      windowAlive: hasSession(BASE_SESSION) && windowExists(BASE_SESSION, h.window),
      session: h.session,
      sessionAlive: hasSession(h.session),
      terminals: hasSession(h.session) ? clients(h.session) : 0,
      workspace: h.workspace,
      workspaceSeeded: existsSync(join(h.workspace, "CLAUDE.md")),
    })),
  };
}

function printStatus(st, launch) {
  console.log(`host ${st.host} · console user ${st.console || "none"} · base tmux ${st.baseSession ? "up" : "DOWN"}`);
  for (const h of st.heroes) {
    const live = h.windowAlive && h.terminals > 0;
    const label = live ? "ok   " : h.ephemeral && !h.windowAlive ? "idle " : h.windowAlive ? "hidden" : "MISSING";
    console.log(
      `${label} ${h.name.padEnd(7)} ${h.id.padEnd(18)} ${h.tool.padEnd(6)} ${h.window.padEnd(22)} ` +
        `${h.windowAlive ? "tool up" : "tool down"} · ${h.terminals} terminal${h.terminals === 1 ? "" : "s"}` +
        `${h.driven ? " · driven" : ""}${h.ephemeral ? " · ephemeral" : ""}`,
    );
  }
  if (launch) {
    console.log(
      `${launch.loaded ? "ok   " : "off  "} LaunchAgent ${LABEL} ${
        launch.loaded ? `loaded (runs=${launch.loaded.runs ?? "?"})` : "not installed — run: gotchibot desk-terminals install"
      }`,
    );
  }
}

async function main() {
  if (resolveHost() === "imac") process.exit(await runOnImac());
  const heroes = plan();
  if (!heroes.length) {
    console.error(
      heroArgs.length
        ? `no matching hero for: ${heroArgs.join(", ")}`
        : "no heroes in config/openclaw.fleet.list.json5 (run: gotchibot openclaw sync)",
    );
    process.exit(1);
  }
  const launchd = await import("./lib/launchd-job.mjs");

  if (cmd === "status") {
    const st = status(heroes);
    const launch = { loaded: launchd.loaded(LABEL), plist: existsSync(launchd.plistPath(LABEL)) };
    if (json) console.log(JSON.stringify({ ...st, launchAgent: launch }, null, 2));
    else printStatus(st, launch);
    const bad = st.heroes.filter((h) => (h.driven || !h.ephemeral) && !(h.windowAlive && h.terminals > 0));
    process.exit(bad.length ? 1 : 0);
  }
  if (cmd === "open") {
    const targets = heroArgs.length ? heroes : heroes.filter((h) => h.driven);
    if (!targets.length) {
      console.error(
        "open with no heroes only targets driven desks; pass a hero id, or: desk-terminals use <hero>",
      );
      process.exit(1);
    }
    const failed = open(targets);
    process.exit(failed ? 1 : 0);
  }
  if (cmd === "close") {
    close(heroes);
    return;
  }
  if (cmd === "use") {
    process.exit(use(heroes));
  }
  if (cmd === "install") {
    const r = launchd.install({
      label: LABEL,
      args: [`${ROOT}/scripts/desk-terminals.mjs`, "open", "--host", "local"],
      cwd: ROOT,
      intervalSec: REOPEN_SEC,
      logDir: LOG_DIR,
      runAtLoad: true,
      env: { GOTCHIBOT_ON_IMAC: "1" },
    });
    console.log(`${r.changed ? "wrote" : "kept"} ${r.path} (node ${r.node})`);
    console.log(`loaded ${LABEL}: re-opens driven desks at login / every ${REOPEN_SEC}s (workers stay ephemeral)`);
    return;
  }
  if (cmd === "uninstall") {
    launchd.uninstall(LABEL);
    console.log(`removed ${LABEL} (tool windows and Terminals left as they are)`);
    return;
  }
  console.error(
    "usage: desk-terminals.mjs status|open|close|use|install|uninstall [hero…] [-- <cmd…>] [--host imac|local] [--dry-run]",
  );
  process.exit(2);
}

main().catch((e) => {
  console.error(`[desk-terminals] ${e.message || e}`);
  process.exit(1);
});
