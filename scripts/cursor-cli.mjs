#!/usr/bin/env node
/**
 * Cursor CLI bridge — gotchi builds context; Cursor Agent executes.
 *
 * usage:
 *   cursor-cli.mjs run "user prompt" [--mode plan|ask] [--new-chat] [--json]
 *   cursor-cli.mjs resume [chatId] "follow-up prompt"
 *   cursor-cli.mjs launch "prompt"          # interactive Cursor Agent (TTY)
 *   cursor-cli.mjs create [--label text]
 *   cursor-cli.mjs context [--json]
 *   cursor-cli.mjs list
 */
import { spawnSync, spawn } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = `${ROOT}/sessions`;
const STATE = `${SESSIONS}/.cursor-cli.json`;
const HANDOFF = `${SESSIONS}/HANDOFF.md`;
const PIN = `${SESSIONS}/.pin`;
const MAX_CONTEXT = Number(process.env.GOTCHIBOT_CURSOR_CONTEXT_CHARS ?? 28_000);

function usage() {
  console.error(`usage:
  cursor-cli.mjs run "prompt" [--mode plan|ask] [--new-chat] [--resume id] [--json]
  cursor-cli.mjs resume [chatId] "follow-up"
  cursor-cli.mjs launch "prompt" [--mode plan|ask] [--resume id]
  cursor-cli.mjs create [--label text]
  cursor-cli.mjs context [--json]
  cursor-cli.mjs list`);
  process.exit(2);
}

function hasCursor() {
  return spawnSync("command", ["-v", "cursor"], { shell: true }).status === 0;
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
Time: ${new Date().toISOString()}`);

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

function cursorCreateChat() {
  const r = spawnSync("cursor", ["agent", "create-chat"], {
    encoding: "utf8",
    cwd: ROOT,
  });
  if (r.status !== 0) {
    throw new Error(r.stderr || r.stdout || "cursor create-chat failed");
  }
  const id = (r.stdout || "").trim();
  if (!id) throw new Error("empty chat id from cursor create-chat");
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

function parseRunArgs(argv) {
  const opts = { mode: null, newChat: false, resume: null, json: false, extra: "" };
  const parts = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mode" && argv[i + 1]) opts.mode = argv[++i];
    else if (a === "--new-chat") opts.newChat = true;
    else if (a === "--resume" && argv[i + 1]) opts.resume = argv[++i];
    else if (a === "--json") opts.json = true;
    else if (a === "--extra" && argv[i + 1]) opts.extra = argv[++i];
    else if (a.startsWith("--")) continue;
    else parts.push(a);
  }
  const prompt = parts.join(" ").trim();
  return { prompt, opts };
}

function cursorArgs(opts, chatId, promptText) {
  const args = ["agent", "--workspace", ROOT, "--trust"];
  if (opts.interactive) {
    // no -p
  } else {
    args.push("-p", "--output-format", "text");
  }
  if (opts.mode) args.push("--mode", opts.mode);
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

function cmdCreate(argv) {
  if (!hasCursor()) {
    console.error("cursor CLI not found — install Cursor and ensure `cursor` is on PATH");
    process.exit(1);
  }
  const labelIdx = argv.indexOf("--label");
  const label = labelIdx >= 0 ? argv[labelIdx + 1] : "gotchibot cursor chat";
  const id = cursorCreateChat();
  const state = loadState();
  rememberChat(state, id, label);
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ ok: true, chatId: id }, null, 2));
  } else {
    console.log(id);
  }
}

function cmdRun(argv, { interactive = false } = {}) {
  if (!hasCursor()) {
    console.error("cursor CLI not found — install Cursor and ensure `cursor` is on PATH");
    process.exit(1);
  }
  const { prompt, opts } = parseRunArgs(argv);
  if (!prompt) usage();

  const state = loadState();
  let chatId = opts.resume || (opts.newChat ? null : state.activeChatId);
  if (opts.newChat || !chatId) {
    chatId = cursorCreateChat();
    rememberChat(state, chatId, prompt);
  } else {
    rememberChat(state, chatId, prompt);
  }

  const bundle = buildContext(prompt, { extra: opts.extra });
  const runDir = interactive ? null : makeRunDir();
  if (runDir) writeFileSync(join(runDir, "prompt.txt"), bundle);
  else writeFileSync(join(SESSIONS, ".cursor-last-prompt.txt"), bundle);

  const args = cursorArgs({ ...opts, interactive }, chatId, bundle);
  if (interactive) {
    if (!process.stdout.isTTY) {
      console.error("launch requires a TTY — use: cursor-cli.mjs run \"…\" for headless");
      process.exit(1);
    }
    const child = spawn("cursor", args, { cwd: ROOT, stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 0));
    return;
  }

  const r = spawnSync("cursor", args, {
    cwd: ROOT,
    encoding: "utf8",
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
  default:
    usage();
}
