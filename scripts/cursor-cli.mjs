#!/usr/bin/env node
/**
 * Cursor CLI bridge — gotchi talks on Hy3 / Nemotron 3; Cursor Agent executes hard logic.
 *
 * usage:
 *   cursor-cli.mjs run "prompt" [--cwd path] [--mode plan|ask] [--model id] [--new-chat] [--json] [--force] [--dry-run]
 *   cursor-cli.mjs resume [chatId] "follow-up prompt"
 *   cursor-cli.mjs launch "prompt"          # interactive Cursor Agent (TTY)
 *   cursor-cli.mjs create [--label text]
 *   cursor-cli.mjs context [--json]
 *   cursor-cli.mjs list
 *   cursor-cli.mjs status                   # binary path + login (no secrets)
 *
 * Headless run always invokes: cursor-agent --print --output-format text
 * Never pass --api-key. Uses the logged-in Cursor account (Pro+ on MBP or iMac).
 */
import { spawnSync, spawn } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = `${ROOT}/sessions`;
const STATE = `${SESSIONS}/.cursor-cli.json`;
const HANDOFF = `${SESSIONS}/HANDOFF.md`;
const PIN = `${SESSIONS}/.pin`;
const MAX_CONTEXT = Number(process.env.GOTCHIBOT_CURSOR_CONTEXT_CHARS ?? 28_000);
const HOME_BIN = join(homedir(), ".local/bin/cursor-agent");

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
    return { activeChatId: null, chats: [] };
  }
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
Do not ask Julius for secrets or API keys. Use the logged-in Cursor account.`);

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

function cursorCreateChat(bin, cwd) {
  const r = spawnSync(bin, ["create-chat"], {
    encoding: "utf8",
    cwd,
    env: childEnv(),
  });
  if (r.status !== 0) {
    throw new Error(r.stderr || r.stdout || "cursor-agent create-chat failed");
  }
  const id = (r.stdout || "").trim();
  if (!id) throw new Error("empty chat id from cursor-agent create-chat");
  return id;
}

function rememberChat(state, id, label) {
  const now = new Date().toISOString();
  const chats = state.chats.filter((c) => c.id !== id);
  chats.unshift({ id, label: truncate(label, 120), createdAt: now, lastUsed: now });
  state.chats = chats.slice(0, 20);
  state.activeChatId = id;
  saveState(state);
}

function makeRunDir() {
  const id = `c${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
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
    outputFormat: "text",
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
    else if (a === "--output-format" && argv[i + 1]) opts.outputFormat = argv[++i];
    else if (a === "--extra" && argv[i + 1]) opts.extra = argv[++i];
    else if (a.startsWith("--")) continue;
    else parts.push(a);
  }
  const prompt = parts.join(" ").trim() || readStdin();
  return { prompt, opts };
}

function cursorArgs(opts, chatId, promptText) {
  const args = ["--workspace", opts.cwd || ROOT, "--trust"];
  if (opts.interactive) {
    // no --print
  } else {
    args.push("--print", "--output-format", opts.outputFormat || "text");
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

function cmdCreate(argv) {
  const bin = requireBin();
  const labelIdx = argv.indexOf("--label");
  const label = labelIdx >= 0 ? argv[labelIdx + 1] : "gotchibot cursor chat";
  const id = cursorCreateChat(bin, ROOT);
  const state = loadState();
  rememberChat(state, id, label);
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ ok: true, chatId: id }, null, 2));
  } else {
    console.log(id);
  }
}

function cmdRun(argv, { interactive = false } = {}) {
  const bin = requireBin();
  const { prompt, opts } = parseRunArgs(argv);
  if (!prompt) usage();

  const state = loadState();
  let chatId = opts.resume || (opts.newChat ? null : state.activeChatId);
  if (!opts.dryRun) {
    if (opts.newChat || !chatId) {
      chatId = cursorCreateChat(bin, opts.cwd);
      rememberChat(state, chatId, prompt);
    } else {
      rememberChat(state, chatId, prompt);
    }
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

  const r = spawnSync(bin, args, {
    cwd: opts.cwd,
    encoding: "utf8",
    env: childEnv(),
    timeout: Number(process.env.GOTCHIBOT_CURSOR_TIMEOUT_MS ?? 600_000),
    maxBuffer: 20 * 1024 * 1024,
  });

  const output = (r.stdout || "").trim();
  const err = (r.stderr || "").trim();
  const ok = r.status === 0;
  const sessionId = finishRunDir(runDir, ok, output || err);

  const result = {
    ok,
    chatId,
    sessionId,
    exitCode: r.status,
    output: output || err,
  };

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (output) console.log(output);
    if (!ok && err) console.error(err);
    console.error(`\ncursor session: ${sessionId}  chat: ${chatId}`);
  }
  if (!ok) process.exit(r.status ?? 1);
}

const cmd = process.argv[2];
const rest = process.argv.slice(3);

switch (cmd) {
  case "run":
    cmdRun(rest);
    break;
  case "launch":
    cmdRun(rest, { interactive: true });
    break;
  case "resume": {
    const state = loadState();
    let chatId = null;
    const promptParts = [];
    for (const a of rest) {
      if (a === "--api-key" || a.startsWith("--api-key=")) {
        console.error("never pass --api-key; cursor-agent uses the logged-in Cursor account");
        process.exit(2);
      }
      if (!chatId && !a.startsWith("--") && /^[0-9a-f-]{36}$/i.test(a)) {
        chatId = a;
        continue;
      }
      if (!a.startsWith("--")) promptParts.push(a);
    }
    chatId = chatId || state.activeChatId;
    if (!chatId) {
      console.error("no chat id — run create first or pass uuid");
      process.exit(1);
    }
    cmdRun(["--resume", chatId, ...promptParts]);
    break;
  }
  case "create":
    cmdCreate(rest);
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
