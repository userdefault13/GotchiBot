/**
 * One snapshot of the active gotchi and that gotchi's workflow.
 *
 * Hero comes from sessions/.focus.json. Workflow comes from the Factory
 * board (kanban card, running op, job stage) and then the hero's task.
 * Panes read sessions/.desk-active.json and the one-line sessions/.desk-active.line.
 * They do not keep their own copy of who is active.
 *
 *   node scripts/desk-active.mjs publish [--force]
 *   node scripts/desk-active.mjs line
 *   node scripts/desk-active.mjs show
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = join(ROOT, "sessions");
const ACTIVE = join(SESSIONS, ".desk-active.json");
const LINE = join(SESSIONS, ".desk-active.line");
const FOCUS = join(SESSIONS, ".focus.json");
const PIN = join(SESSIONS, ".pin");
const HERO_STATE = join(SESSIONS, ".hero-agent-state.json");
const LOCK = join(SESSIONS, ".desk-active.lock");
const STALE_MS = 2000;

const WATCHERS = [
  "avatar-pane.sh",
  "factory-window.mjs",
  "pstack-window.mjs",
  "label-bar-pane.sh",
  "inbox-pane.sh",
  "chat-bar-pane.sh",
  "sidebar-pane.sh",
  "meet-room-prompter.mjs",
];

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readText(path) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

function ageMs() {
  try {
    return Date.now() - statSync(LINE).mtimeMs;
  } catch {
    return Infinity;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function oneLine(s, max = 36) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Safe inside a tmux pane-border-format (no format tokens). */
function tmuxSafe(s) {
  return String(s || "")
    .replace(/[\r\n\t#{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sessionName() {
  return String(process.env.GOTCHIBOT_TMUX_SESSION || "gotchibot").replace(/^=/, "");
}

function shortName(heroId, name) {
  const n = String(name || "").trim();
  if (n && n.length <= 18) return n;
  const m = String(heroId || "").match(/(\d+)$/);
  if (m) return m[1];
  return String(heroId || "gotchi").slice(0, 12);
}

function nameFor(heroId) {
  const names = readJson(join(SESSIONS, ".gotchi-names.json"))?.names || {};
  const m = /^(?:owned|rental)-(\d+)$/.exec(String(heroId || ""));
  return m ? names[m[1]]?.name || null : null;
}

function heroTask(heroId) {
  const row = readJson(HERO_STATE)?.[heroId];
  const task = String(row?.task || "").trim();
  // Synthetic desk labels, not a workflow step.
  if (
    !task ||
    /^focused via \//i.test(task) ||
    /^opencode gotchi \(/i.test(task) ||
    /^opencode gotchi on /i.test(task)
  ) {
    return { task: "", status: row?.status || null };
  }
  return { task, status: row?.status || null };
}

function roleFor(heroId) {
  const roles = readJson(join(ROOT, "config/agent-roles.json")) || {};
  return roles[heroId] || null;
}

/**
 * focus.json wins. Pin is repaired to match so the avatar cannot drift.
 * A missing focus hero is filled from the pin, then from identity meta.
 */
function resolveHero() {
  const focus = readJson(FOCUS) || {};
  const pin = readText(PIN);
  const metaHero = String(readJson(join(SESSIONS, ".identity.json"))?.activeHeroId || "");

  const heroId = String(focus.heroId || pin || metaHero || "").trim() || null;
  const mode = focus.mode === "sub" ? "sub" : "orch";

  if (heroId && !focus.heroId) {
    mkdirSync(SESSIONS, { recursive: true });
    writeFileSync(
      FOCUS,
      `${JSON.stringify({ ...focus, heroId, mode, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  }
  if (heroId && pin !== heroId) {
    mkdirSync(SESSIONS, { recursive: true });
    writeFileSync(PIN, `${heroId}\n`);
  }
  return { heroId, mode, sessionId: focus.sessionId || null };
}

function workflowOf(bot, task) {
  if (bot?.focus?.title) {
    const col = bot.focus.column || "doing";
    return { workflow: `${col}: ${oneLine(bot.focus.title)}`, column: bot.focus.column || null };
  }
  const op = bot?.op;
  if (op && typeof op === "object") {
    const label = op.title || op.name || op.task || op.op || op.id || "";
    if (label) return { workflow: `op: ${oneLine(label)}`, column: null };
  }
  if (bot?.jobStage) {
    return {
      workflow: `job: ${bot.jobStage}${bot.jobLimbo ? " (limbo)" : ""}`,
      column: null,
    };
  }
  if (task) return { workflow: oneLine(task, 42), column: null };
  if (bot?.state && bot.state !== "idle") return { workflow: bot.state, column: null };
  return { workflow: "idle", column: null };
}

async function compute() {
  const { heroId, mode, sessionId } = resolveHero();
  const { task, status } = heroId ? heroTask(heroId) : { task: "", status: null };
  let project = null;
  let bot = null;
  if (heroId) {
    try {
      const { buildFactory } = await import("./factory-window.mjs");
      const factory = buildFactory();
      project = factory?.slug || null;
      bot = (factory?.bots || []).find((b) => b.id === heroId) || null;
    } catch {
      bot = null;
    }
  }
  const flow = workflowOf(bot, task);
  const name = bot?.name || (heroId ? nameFor(heroId) : null);
  const role = bot?.role || (heroId ? roleFor(heroId) : null);
  const workflow = tmuxSafe(flow.workflow) || "idle";
  const line = heroId ? tmuxSafe(`${shortName(heroId, name)} · ${workflow}`).slice(0, 48) : "";
  return {
    heroId,
    mode,
    sessionId,
    name: name || null,
    role: role || null,
    project,
    status: bot?.state || status || null,
    column: flow.column,
    workflow,
    line,
    updatedAt: new Date().toISOString(),
  };
}

function readSnap() {
  return (
    readJson(ACTIVE) || {
      heroId: null,
      mode: "orch",
      name: null,
      role: null,
      project: null,
      status: null,
      column: null,
      workflow: "idle",
      line: "",
      updatedAt: null,
    }
  );
}

function same(a, b) {
  const strip = (o) => {
    const { updatedAt: _u, ...rest } = o || {};
    return JSON.stringify(rest);
  };
  return strip(a) === strip(b);
}

function writeSnap(snap) {
  mkdirSync(SESSIONS, { recursive: true });
  const json = `${JSON.stringify(snap, null, 2)}\n`;
  const tmp = `${ACTIVE}.${process.pid}.tmp`;
  writeFileSync(tmp, json);
  renameSync(tmp, ACTIVE);
  writeFileSync(LINE, snap.line ? `${snap.line}\n` : "\n");
}

function clearStaleLock() {
  try {
    const st = statSync(LOCK);
    if (Date.now() - st.mtimeMs > 5000) unlinkSync(LOCK);
  } catch {
    /* no lock */
  }
}

async function withLock(fn) {
  clearStaleLock();
  for (let i = 0; i < 40; i++) {
    try {
      writeFileSync(LOCK, String(process.pid), { flag: "wx" });
      try {
        return await fn();
      } finally {
        try {
          unlinkSync(LOCK);
        } catch {
          /* ok */
        }
      }
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
      await sleep(40);
    }
  }
  return readSnap();
}

function tmuxOk(sess) {
  return spawnSync("tmux", ["has-session", "-t", `=${sess}`], { stdio: "ignore" }).status === 0;
}

function layoutMode() {
  return readText(join(SESSIONS, ".layout-mode")) || "normal";
}

function centerLabel(sess) {
  const r = spawnSync("tmux", ["show-options", "-qv", "-t", sess, "@gotchibot-center-app"], {
    encoding: "utf8",
  });
  return String(r.stdout || "").trim() === "factory" ? "Factory" : "pstack · dossier";
}

export function kindLabel(cmd, mode, sess) {
  const c = String(cmd || "");
  if (c.includes("sidebar-pane") || c.includes("mc-pane")) {
    return mode === "files-max" ? "Files · full" : "Files";
  }
  if (c.includes("avatar-pane")) return mode === "avatar-max" ? "Avatar · full" : "Avatar";
  if (c.includes("cockpit-pane") || c.includes("label-bar-pane.sh Cockpit")) return "Cockpit";
  if (c.includes("chat-pane") || c.includes("chat-bar-pane")) {
    return mode === "chat-max" ? "Gotchi · full" : "Gotchi";
  }
  if (c.includes("factory-window") || c.includes("label-bar-pane.sh Factory")) return "Factory";
  if (c.includes("pstack-window") || c.includes("pstack-pane") || c.includes("label-bar-pane.sh Dossier")) {
    return mode === "pstack-dossier" ? centerLabel(sess) : "Dossier";
  }
  if (c.includes("inbox-pane") || c.includes("label-bar-pane.sh Inbox")) return "Inbox";
  if (c.includes("meet-room")) return "Meet · room";
  if (c.includes("meet-channel") || c.includes("label-bar-pane.sh Meeting")) {
    return c.includes("meet-channel") ? "# meet" : "Meeting";
  }
  return null;
}

function applyBorders(snap) {
  const sess = sessionName();
  if (!tmuxOk(sess)) return;
  const mode = layoutMode();
  const line = tmuxSafe(snap?.line || "");
  const suffix = line ? ` · ${line}` : "";
  const r = spawnSync(
    "tmux",
    ["list-panes", "-t", `${sess}:work`, "-F", "#{pane_index} #{pane_start_command}"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return;
  for (const row of String(r.stdout || "").split("\n")) {
    if (!row.trim()) continue;
    const space = row.indexOf(" ");
    if (space < 1) continue;
    const idx = row.slice(0, space);
    const cmd = row.slice(space + 1);
    if (!/^\d+$/.test(idx)) continue;
    const label = kindLabel(cmd, mode, sess);
    if (!label) continue;
    const fmt = ` #{?pane_active,●, }${label}${suffix} `;
    spawnSync("tmux", ["set-option", "-p", "-t", `${sess}:work.${idx}`, "pane-border-format", fmt], {
      stdio: "ignore",
    });
  }
}

function signalWatchers() {
  const sess = sessionName();
  if (!tmuxOk(sess)) return;
  const r = spawnSync(
    "tmux",
    ["list-panes", "-t", `${sess}:work`, "-F", "#{pane_pid} #{pane_start_command}"],
    { encoding: "utf8" },
  );
  for (const row of String(r.stdout || "").split("\n")) {
    if (!row) continue;
    const space = row.indexOf(" ");
    if (space < 1) continue;
    const pid = row.slice(0, space);
    const cmd = row.slice(space + 1);
    if (!/^\d+$/.test(pid)) continue;
    if (!WATCHERS.some((p) => cmd.includes(p))) continue;
    try {
      process.kill(Number(pid), "SIGUSR1");
    } catch {
      /* pane already gone */
    }
  }
}

export async function publish({ force = false } = {}) {
  if (!force && ageMs() < STALE_MS && existsSync(ACTIVE)) return readSnap();
  return withLock(async () => {
    if (!force && ageMs() < STALE_MS && existsSync(ACTIVE)) return readSnap();
    const snap = await compute();
    const prev = readSnap();
    const changed = !same(prev, snap);
    if (changed || !existsSync(LINE)) writeSnap({ ...snap, updatedAt: new Date().toISOString() });
    if (changed || force) applyBorders(changed ? snap : { ...prev, line: prev.line || snap.line });
    if (changed) signalWatchers();
    return changed ? snap : prev.line ? prev : snap;
  });
}

async function main() {
  const cmd = process.argv[2] || "show";
  const force = process.argv.includes("--force");
  if (cmd === "publish" || cmd === "line") {
    const snap = await publish({ force: cmd === "publish" && force });
    if (cmd === "line") process.stdout.write(snap?.line ? `${snap.line}\n` : "\n");
    else process.stdout.write(`${JSON.stringify(snap)}\n`);
    return;
  }
  if (cmd === "show") {
    const snap = existsSync(ACTIVE) ? readSnap() : await publish({ force: true });
    process.stdout.write(`${JSON.stringify(snap, null, 2)}\n`);
    return;
  }
  process.stderr.write("usage: desk-active.mjs publish [--force] | line | show\n");
  process.exit(2);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`${e?.message || e}\n`);
    process.exit(1);
  });
}
