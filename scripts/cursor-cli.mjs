#!/usr/bin/env node
/**
 * Cursor CLI bridge — gotchi talks on Hy3 / Nemotron 3; Cursor Agent executes hard logic.
 *
 * usage:
 *   cursor-cli.mjs run "prompt" [--cwd path] [--mode plan|ask] [--model id] [--new-chat] [--json] [--force]
 *                  [--no-watch] [--show] [--wait-ms N] [--dry-run]
 *   cursor-cli.mjs wait [runId]             # keep following a run whose caller timed out
 *   cursor-cli.mjs watch [runId] [--hub]    # attach to the live terminal of a run (tmux)
 *   cursor-cli.mjs resume [chatId] "follow-up prompt"
 *   cursor-cli.mjs launch "prompt"          # interactive Cursor Agent (TTY)
 *   cursor-cli.mjs create [--label text]
 *   cursor-cli.mjs context [--json]
 *   cursor-cli.mjs list
 *   cursor-cli.mjs status                   # binary path + login (no secrets)
 *
 * A headless run is a detached job (`cursor-cli.mjs job <runDir>`) in its own tmux
 * window (session `gotchibot-cursor`) running cursor-agent --print --output-format
 * stream-json. The caller follows it: progress lines on stderr as they happen, the
 * final answer on stdout. If the caller is killed (tool timeout) the job keeps going;
 * `wait` picks it back up. Each OpenCode session (OPENCODE_SESSION_ID, injected by
 * .opencode/plugins/gotchi-shell-env.js) or hero keeps its own Cursor chat.
 * Never pass --api-key. Uses the logged-in Cursor account (Pro+ on MBP or iMac).
 */
import { spawnSync, spawn } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";
import { macGuiAvailable } from "./lib/platform-guard.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = `${ROOT}/sessions`;
const STATE = `${SESSIONS}/.cursor-cli.json`;
const HANDOFF = `${SESSIONS}/HANDOFF.md`;
const PIN = `${SESSIONS}/.pin`;
const MAX_CONTEXT = Number(process.env.GOTCHIBOT_CURSOR_CONTEXT_CHARS ?? 28_000);
const HOME_BIN = join(homedir(), ".local/bin/cursor-agent");
const SELF = fileURLToPath(import.meta.url);
const JOB_SESSION = process.env.GOTCHIBOT_CURSOR_TMUX_SESSION || "gotchibot-cursor";
// Stay under the OpenCode bash tool's timeout so the caller reports "still running" instead of being killed.
const FOLLOW_MS = Number(process.env.GOTCHIBOT_CURSOR_FOLLOW_MS ?? 540_000);
const JOB_TIMEOUT_MS = Number(process.env.GOTCHIBOT_CURSOR_TIMEOUT_MS ?? 1_800_000);
const JOB_START_MS = 15_000;
const QUIET_BEAT_MS = 30_000;
const LINGER_MS = 60_000;
const RESULT_GRACE_MS = 3_000;
const MAX_SESSION_CHATS = 50;

function usage() {
  console.error(`usage:
  cursor-cli.mjs run "prompt" [--cwd path] [--mode plan|ask] [--model id] [--new-chat] [--resume id] [--json] [--force] [--dry-run]
  cursor-cli.mjs resume [chatId] "follow-up"
  cursor-cli.mjs launch "prompt" [--cwd path] [--mode plan|ask] [--resume id]
  cursor-cli.mjs create [--label text]
  cursor-cli.mjs context [--json]
  cursor-cli.mjs list
  cursor-cli.mjs status`);
  process.exit(2);
}

/** Env for the tmux server / detached job: no provider keys from the OpenCode process. */
export function jobEnv(env = process.env) {
  const keep = ["HOME", "USER", "LOGNAME", "PATH", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];
  const out = { TERM: env.TERM && env.TERM !== "dumb" ? env.TERM : "xterm-256color" };
  for (const k of keep) if (env[k]) out[k] = env[k];
  return out;
}

function childEnv() {
  const env = { ...process.env };
  delete env.CURSOR_API_KEY;
  return env;
}

function resolveCursorAgent() {
  const envBin = (process.env.CURSOR_AGENT_BIN || "").trim();
  const candidates = [envBin, HOME_BIN].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  const r = spawnSync("command", ["-v", "cursor-agent"], {
    shell: true,
    encoding: "utf8",
    env: childEnv(),
  });
  const found = (r.stdout || "").trim().split("\n")[0];
  if (found && existsSync(found) && !found.includes(".grok/bin")) return found;
  return null;
}

function requireBin() {
  const bin = resolveCursorAgent();
  if (!bin) {
    console.error(
      "cursor-agent not found. Expected $HOME/.local/bin/cursor-agent (Cursor Agent CLI).\n" +
        "Do not use ~/.grok/bin/agent (Grok TUI). Available on both MBP and iMac when Cursor is logged in.",
    );
    process.exit(1);
  }
  return bin;
}

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    return { activeChatId: null, chats: [], bySession: {} };
  }
}

/** Whose Cursor chat this is: the OpenCode session, else the hero, else the shared active chat. */
export function chatKey(env = process.env) {
  const oc = String(env.OPENCODE_SESSION_ID || "").trim();
  if (oc) return `oc:${oc}`;
  const hero = String(env.GOTCHIBOT_HERO_ID || "").trim();
  if (hero) return `hero:${hero}`;
  return null;
}

export function chatFor(state, key) {
  if (!key) return state.activeChatId || null;
  return state.bySession?.[key]?.chatId || null;
}

function saveState(state) {
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
}

function truncate(s, max) {
  const t = String(s || "").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n…[truncated ${t.length - max} chars]`;
}

function sessionField(dir, key) {
  try {
    const m = readFileSync(`${dir}/state.env`, "utf8").match(new RegExp(`^${key}=(.+)$`, "m"));
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

function recentSubSessions(limit = 3) {
  const ids = readdirSync(SESSIONS)
    .filter((n) => /^s\d{8}-\d{6}-/.test(n))
    .filter((n) => existsSync(join(SESSIONS, n, "state.env")))
    .sort()
    .reverse();
  const out = [];
  for (const id of ids) {
    if (out.length >= limit) break;
    const dir = join(SESSIONS, id);
    const status = sessionField(dir, "status");
    if (status !== "done" && status !== "running") continue;
    let output = "";
    try {
      output = readFileSync(join(dir, "output.md"), "utf8");
    } catch {}
    let prompt = "";
    try {
      prompt = readFileSync(join(dir, "prompt.txt"), "utf8");
    } catch {}
    out.push({ id, status, model: sessionField(dir, "model"), prompt, output });
  }
  return out;
}

export function buildContext(userPrompt, { extra = "" } = {}) {
  const sections = [];

  sections.push(`# GotchiBot → Cursor Agent context
Repo: ${ROOT}
Time: ${new Date().toISOString()}
Bot (OpenCode) stays on Hy3 Free / Nemotron 3 for talk and routing.
You (cursor-agent) do the coding / debugging / investigation / patches.
Do not ask UserDefault for secrets or API keys. Use the logged-in Cursor account.`);

  if (existsSync(PIN)) {
    const pin = readFileSync(PIN, "utf8").trim();
    if (pin) sections.push(`## Active pin\n${pin}`);
  }

  if (existsSync(HANDOFF)) {
    sections.push(`## Handoff (prior swarm work)\n${readFileSync(HANDOFF, "utf8")}`);
  }

  const subs = recentSubSessions(3);
  if (subs.length) {
    const lines = subs.map((s) => {
      const body = truncate(s.output || s.prompt, 2500);
      return `### ${s.id} (${s.status})\n${body}`;
    });
    sections.push(`## Recent sub-agent sessions\n${lines.join("\n\n")}`);
  }

  if (extra.trim()) {
    sections.push(`## Orchestrator notes\n${extra.trim()}`);
  }

  sections.push(`## User prompt\n${userPrompt.trim()}`);

  let bundle = sections.join("\n\n");
  if (bundle.length > MAX_CONTEXT) {
    bundle = truncate(bundle, MAX_CONTEXT);
  }
  return bundle;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** On Linux `create-chat` prints the id and then never exits: take the id and stop it. */
function cursorCreateChat(bin, cwd, timeoutMs = 30_000) {
  return new Promise((resolveId, reject) => {
    const child = spawn(bin, ["create-chat"], { cwd, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      fn(value);
    };
    const timer = setTimeout(() => settle(reject, new Error("cursor-agent create-chat timed out")), timeoutMs);
    child.stdout.on("data", (d) => {
      out += d;
      const m = out.match(UUID_RE);
      if (m) settle(resolveId, m[0]);
    });
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) =>
      settle(reject, new Error((err || out).trim() || `cursor-agent create-chat exited ${code} without a chat id`)),
    );
  });
}

export function rememberChat(state, id, label, key = null, { save = saveState } = {}) {
  const now = new Date().toISOString();
  const chats = (state.chats || []).filter((c) => c.id !== id);
  chats.unshift({ id, label: truncate(label, 120), createdAt: now, lastUsed: now });
  state.chats = chats.slice(0, 20);
  if (key) {
    const entries = Object.entries({ ...(state.bySession || {}), [key]: { chatId: id, lastUsed: now } });
    entries.sort((a, b) => String(b[1].lastUsed).localeCompare(String(a[1].lastUsed)));
    state.bySession = Object.fromEntries(entries.slice(0, MAX_SESSION_CHATS));
  } else {
    state.activeChatId = id;
  }
  save(state);
}

function makeRunDir() {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const id = `c${stamp}-${Math.random().toString(36).slice(2, 6)}`;
  const dir = join(SESSIONS, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "state.env"),
    `status=running\nstarted=${new Date().toISOString()}\nprovider=cursor-cli\n`,
  );
  return dir;
}

function finishRunDir(dir, ok, output) {
  const status = ok ? "done" : "failed";
  writeFileSync(join(dir, "output.md"), output || "");
  const base = readFileSync(join(dir, "state.env"), "utf8");
  writeFileSync(
    join(dir, "state.env"),
    `${base.replace(/^status=.*$/m, `status=${status}`)}ended=${new Date().toISOString()}\n`,
  );
  return dir.split("/").pop();
}

function readStdin() {
  if (process.stdin.isTTY) return "";
  try {
    return readFileSync(0, "utf8").trim();
  } catch {
    return "";
  }
}

function parseRunArgs(argv) {
  const opts = {
    mode: null,
    model: null,
    newChat: false,
    resume: null,
    json: false,
    extra: "",
    cwd: ROOT,
    force: false,
    dryRun: false,
    watch: process.env.GOTCHIBOT_CURSOR_WATCH !== "0",
    show: process.env.GOTCHIBOT_CURSOR_SHOW === "1",
    waitMs: FOLLOW_MS,
  };
  const parts = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--api-key" || a.startsWith("--api-key=")) {
      console.error("never pass --api-key; cursor-agent uses the logged-in Cursor account");
      process.exit(2);
    } else if (a === "--mode" && argv[i + 1]) opts.mode = argv[++i];
    else if (a === "--model" && argv[i + 1]) opts.model = argv[++i];
    else if ((a === "--cwd" || a === "--workspace") && argv[i + 1]) opts.cwd = resolve(argv[++i]);
    else if (a === "--new-chat") opts.newChat = true;
    else if (a === "--resume" && argv[i + 1]) opts.resume = argv[++i];
    else if (a === "--json") opts.json = true;
    else if (a === "--force" || a === "--yolo") opts.force = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--no-watch") opts.watch = false;
    else if (a === "--show") opts.show = true;
    else if (a === "--wait-ms" && argv[i + 1]) opts.waitMs = Math.max(0, Number(argv[++i]) || 0);
    else if (a === "--extra" && argv[i + 1]) opts.extra = argv[++i];
    else if (a.startsWith("--")) continue;
    else parts.push(a);
  }
  const prompt = parts.join(" ").trim() || readStdin();
  return { prompt, opts };
}

export function cursorArgs(opts, chatId, promptText) {
  const args = ["--workspace", opts.cwd || ROOT, "--trust"];
  if (!opts.interactive) {
    args.push("--print", "--output-format", "stream-json", "--stream-partial-output");
  }
  if (opts.mode) args.push("--mode", opts.mode);
  if (opts.model) args.push("--model", opts.model);
  if (opts.force) args.push("--force");
  if (chatId) args.push("--resume", chatId);
  args.push(promptText);
  return args;
}

function cmdContext(argv) {
  const { prompt } = parseRunArgs(argv.length ? argv : ["(preview)"]);
  const bundle = buildContext(prompt || "(preview)");
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ chars: bundle.length, context: bundle }, null, 2));
  } else {
    console.log(bundle);
  }
}

function cmdList() {
  const state = loadState();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  console.log(`active: ${state.activeChatId ?? "(none)"}`);
  for (const c of state.chats) {
    console.log(`  ${c.id}  ${c.label}`);
  }
}

function cmdStatus() {
  const bin = requireBin();
  const r = spawnSync(bin, ["status"], {
    encoding: "utf8",
    cwd: ROOT,
    env: childEnv(),
  });
  const about = spawnSync(bin, ["about"], {
    encoding: "utf8",
    cwd: ROOT,
    env: childEnv(),
  });
  const statusOut = (r.stdout || r.stderr || "").trim();
  const aboutOut = (about.stdout || about.stderr || "").trim();
  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          bin,
          homeBin: HOME_BIN,
          loggedIn: /logged in/i.test(statusOut) && !/keychain is locked/i.test(statusOut),
          status: statusOut,
          about: aboutOut,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`bin: ${bin}`);
    if (statusOut) console.log(statusOut);
    if (aboutOut && aboutOut !== statusOut) console.log(aboutOut);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);
}

async function cmdCreate(argv) {
  const bin = requireBin();
  const labelIdx = argv.indexOf("--label");
  const label = labelIdx >= 0 ? argv[labelIdx + 1] : "gotchibot cursor chat";
  const id = await cursorCreateChat(bin, ROOT);
  const state = loadState();
  rememberChat(state, id, label);
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ ok: true, chatId: id }, null, 2));
  } else {
    console.log(id);
  }
}

async function cmdRun(argv, { interactive = false } = {}) {
  const bin = requireBin();
  const { prompt, opts } = parseRunArgs(argv);
  if (!prompt) usage();

  const state = loadState();
  const key = chatKey();
  let chatId = opts.resume || (opts.newChat ? null : chatFor(state, key));
  if (!opts.dryRun) {
    if (opts.newChat || !chatId) chatId = await cursorCreateChat(bin, opts.cwd);
    rememberChat(state, chatId, prompt, key);
  }

  const bundle = buildContext(prompt, { extra: opts.extra });
  const args = cursorArgs({ ...opts, interactive }, chatId, bundle);

  if (opts.dryRun) {
    const shown = args.map((a, i) => (i === args.length - 1 ? `<prompt ${bundle.length} chars>` : a));
    const result = {
      bin,
      print: !interactive,
      workspace: opts.cwd,
      chatId: chatId || null,
      args: shown,
    };
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const runDir = interactive ? null : makeRunDir();
  if (runDir) writeFileSync(join(runDir, "prompt.txt"), bundle);
  else writeFileSync(join(SESSIONS, ".cursor-last-prompt.txt"), bundle);

  if (interactive) {
    if (!process.stdout.isTTY) {
      console.error("launch requires a TTY — use: cursor-cli.mjs run \"…\" for headless");
      process.exit(1);
    }
    const child = spawn(bin, args, { cwd: opts.cwd, stdio: "inherit", env: childEnv() });
    child.on("exit", (code) => process.exit(code ?? 0));
    return;
  }

  const runId = runDir.split("/").pop();
  writeFileSync(
    join(runDir, "job.json"),
    `${JSON.stringify({ bin, args: args.slice(0, -1), cwd: opts.cwd, chatId, timeoutMs: JOB_TIMEOUT_MS }, null, 2)}\n`,
  );
  const inTmux = opts.watch && startJobTmux(runDir, runId, opts.cwd);
  if (!inTmux) startJobDetached(runDir, opts.cwd);
  if (inTmux && opts.show) showJobTerminal(runId);
  console.error(
    `cursor session ${runId} · chat ${chatId}` +
      (inTmux ? ` · live terminal: ./scripts/cursor-cli.mjs watch ${runId}` : ""),
  );
  await finishFollow(runDir, { chatId, json: opts.json, waitMs: opts.waitMs });
}

// --- detached job --------------------------------------------------------------------

function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function whichBin(name, extra = []) {
  for (const p of extra) if (p && existsSync(p)) return p;
  const r = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
  const found = (r.stdout || "").trim().split("\n")[0];
  return found && existsSync(found) ? found : null;
}

function tmuxBin() {
  return whichBin("tmux", [process.env.TMUX_BIN, "/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"]);
}

/**
 * Start the job in a window of the `gotchibot-cursor` tmux session. Under a systemd
 * service (the Hub's OpenCode server) a new tmux server gets its own scope, so
 * restarting that service does not kill running jobs.
 */
function startJobTmux(runDir, runId, cwd) {
  const tmux = tmuxBin();
  if (!tmux) return false;
  const env = jobEnv();
  const jobCmd = [process.execPath, SELF, "job", runDir].map(shq).join(" ");
  const has = spawnSync(tmux, ["has-session", "-t", `=${JOB_SESSION}`], { env }).status === 0;
  const tmuxArgs = has
    ? ["new-window", "-d", "-t", `=${JOB_SESSION}`, "-n", runId, "-c", cwd, jobCmd]
    : ["new-session", "-d", "-s", JOB_SESSION, "-n", runId, "-x", "200", "-y", "50", "-c", cwd, jobCmd];
  const systemdRun =
    !has && process.platform === "linux" && (process.env.INVOCATION_ID || process.env.JOURNAL_STREAM)
      ? whichBin("systemd-run")
      : null;
  if (systemdRun) {
    const r = spawnSync(systemdRun, ["--user", "--scope", "--quiet", "--collect", tmux, ...tmuxArgs], { env });
    if (r.status === 0) return true;
  }
  return spawnSync(tmux, tmuxArgs, { env }).status === 0;
}

function startJobDetached(runDir, cwd) {
  spawn(process.execPath, [SELF, "job", runDir], { cwd, env: jobEnv(), detached: true, stdio: "ignore" }).unref();
}

function showJobTerminal(runId) {
  if (!macGuiAvailable()) return;
  spawnSync(
    join(ROOT, "scripts/agent-desktop-terminal.sh"),
    ["--session", JOB_SESSION, "--window", runId, "--title", `Cursor · ${runId}`],
    { stdio: "ignore", timeout: 45_000 },
  );
}

/** One progress line for a stream-json tool call: `edit scripts/x.mjs`, `shell npm test`. */
export function toolSummary(toolCall, cwd = "") {
  const key = Object.keys(toolCall || {}).find((k) => k.endsWith("ToolCall"));
  if (!key) return "tool";
  const name = key.replace(/ToolCall$/, "");
  const args = toolCall[key]?.args || {};
  const pick = ["command", "path", "filePath", "targetFile", "globPattern", "pattern", "query", "url", "targetDirectory"]
    .map((k) => args[k])
    .find((v) => typeof v === "string" && v);
  if (!pick) return name;
  let shown = pick.replace(/\s+/g, " ").trim();
  if (cwd && shown.startsWith(`${cwd}/`)) shown = shown.slice(cwd.length + 1);
  return `${name} ${shown.length > 100 ? `${shown.slice(0, 99)}…` : shown}`;
}

/** Fold one stream-json event into the run: progress lines out, reply text accumulated. */
export function applyStreamEvent(run, ev, cwd = "") {
  if (ev?.type === "tool_call" && ev.subtype === "started") {
    return { progress: `· ${toolSummary(ev.tool_call, cwd)}` };
  }
  if (ev?.type === "assistant" && ev.timestamp_ms != null) {
    const text = (ev.message?.content || []).filter((c) => c?.type === "text").map((c) => c.text || "").join("");
    const first = !run.live;
    run.live += text;
    return { text, progress: first && text ? "· writing the reply" : null };
  }
  if (ev?.type === "result") {
    run.final = typeof ev.result === "string" ? ev.result : run.final;
    run.isError = Boolean(ev.is_error);
  }
  return {};
}

async function cmdJob(runDir) {
  const job = JSON.parse(readFileSync(join(runDir, "job.json"), "utf8"));
  const prompt = readFileSync(join(runDir, "prompt.txt"), "utf8");
  const runId = runDir.split("/").pop();
  writeFileSync(join(runDir, "job.pid"), `${process.pid}\n`);
  const tty = process.stdout.isTTY;
  const dim = (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
  const red = (s) => (tty ? `\x1b[31m${s}\x1b[0m` : s);
  const progressLog = join(runDir, "progress.log");
  const run = { live: "", final: null, isError: false };
  let midText = false;
  let lastProgress = Date.now();
  const started = Date.now();
  const progress = (line) => {
    appendFileSync(progressLog, `${line}\n`);
    process.stdout.write(`${midText ? "\n" : ""}${dim(line)}\n`);
    midText = false;
    lastProgress = Date.now();
  };

  process.stdout.write(`${dim(`GotchiBot → cursor-agent · ${runId} · chat ${job.chatId}`)}\n\n`);
  const child = spawn(job.bin, [...job.args, prompt], { cwd: job.cwd, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, job.timeoutMs || JOB_TIMEOUT_MS);
  const beat = setInterval(() => {
    if (Date.now() - lastProgress >= QUIET_BEAT_MS) {
      progress(`· still working (${Math.round((Date.now() - started) / 60_000)}m)`);
    }
  }, 5_000);

  let err = "";
  child.stderr.on("data", (d) => {
    err += d;
    process.stdout.write(red(String(d)));
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      run.live += `${line}\n`;
      return;
    }
    const out = applyStreamEvent(run, ev, job.cwd);
    // Like create-chat, cursor-agent may linger after its result on Linux.
    if (ev?.type === "result") setTimeout(() => child.kill("SIGTERM"), RESULT_GRACE_MS).unref();
    if (out.progress) progress(out.progress);
    if (out.text) {
      process.stdout.write(out.text);
      midText = true;
      lastProgress = Date.now();
    }
  });

  const code = await new Promise((done) => child.on("close", (c) => done(c ?? 1)));
  clearTimeout(killer);
  clearInterval(beat);
  const text =
    (run.final ?? run.live).trim() || err.trim() || (timedOut ? `cursor-agent timed out after ${job.timeoutMs}ms` : "");
  const ok = !timedOut && (run.final != null ? !run.isError : code === 0);
  finishRunDir(runDir, ok, text);
  appendFileSync(join(runDir, "state.env"), `exit=${code}\n`);
  process.stdout.write(`\n\n${dim(`— ${ok ? "done" : "failed"} · ${runId}${process.env.TMUX ? ` · closes in ${LINGER_MS / 1000}s` : ""} —`)}\n`);
  if (process.env.TMUX) await new Promise((r) => setTimeout(r, LINGER_MS));
  process.exit(ok ? 0 : 1);
}

function jobAlive(runDir) {
  let pid;
  try {
    pid = Number(readFileSync(join(runDir, "job.pid"), "utf8").trim());
  } catch {
    return null;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

/**
 * Stream a run's progress lines to `out` until it finishes or `waitMs` passes.
 * @returns {Promise<{ done: boolean, ok?: boolean, output?: string }>}
 */
export async function followRun(runDir, { waitMs = FOLLOW_MS, out = process.stderr, pollMs = 500, startMs = JOB_START_MS } = {}) {
  const progressLog = join(runDir, "progress.log");
  let pos = 0;
  const t0 = Date.now();
  const flush = () => {
    let text = "";
    try {
      text = readFileSync(progressLog, "utf8");
    } catch {
      return;
    }
    if (text.length > pos) {
      out.write(text.slice(pos));
      pos = text.length;
    }
  };
  const result = () => {
    let output = "";
    try {
      output = readFileSync(join(runDir, "output.md"), "utf8").trim();
    } catch {}
    return { done: true, ok: sessionField(runDir, "status") === "done", output };
  };
  for (;;) {
    flush();
    if (sessionField(runDir, "status") !== "running") return (flush(), result());
    const alive = jobAlive(runDir);
    if (alive === false || (alive === null && Date.now() - t0 > startMs)) {
      if (sessionField(runDir, "status") === "running") {
        finishRunDir(runDir, false, alive === false ? "cursor job exited without a result" : "cursor job never started");
      }
      return (flush(), result());
    }
    if (Date.now() - t0 >= waitMs) return { done: false };
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

async function finishFollow(runDir, { chatId = null, json = false, waitMs = FOLLOW_MS } = {}) {
  const runId = runDir.split("/").pop();
  const r = await followRun(runDir, { waitMs });
  if (!r.done) {
    const msg =
      `STILL RUNNING: cursor-agent is still working on ${runId} in the background. ` +
      `Do not start it again. Continue with: ./scripts/cursor-cli.mjs wait ${runId}`;
    if (json) console.log(JSON.stringify({ ok: null, running: true, chatId, sessionId: runId, output: msg }, null, 2));
    else console.log(msg);
    return;
  }
  if (json) {
    console.log(JSON.stringify({ ok: r.ok, chatId, sessionId: runId, output: r.output }, null, 2));
  } else {
    if (r.output) console.log(r.output);
    console.error(`\ncursor session: ${runId}  chat: ${chatId}`);
  }
  if (!r.ok) process.exit(1);
}

function latestRunDir(filter = () => true) {
  const ids = readdirSync(SESSIONS)
    .filter((n) => /^c\d{14}/.test(n) && existsSync(join(SESSIONS, n, "job.json")))
    .sort()
    .reverse();
  const id = ids.find((n) => filter(join(SESSIONS, n)));
  return id ? join(SESSIONS, id) : null;
}

function runDirArg(argv, filter) {
  const id = argv.find((a) => /^c\d{14}/.test(a));
  if (id) return existsSync(join(SESSIONS, id, "job.json")) ? join(SESSIONS, id) : null;
  return latestRunDir(filter);
}

async function cmdWait(argv) {
  const runDir = runDirArg(argv, (d) => sessionField(d, "status") === "running") || runDirArg(argv);
  if (!runDir) {
    console.error("no cursor run found — pass the run id (c…) from the run output");
    process.exit(1);
  }
  let chatId = null;
  try {
    chatId = JSON.parse(readFileSync(join(runDir, "job.json"), "utf8")).chatId;
  } catch {}
  const waitIdx = argv.indexOf("--wait-ms");
  const waitMs = waitIdx >= 0 ? Math.max(0, Number(argv[waitIdx + 1]) || 0) : FOLLOW_MS;
  await finishFollow(runDir, { chatId, json: argv.includes("--json"), waitMs });
}

function hubSshTarget() {
  try {
    return JSON.parse(readFileSync(join(SESSIONS, ".hub-desk.json"), "utf8")).ssh || null;
  } catch {
    return null;
  }
}

async function cmdWatch(argv) {
  const id = argv.find((a) => /^c\d{14}/.test(a)) || null;
  const target = id ? `${JOB_SESSION}:${id}` : JOB_SESSION;
  if (argv.includes("--hub")) {
    const ssh = hubSshTarget();
    if (!ssh) {
      console.error("no Hub SSH target — gotchibot hub desk ssh <user>@<hub-host>");
      process.exit(1);
    }
    const remote = `tmux attach -t ${shq(target)} || echo "no live cursor runs on the Hub"`;
    process.exit(spawnSync("ssh", ["-t", ssh, remote], { stdio: "inherit" }).status ?? 1);
  }
  const tmux = tmuxBin();
  if (tmux && spawnSync(tmux, ["has-session", "-t", `=${JOB_SESSION}`]).status === 0 && process.stdout.isTTY) {
    process.exit(spawnSync(tmux, ["attach", "-t", target], { stdio: "inherit" }).status ?? 1);
  }
  const runDir = runDirArg(argv);
  if (!runDir) {
    console.error("no cursor run to watch");
    process.exit(1);
  }
  await finishFollow(runDir, { waitMs: Number.MAX_SAFE_INTEGER });
}

if (isMainModule(import.meta.url)) {
  const cmd = process.argv[2];
  const rest = process.argv.slice(3);

  switch (cmd) {
    case "run":
      await cmdRun(rest);
      break;
    case "launch":
      await cmdRun(rest, { interactive: true });
      break;
    case "job":
      await cmdJob(resolve(rest[0] || ""));
      break;
    case "wait":
      await cmdWait(rest);
      break;
    case "watch":
      await cmdWatch(rest);
      break;
    case "resume": {
      const state = loadState();
      let chatId = null;
      const passthrough = [];
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === "--api-key" || a.startsWith("--api-key=")) {
          console.error("never pass --api-key; cursor-agent uses the logged-in Cursor account");
          process.exit(2);
        }
        if (!chatId && !a.startsWith("--") && /^[0-9a-f-]{36}$/i.test(a)) {
          chatId = a;
          continue;
        }
        passthrough.push(a);
      }
      chatId = chatId || chatFor(state, chatKey()) || state.activeChatId;
      if (!chatId) {
        console.error("no chat id — run create first or pass uuid");
        process.exit(1);
      }
      await cmdRun(["--resume", chatId, ...passthrough]);
      break;
    }
    case "create":
      await cmdCreate(rest);
      break;
    case "context":
      cmdContext(rest);
      break;
    case "list":
      cmdList();
      break;
    case "status":
      cmdStatus();
      break;
    default:
      usage();
  }
}
