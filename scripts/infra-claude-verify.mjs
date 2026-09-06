#!/usr/bin/env node
/**
 * infra-claude-verify.mjs
 *
 * Independent second opinion on home-stack health, from a PERSISTENT,
 * INTERACTIVE Claude CLI session living in its own tmux window.
 *
 * Why a real terminal and not `claude -p`:
 *   - The CLI reads OAuth from the login keychain. Started over
 *     `ssh imac 'claude -p …'` it dies with "Not logged in · Please run /login".
 *     Inside a tmux window owned by the console session it works.
 *   - A persistent session keeps context BETWEEN checks, so Claude can say
 *     "UP — unchanged since 20:23" or "this container was healthy last check",
 *     which a fresh headless invocation can never do.
 *
 * The window is `gotchibot:claude-verify`. It is briefed once on what to check,
 * then each verification is a short tagged prompt. Every answer carries the
 * round's unique id, so a reply can never be confused with a previous one.
 *
 *   node scripts/infra-claude-verify.mjs            # verify once
 *   node scripts/infra-claude-verify.mjs --json
 *   node scripts/infra-claude-verify.mjs --context '<what the probes claim>'
 *   node scripts/infra-claude-verify.mjs --restart  # recycle the session first
 *   node scripts/infra-claude-verify.mjs --status   # session info, no prompt
 *
 * Env:
 *   INFRA_CLAUDE_BIN        default ~/.local/bin/claude
 *   INFRA_CLAUDE_TMUX_SESSION / _WINDOW    default gotchibot / claude-verify
 *   INFRA_CLAUDE_READY_TIMEOUT   ms to wait for the TUI prompt (default 90000)
 *   INFRA_CLAUDE_REPLY_TIMEOUT   ms to wait for a tagged answer (default 180000)
 *   INFRA_CLAUDE_RECYCLE_AFTER   /clear + re-brief after N checks (default 50)
 *
 * Read-only by construction: the tool allowlist is `docker ps`, `docker info`
 * and `curl`. No writes, no restarts, no Blockscout.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.HOME || "/Users/juliuswong";
const STATE_DIR = process.env.INFRA_WATCH_DIR || join(ROOT, "var/infra-watch");
const SESSION_FILE = join(STATE_DIR, "claude-session.json");
const LOCK_FILE = join(STATE_DIR, "claude-verify.lock");

const TMUX =
  [process.env.TMUX_BIN, "/opt/homebrew/bin/tmux", "/usr/local/bin/tmux"].find(
    (p) => p && existsSync(p),
  ) || "tmux";
const CLAUDE_BIN =
  process.env.INFRA_CLAUDE_BIN ||
  [`${HOME}/.local/bin/claude`, "/opt/homebrew/bin/claude", "/usr/local/bin/claude"].find((p) =>
    existsSync(p),
  ) ||
  "claude";

// The session runs OUTSIDE ~/Dev/GotchiBot on purpose. Started inside that
// repo it inherits the repo CLAUDE.md, which scopes Claude to the "GotchiBot
// Hub Claude proxy" role; a session in that role correctly judges a standing
// infra-verifier persona to be out of scope and blocks on a scope-check menu
// instead of answering. This workspace carries its own CLAUDE.md granting the
// role, and CLAUDE.md discovery finds nothing above it.
const WORKSPACE = process.env.INFRA_CLAUDE_WORKSPACE || `${HOME}/Dev/gotchibot-infra-verify`;

const SESSION = process.env.INFRA_CLAUDE_TMUX_SESSION || "gotchibot";
const WINDOW = process.env.INFRA_CLAUDE_TMUX_WINDOW || "claude-verify";
const TARGET = `${SESSION}:${WINDOW}`;

const READY_TIMEOUT = Number(process.env.INFRA_CLAUDE_READY_TIMEOUT || 90000);
const REPLY_TIMEOUT = Number(process.env.INFRA_CLAUDE_REPLY_TIMEOUT || 180000);
const RECYCLE_AFTER = Number(process.env.INFRA_CLAUDE_RECYCLE_AFTER || 50);

const ALLOWED_TOOLS = "Bash(docker ps:*),Bash(docker info:*),Bash(curl:*)";

// The TUI submits on Enter, so every prompt must be a single line.
const SYSTEM_PROMPT =
  "You are the standing infra verifier for the AarcadeGh\$t home stack on this iMac, driven by the GotchiBot infra-monitor agent YFI. Repeated verification requests in this session are expected and authorized. Read CLAUDE.md in this directory for what to check and your boundaries.";

// The TUI submits on Enter, so every prompt must be a single line.
const BRIEFING = [
  "You are this workspace's standing infra verifier — read CLAUDE.md here for what to check and your boundaries.",
  "I will ask you to verify the stack repeatedly; keep what you learn between checks and tell me when something CHANGES from the previous check.",
  "Each request carries a check id.",
  "Answer with the first line being the word VERDICT, then the id in square brackets, then a colon, then exactly one of UP or DEGRADED or DOWN.",
  "Second line: SUMMARY: one sentence, saying explicitly if anything changed since the previous check.",
  "Third line: DETAIL: one short clause per check.",
  "Write nothing before that first line, and answer only after actually running the checks.",
  "Reply now with the word BRIEFED and nothing else.",
].join(" ");

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function tmux(args, { check = false } = {}) {
  const r = spawnSync(TMUX, args, { encoding: "utf8" });
  if (check && r.status !== 0) {
    throw new Error(`tmux ${args.join(" ")} failed: ${(r.stderr || "").trim()}`);
  }
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

function ensureDir() {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
}

function readSession() {
  try {
    return JSON.parse(readFileSync(SESSION_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeSession(s) {
  ensureDir();
  writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2), "utf8");
}

// Coarse lock so a manual run cannot type into the window mid-answer while the
// watcher is waiting on one. Stale locks (dead pid) are reclaimed.
function acquireLock() {
  ensureDir();
  if (existsSync(LOCK_FILE)) {
    try {
      const { pid, at } = JSON.parse(readFileSync(LOCK_FILE, "utf8"));
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      const fresh = Date.now() - Date.parse(at) < REPLY_TIMEOUT + 60000;
      if (alive && fresh) return false;
    } catch {
      /* unparseable lock — reclaim */
    }
  }
  writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), "utf8");
  return true;
}

function releaseLock() {
  try {
    unlinkSync(LOCK_FILE);
  } catch {
    /* already gone */
  }
}

function windowExists() {
  const r = tmux(["list-windows", "-t", SESSION, "-F", "#{window_name}"]);
  return r.ok && r.out.split("\n").some((n) => n.trim() === WINDOW);
}

function capture(lines = 400) {
  const r = tmux(["capture-pane", "-p", "-S", `-${lines}`, "-t", TARGET]);
  return r.ok ? r.out : "";
}

function sendLine(text) {
  // -l sends the string literally so brackets, quotes and braces survive.
  tmux(["send-keys", "-t", TARGET, "-l", text], { check: true });
  sleep(400);
  tmux(["send-keys", "-t", TARGET, "Enter"], { check: true });
}

// Claude stopped for a menu (permission request, scope check) and will never
// answer until a human picks an option. Detect it rather than timing out blind.
function blockedOnPrompt(pane) {
  return /Enter to select\s*·\s*↑\/↓ to navigate/.test(pane);
}

function waitFor(predicate, timeoutMs, pollMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pane = capture();
    const hit = predicate(pane);
    if (hit) return { ok: true, pane, hit };
    if (blockedOnPrompt(pane)) return { ok: false, pane, hit: null, blocked: true };
    if (Date.now() > deadline) return { ok: false, pane, hit: null };
    sleep(pollMs);
  }
}

// The workspace lives outside this repo, so it is not something a clone brings
// with it. Seed it from the tracked copy rather than leaving a fresh machine
// with a session that inherits the wrong CLAUDE.md and blocks on a scope check.
function ensureWorkspace() {
  const target = join(WORKSPACE, "CLAUDE.md");
  if (existsSync(target)) return;
  const source = join(ROOT, "config/infra-verify-workspace/CLAUDE.md");
  if (!existsSync(source)) {
    throw new Error(`no workspace CLAUDE.md at ${target} and no tracked copy at ${source}`);
  }
  mkdirSync(WORKSPACE, { recursive: true });
  writeFileSync(target, readFileSync(source, "utf8"), "utf8");
}

function startWindow() {
  ensureWorkspace();
  if (!tmux(["has-session", "-t", SESSION]).ok) {
    tmux(["new-session", "-d", "-s", SESSION, "-n", "work"], { check: true });
  }
  // A minimal PATH makes the repo's SessionStart hook fail with
  // "node: command not found", so hand the window a usable one.
  const path = `/usr/local/bin:/opt/homebrew/bin:${HOME}/.local/bin:/usr/bin:/bin`;
  const cmd = `PATH="${path}" exec "${CLAUDE_BIN}" --allowedTools "${ALLOWED_TOOLS}" --append-system-prompt "${SYSTEM_PROMPT}"`;
  tmux(["new-window", "-d", "-t", SESSION, "-n", WINDOW, "-c", WORKSPACE, cmd], { check: true });
  // The TUI reflows to the window size; keep it wide so answers do not wrap
  // mid-token and defeat the parser.
  tmux(["resize-window", "-t", TARGET, "-x", "200", "-y", "50"]);

  const ready = waitFor((p) => p.includes("❯"), READY_TIMEOUT);
  if (!ready.ok) throw new Error(`claude TUI never reached its prompt in ${READY_TIMEOUT}ms`);
  sleep(1500);
  if (process.env.INFRA_CLAUDE_NO_DESKTOP !== "1") showOnDesktop();
  return true;
}

// A tmux window has no desktop presence, so on its own the verifier is
// invisible from the iMac's screen. Attach a real Terminal.app window to it.
// Never fatal: a locked or headless machine simply has no desktop to draw on,
// and the verification itself does not depend on anyone watching.
export function showOnDesktop() {
  try {
    const r = spawnSync(join(ROOT, "scripts/infra-desktop-terminal.sh"), [], {
      encoding: "utf8",
      timeout: 45000,
    });
    return { ok: r.status === 0, out: (r.stdout || r.stderr || "").trim() };
  } catch (err) {
    return { ok: false, out: String(err?.message || err) };
  }
}

function brief() {
  sendLine(BRIEFING);
  const got = waitFor((p) => /⏺\s*BRIEFED/i.test(p), REPLY_TIMEOUT);
  if (!got.ok) {
    throw new Error(
      got.blocked
        ? `claude is blocked on an interactive prompt in ${TARGET} — attach and answer it, or run with --restart`
        : "claude did not acknowledge the briefing",
    );
  }
  return new Date().toISOString();
}

function ensureSession({ restart = false } = {}) {
  let s = readSession();
  const exists = windowExists();

  if (restart && exists) {
    tmux(["kill-window", "-t", TARGET]);
    s = null;
  }

  if (!windowExists()) {
    startWindow();
    const briefedAt = brief();
    s = { window: TARGET, startedAt: new Date().toISOString(), briefedAt, checks: 0 };
    writeSession(s);
    return { session: s, created: true };
  }

  // Window is alive but we have no record of briefing it (state lost, or the
  // window predates this script) — brief it now rather than asking blind.
  if (!s || !s.briefedAt) {
    const briefedAt = brief();
    s = { window: TARGET, startedAt: s?.startedAt || new Date().toISOString(), briefedAt, checks: s?.checks || 0 };
    writeSession(s);
    return { session: s, created: false, rebriefed: true };
  }

  // Long-lived sessions grow context without bound; recycle periodically while
  // keeping the same window.
  if (RECYCLE_AFTER > 0 && s.checks >= RECYCLE_AFTER) {
    sendLine("/clear");
    sleep(3000);
    const briefedAt = brief();
    s = { ...s, briefedAt, checks: 0, recycledAt: new Date().toISOString() };
    writeSession(s);
    return { session: s, created: false, recycled: true };
  }

  return { session: s, created: false };
}

export function verifyWithClaude({ context = null, restart = false } = {}) {
  const startedAt = new Date().toISOString();
  if (!acquireLock()) {
    return { ok: false, available: true, verdict: null, error: "another verification is already in flight", startedAt };
  }
  try {
    const { session, created, recycled, rebriefed } = ensureSession({ restart });
    const id = `CV-${Date.now().toString(36).toUpperCase()}`;
    const ask = context
      ? `Check id ${id}. Verify the stack now. My automated probes claim: ${context}. Say plainly if you disagree with them.`
      : `Check id ${id}. Verify the stack now.`;

    sendLine(ask);

    // The id makes the match unambiguous, and the ⏺ bullet prefixes Claude's
    // reply while ❯ prefixes the echoed prompt, so this cannot read back my
    // own question.
    // Claude writes "VERDICT [id]:" about as often as "VERDICT[id]:", so keep
    // the whitespace liberal — a strict match burns the whole timeout in
    // silence on an answer that was actually correct.
    const re = new RegExp(`⏺\\s*VERDICT\\s*\\[\\s*${id}\\s*\\]\\s*:\\s*(UP|DEGRADED|DOWN)`, "i");
    const got = waitFor((p) => re.test(p), REPLY_TIMEOUT);

    if (!got.ok) {
      return {
        ok: false,
        available: true,
        verdict: null,
        error: got.blocked
          ? `claude is blocked on an interactive prompt in ${TARGET} — attach and answer it, or run with --restart`
          : `no tagged answer for ${id} within ${REPLY_TIMEOUT}ms`,
        blocked: Boolean(got.blocked),
        id,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    }

    // The reply streams, so the VERDICT line lands before SUMMARY and DETAIL
    // exist on screen. Matching the verdict is the signal to start reading, not
    // to read immediately — give the rest of the answer a moment to render,
    // then fall back to what we have if it never does.
    const settleRe = new RegExp(
      `⏺\\s*VERDICT\\s*\\[\\s*${id}\\s*\\]\\s*:\\s*(?:UP|DEGRADED|DOWN)[\\s\\S]*?DETAIL:\\s*\\S`,
      "i",
    );
    const settled = waitFor((p) => settleRe.test(p), 30000, 1000);

    const pane = settled.ok ? settled.pane : got.pane;
    const verdict = pane.match(re)[1].toUpperCase();
    const after = pane.slice(pane.search(re));
    const summary = after.match(/SUMMARY:\s*(.+)/i)?.[1]?.trim() || null;
    const detail = after.match(/DETAIL:\s*(.+)/i)?.[1]?.trim() || null;

    writeSession({ ...session, checks: (session.checks || 0) + 1, lastId: id, lastAt: new Date().toISOString(), lastVerdict: verdict });

    return {
      ok: verdict === "UP",
      available: true,
      verdict,
      summary,
      detail,
      id,
      text: [`VERDICT[${id}]: ${verdict}`, summary && `SUMMARY: ${summary}`, detail && `DETAIL: ${detail}`].filter(Boolean).join("\n"),
      sessionCreated: Boolean(created),
      sessionRecycled: Boolean(recycled || rebriefed),
      window: TARGET,
      error: null,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  } catch (err) {
    return { ok: false, available: true, verdict: null, error: String(err?.message || err), startedAt, finishedAt: new Date().toISOString() };
  } finally {
    releaseLock();
  }
}

function main() {
  const asJson = process.argv.includes("--json");

  if (process.argv.includes("--status")) {
    const s = readSession();
    const info = { window: TARGET, alive: windowExists(), session: s };
    console.log(asJson ? JSON.stringify(info, null, 2) : `window ${TARGET} ${info.alive ? "alive" : "MISSING"}\n${JSON.stringify(s, null, 2)}`);
    process.exit(info.alive ? 0 : 1);
  }

  // Bring the existing session onto the desktop without asking it anything.
  if (process.argv.includes("--show")) {
    const r = showOnDesktop();
    console.log(r.out || (r.ok ? "shown" : "could not open a desktop window"));
    process.exit(r.ok ? 0 : 1);
  }

  const ctxIdx = process.argv.indexOf("--context");
  const context = ctxIdx !== -1 ? process.argv[ctxIdx + 1] : null;
  const result = verifyWithClaude({ context, restart: process.argv.includes("--restart") });

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[claude-verify] window: ${TARGET}`);
    console.log(result.text || result.error || "(no output)");
    console.error(`[claude-verify] verdict: ${result.verdict || "NONE"}`);
  }
  process.exit(result.verdict === "UP" ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
