#!/usr/bin/env node
/**
 * lib/claude-terminal.mjs — the standard way a GotchiBot agent gets a Claude
 * session it can drive, in a terminal a human can watch.
 *
 * This is the reusable core behind YFI's infra verification and LINK's trading
 * verification. Any agent that wants a standing second opinion should build on
 * this rather than reinventing the tmux plumbing.
 *
 * The shape, and why each part is the way it is:
 *
 *   - **tmux is the engine.** `send-keys` gives reliable input and
 *     `capture-pane` reliable output, and the session survives a closed window.
 *   - **Terminal.app is the viewport.** A tmux window has no desktop presence,
 *     so on its own the agent's Claude session is invisible from the machine's
 *     screen. `agent-desktop-terminal.sh` attaches a real window to it.
 *   - **The session is persistent and interactive**, not `claude -p` per call.
 *     Holding context is the point: it lets Claude say "no change since the
 *     last check" and name what moved, which a fresh invocation never can.
 *   - **Enter is verified, not assumed.** The TUI treats a long send-keys
 *     string as a paste and is still digesting it when an Enter sent right
 *     behind it arrives, so the prompt sat unsubmitted in the input box and
 *     the run "timed out" on a question Claude never saw. sendLine waits for
 *     the box to settle, presses Enter, and re-presses until the box empties.
 *   - **Every exchange is id-tagged.** Answers are matched on a per-round id
 *     plus the `⏺` reply bullet (which distinguishes Claude's answer from the
 *     `❯` echo of our own prompt), so a reply can never be mistaken for a
 *     previous one.
 *   - **The workspace lives outside this repo.** A session started inside
 *     ~/Dev/GotchiBot inherits the repo CLAUDE.md, which scopes Claude to the
 *     "GotchiBot Hub Claude proxy" role; it then correctly refuses an unrelated
 *     standing persona and blocks on a scope-check menu instead of answering.
 *     Each agent gets its own workspace dir with its own CLAUDE.md, seeded from
 *     a tracked copy so a clone can reproduce it.
 *
 * Usage:
 *
 *   import { createClaudeTerminal } from "./lib/claude-terminal.mjs";
 *   const terminal = createClaudeTerminal({
 *     agent: "link",
 *     window: "link-verify",
 *     workspace: `${process.env.HOME}/Dev/gotchibot-trader-verify`,
 *     workspaceSeed: "config/trader-verify-workspace/CLAUDE.md",
 *     allowedTools: "Bash(curl:*)",
 *     systemPrompt: "You are ...",
 *     briefing: "... Reply now with the word BRIEFED and nothing else.",
 *   });
 *   const r = terminal.verify({ context: "what the agent claims it did" });
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(LIB_DIR, "..", "..");
const HOME = process.env.HOME || "/Users/juliuswong";

const TMUX =
  [process.env.TMUX_BIN, "/opt/homebrew/bin/tmux", "/usr/local/bin/tmux"].find(
    (p) => p && existsSync(p),
  ) || "tmux";

// The CLI reads OAuth from the login keychain, so it only works in a terminal
// owned by the console session — over plain ssh it dies with "Not logged in".
const CLAUDE_BIN =
  process.env.INFRA_CLAUDE_BIN ||
  [`${HOME}/.local/bin/claude`, "/opt/homebrew/bin/claude", "/usr/local/bin/claude"].find((p) =>
    existsSync(p),
  ) ||
  "claude";

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function createClaudeTerminal(config) {
  const {
    agent,
    window,
    workspace,
    workspaceSeed,
    briefing,
    systemPrompt = "",
    allowedTools = "Bash(curl:*)",
    ackWord = "BRIEFED",
    session: tmuxSession = process.env.GOTCHIBOT_TMUX_SESSION || "gotchibot",
    stateDir = join(ROOT, "var/agent-terminals"),
    readyTimeout = Number(process.env.AGENT_CLAUDE_READY_TIMEOUT || 90000),
    replyTimeout = Number(process.env.AGENT_CLAUDE_REPLY_TIMEOUT || 240000),
    recycleAfter = Number(process.env.AGENT_CLAUDE_RECYCLE_AFTER || 50),
    cols = 200,
    rows = 50,
  } = config;

  if (!agent || !window || !workspace || !briefing) {
    throw new Error("createClaudeTerminal requires agent, window, workspace and briefing");
  }

  const TARGET = `${tmuxSession}:${window}`;
  const SESSION_FILE = join(stateDir, `${agent}.json`);
  const LOCK_FILE = join(stateDir, `${agent}.lock`);

  const ensureDir = () => {
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  };

  function tmux(args, { check = false } = {}) {
    const r = spawnSync(TMUX, args, { encoding: "utf8" });
    if (check && r.status !== 0) {
      throw new Error(`tmux ${args.join(" ")} failed: ${(r.stderr || "").trim()}`);
    }
    return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
  }

  const readSession = () => {
    try {
      return JSON.parse(readFileSync(SESSION_FILE, "utf8"));
    } catch {
      return null;
    }
  };

  const writeSession = (s) => {
    ensureDir();
    writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2), "utf8");
  };

  // Coarse lock so a manual run cannot type into the window while a scheduled
  // one is waiting on an answer. Stale locks (dead pid) are reclaimed.
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
        if (alive && Date.now() - Date.parse(at) < replyTimeout + 60000) return false;
      } catch {
        /* unparseable lock — reclaim */
      }
    }
    writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), "utf8");
    return true;
  }

  const releaseLock = () => {
    try {
      unlinkSync(LOCK_FILE);
    } catch {
      /* already gone */
    }
  };

  const windowExists = () => {
    const r = tmux(["list-windows", "-t", tmuxSession, "-F", "#{window_name}"]);
    return r.ok && r.out.split("\n").some((n) => n.trim() === window);
  };

  const capture = (lines = 400) => {
    const r = tmux(["capture-pane", "-p", "-S", `-${lines}`, "-t", TARGET]);
    return r.ok ? r.out : "";
  };

  // The input box is everything from the last "❯" line down. Its first row is
  // what tells us whether our text is still sitting there unsubmitted.
  function inputBoxFirstRow(pane = capture(60)) {
    const lines = pane.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^\s*❯/.test(lines[i])) return lines[i].replace(/^\s*❯\s?/, "").trim();
    }
    return null;
  }

  const isPlaceholder = (row) => !row || /^Try\s+"/.test(row) || /^\S+\s+for shortcuts/.test(row);

  function waitForInputToSettle(maxMs = 8000) {
    let prev = null;
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const cur = capture(60);
      if (cur === prev) return;
      prev = cur;
      sleep(700);
    }
  }

  // Leftover text in the box (a previous run whose Enter never landed) would be
  // glued onto ours. Ctrl+U clears the line; one Ctrl+C clears the box without
  // leaving the TUI (two would).
  function clearStaleInput() {
    let row = inputBoxFirstRow();
    if (isPlaceholder(row)) return false;
    tmux(["send-keys", "-t", TARGET, "C-u"]);
    sleep(600);
    row = inputBoxFirstRow();
    if (isPlaceholder(row)) return true;
    tmux(["send-keys", "-t", TARGET, "C-c"]);
    sleep(800);
    return true;
  }

  function sendLine(text) {
    clearStaleInput();
    // -l sends the string literally so brackets, quotes and braces survive.
    // The TUI submits on Enter, so text must be a single line.
    tmux(["send-keys", "-t", TARGET, "-l", text], { check: true });
    waitForInputToSettle();
    const head = text.trim().slice(0, 8);
    const unsubmitted = () => {
      const row = inputBoxFirstRow();
      return row != null && row.startsWith(head);
    };
    for (let attempt = 1; attempt <= 4; attempt++) {
      tmux(["send-keys", "-t", TARGET, "Enter"], { check: true });
      const until = Date.now() + 2500;
      while (Date.now() < until) {
        sleep(500);
        if (!unsubmitted()) return;
      }
    }
    throw new Error(`prompt never submitted in ${TARGET} — Enter did not register after 4 tries`);
  }

  // Claude stopped for a menu (permission request, scope check) and will never
  // answer until a human picks an option. Detect it rather than timing out blind.
  const blockedOnPrompt = (pane) => /Enter to select\s*·\s*↑\/↓ to navigate/.test(pane);

  function waitFor(predicate, timeoutMs, pollMs = 1500) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const pane = capture();
      if (predicate(pane)) return { ok: true, pane };
      if (blockedOnPrompt(pane)) return { ok: false, pane, blocked: true };
      if (Date.now() > deadline) return { ok: false, pane };
      sleep(pollMs);
    }
  }

  function ensureWorkspace() {
    const target = join(workspace, "CLAUDE.md");
    if (existsSync(target)) return;
    const source = join(ROOT, workspaceSeed || "");
    if (!workspaceSeed || !existsSync(source)) {
      throw new Error(`no workspace CLAUDE.md at ${target} and no tracked seed at ${source}`);
    }
    mkdirSync(workspace, { recursive: true });
    writeFileSync(target, readFileSync(source, "utf8"), "utf8");
  }

  // A tmux window has no desktop presence. Never fatal: a locked or headless
  // machine has no desktop to draw on, and the work does not depend on anyone
  // watching.
  function showOnDesktop() {
    try {
      const r = spawnSync(
        join(ROOT, "scripts/agent-desktop-terminal.sh"),
        ["--window", window, "--title", `GotchiBot ${agent} verifier`, "--cols", String(cols), "--rows", String(rows)],
        { encoding: "utf8", timeout: 45000 },
      );
      return { ok: r.status === 0, out: (r.stdout || r.stderr || "").trim() };
    } catch (err) {
      return { ok: false, out: String(err?.message || err) };
    }
  }

  function startWindow() {
    ensureWorkspace();
    if (!tmux(["has-session", "-t", tmuxSession]).ok) {
      tmux(["new-session", "-d", "-s", tmuxSession, "-n", "work"], { check: true });
    }
    // A minimal PATH makes repo SessionStart hooks fail with "node: command not
    // found", so hand the window a usable one.
    const path = `/usr/local/bin:/opt/homebrew/bin:${HOME}/.local/bin:/usr/bin:/bin`;
    const sys = systemPrompt ? ` --append-system-prompt "${systemPrompt.replace(/"/g, '\\"')}"` : "";
    const cmd = `PATH="${path}" exec "${CLAUDE_BIN}" --allowedTools "${allowedTools}"${sys}`;
    tmux(["new-window", "-d", "-t", tmuxSession, "-n", window, "-c", workspace, cmd], { check: true });
    // Keep the pane wide: attaching a client resizes the window to the client,
    // and a narrow one wraps answer lines and defeats the parser.
    tmux(["resize-window", "-t", TARGET, "-x", String(cols), "-y", String(rows)]);

    const ready = waitFor((p) => p.includes("❯"), readyTimeout);
    if (!ready.ok) {
      throw new Error(
        ready.blocked
          ? `claude is blocked on an interactive prompt in ${TARGET}`
          : `claude TUI never reached its prompt in ${readyTimeout}ms`,
      );
    }
    sleep(1500);
    if (process.env.AGENT_CLAUDE_NO_DESKTOP !== "1") showOnDesktop();
    return true;
  }

  function brief() {
    sendLine(briefing);
    const ackRe = new RegExp(`⏺\\s*${ackWord}`, "i");
    const got = waitFor((p) => ackRe.test(p), replyTimeout);
    if (!got.ok) {
      throw new Error(
        got.blocked
          ? `claude is blocked on an interactive prompt in ${TARGET} — attach and answer it, or rerun with --restart`
          : "claude did not acknowledge the briefing",
      );
    }
    return new Date().toISOString();
  }

  function ensureSession({ restart = false } = {}) {
    let s = readSession();

    if (restart && windowExists()) {
      tmux(["kill-window", "-t", TARGET]);
      s = null;
    }

    if (!windowExists()) {
      startWindow();
      const briefedAt = brief();
      s = { agent, host: hostname(), window: TARGET, startedAt: new Date().toISOString(), briefedAt, checks: 0 };
      writeSession(s);
      return { session: s, created: true };
    }

    // Window alive but no record of briefing it (state lost, it predates this
    // script, or the record was rsynced over from another machine) — brief now
    // rather than asking blind.
    if (!s || !s.briefedAt || s.host !== hostname()) {
      const briefedAt = brief();
      s = { agent, host: hostname(), window: TARGET, startedAt: s?.startedAt || new Date().toISOString(), briefedAt, checks: s?.checks || 0 };
      writeSession(s);
      return { session: s, created: false, rebriefed: true };
    }

    // Long-lived sessions grow context without bound; recycle while keeping the
    // same window so the desktop client stays attached.
    if (recycleAfter > 0 && s.checks >= recycleAfter) {
      sendLine("/clear");
      sleep(3000);
      const briefedAt = brief();
      s = { ...s, briefedAt, checks: 0, recycledAt: new Date().toISOString() };
      writeSession(s);
      return { session: s, created: false, recycled: true };
    }

    return { session: s, created: false };
  }

  function verify({ context = null, question = null, restart = false } = {}) {
    const startedAt = new Date().toISOString();
    if (!acquireLock()) {
      return { ok: false, available: true, verdict: null, error: "another verification is already in flight", startedAt };
    }
    try {
      const { session, created, recycled, rebriefed } = ensureSession({ restart });
      const id = `CV-${Date.now().toString(36).toUpperCase()}`;
      const ask = [
        `Check id ${id}.`,
        question || "Verify now.",
        context ? `Here is what I claim: ${context} Say plainly if you disagree.` : "",
      ]
        .filter(Boolean)
        .join(" ");

      sendLine(ask);

      // Liberal whitespace: Claude writes "VERDICT [id]:" as often as
      // "VERDICT[id]:", and a strict match burns the whole timeout in silence
      // on an answer that was actually correct.
      const re = new RegExp(`⏺\\s*VERDICT\\s*\\[\\s*${id}\\s*\\]\\s*:\\s*(\\w+)`, "i");
      const got = waitFor((p) => re.test(p), replyTimeout);

      if (!got.ok) {
        return {
          ok: false,
          available: true,
          verdict: null,
          error: got.blocked
            ? `claude is blocked on an interactive prompt in ${TARGET} — attach and answer it, or rerun with --restart`
            : `no tagged answer for ${id} within ${replyTimeout}ms`,
          blocked: Boolean(got.blocked),
          id,
          window: TARGET,
          startedAt,
          finishedAt: new Date().toISOString(),
        };
      }

      // The reply streams, so the VERDICT line lands before SUMMARY and DETAIL
      // exist on screen. Matching the verdict is the cue to start reading, not
      // to read at once.
      const settleRe = new RegExp(
        `⏺\\s*VERDICT\\s*\\[\\s*${id}\\s*\\]\\s*:\\s*\\w+[\\s\\S]*?DETAIL:\\s*\\S`,
        "i",
      );
      const settled = waitFor((p) => settleRe.test(p), 30000, 1000);

      const pane = settled.ok ? settled.pane : got.pane;
      const verdict = pane.match(re)[1].toUpperCase();
      const after = pane.slice(pane.search(re));
      const summary = after.match(/SUMMARY:\s*(.+)/i)?.[1]?.trim() || null;
      const detail = after.match(/DETAIL:\s*(.+)/i)?.[1]?.trim() || null;
      // Claude's answer, verbatim: from the ⏺ VERDICT line down to the input
      // box or the next rule, with the bullet and wrap indentation stripped.
      const reply = after
        .split("\n")
        .slice(0)
        .reduce((acc, line) => {
          if (acc.done) return acc;
          if (acc.lines.length && (/^\s*❯/.test(line) || /^[─]{6,}/.test(line))) return { ...acc, done: true };
          acc.lines.push(line.replace(/^\s*⏺\s?/, "").replace(/^\s{1,3}/, ""));
          return acc;
        }, { lines: [], done: false })
        .lines.join("\n")
        .replace(/\s+$/, "");

      writeSession({
        ...session,
        checks: (session.checks || 0) + 1,
        lastId: id,
        lastAt: new Date().toISOString(),
        lastVerdict: verdict,
      });

      return {
        ok: true,
        available: true,
        verdict,
        summary,
        detail,
        id,
        text: [`VERDICT[${id}]: ${verdict}`, summary && `SUMMARY: ${summary}`, detail && `DETAIL: ${detail}`]
          .filter(Boolean)
          .join("\n"),
        reply,
        sessionCreated: Boolean(created),
        sessionRecycled: Boolean(recycled || rebriefed),
        window: TARGET,
        error: null,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        ok: false,
        available: true,
        verdict: null,
        error: String(err?.message || err),
        window: TARGET,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    } finally {
      releaseLock();
    }
  }

  return {
    verify,
    show: showOnDesktop,
    status: () => ({ agent, window: TARGET, alive: windowExists(), session: readSession() }),
    windowExists,
  };
}
