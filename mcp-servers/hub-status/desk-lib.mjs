/**
 * Read-only desk monitor for the hub-status MCP server.
 *
 * Runs in the MCP process on the desk (the MacBook checkout). No writes, no
 * restarts, no sends. Every string that leaves is redacted; the desk token and
 * any literal secret value found in the pin file are scrubbed by value too.
 * If the process cannot run (desk offline) the MCP connector itself is down.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "./chat-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HEALTH_URL = "http://127.0.0.1:45679/health";
const TMUX_SESSION = "gotchibot";
const LOG_LINES_MAX = 200;
const LOG_NAME = /^[A-Za-z0-9._-]+\.log$/;

/** Redact known token shapes plus literal secret values. */
export function deskRedact(value, literals = []) {
  let s = redactSecrets(value);
  s = s
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(
      /\b([A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|authorization|cookie)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
      "$1$2[redacted]",
    )
    .replace(/([?&](?:token|key|secret|code|password)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b[A-Fa-f0-9]{40,}\b/g, "[redacted hex]")
    .replace(/\b[A-Za-z0-9+/_-]{48,}={0,2}/g, "[redacted blob]");
  for (const lit of literals) {
    if (typeof lit === "string" && lit.length >= 6) s = s.split(lit).join("[redacted]");
  }
  return s;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function pinPath(env, root) {
  const o = String(env.GOTCHIBOT_HUB_PIN || "").trim();
  return o ? resolve(o) : join(root, "sessions/.hub.json");
}

function literalsFrom(pin, env) {
  return [pin?.deskToken, env.GOTCHIBOT_DESK_TOKEN].filter((v) => typeof v === "string" && v);
}

const defaultRun = (cmd, args, { cwd, timeoutMs = 8000, env } = {}) =>
  new Promise((res) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, env, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      res({
        code: err ? (typeof err.code === "number" ? err.code : err.killed ? 124 : 1) : 0,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
        missing: err?.code === "ENOENT",
      });
    });
  });

async function probeHealth(fetchImpl, url = HEALTH_URL) {
  try {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(2000) });
    return { ok: Boolean(r.ok), status: r.status };
  } catch (e) {
    return { ok: false, error: deskRedact(e?.message || e).slice(0, 120) };
  }
}

/** Pairing line without the token. */
export function pairingLine(pin) {
  if (!pin) return { paired: false, line: "not paired (no sessions/.hub.json)" };
  const parts = [
    pin.deskName ? `desk ${pin.deskName}` : null,
    pin.deskId ? `id ${pin.deskId}` : null,
    pin.deskApiBase ? `api ${pin.deskApiBase}` : null,
    pin.tailscaleHost ? `host ${pin.tailscaleHost}` : null,
    pin.pairedAt ? `paired ${pin.pairedAt}` : null,
    pin.deskToken ? "token present (not shown)" : "no token",
  ].filter(Boolean);
  return { paired: Boolean(pin.deskToken), line: deskRedact(parts.join(" · "), literalsFrom(pin, {})) };
}

export async function deskStatus({ root = ROOT, env = process.env, run = defaultRun, fetchImpl = globalThis.fetch } = {}) {
  const pin = readJson(pinPath(env, root));
  const lits = literalsFrom(pin, env);
  const [health, tm] = await Promise.all([
    probeHealth(fetchImpl),
    run("tmux", ["has-session", "-t", TMUX_SESSION], { timeoutMs: 3000 }),
  ]);
  return {
    online: true,
    host: deskRedact(env.HOSTNAME || "", lits) || undefined,
    receiver: { port: 45679, ...health },
    tmux: { session: TMUX_SESSION, up: tm.code === 0, ...(tm.missing ? { note: "tmux not installed" } : {}) },
    pairing: pairingLine(pin),
    checkedAt: new Date().toISOString(),
  };
}

export async function deskLogs({ file, lines = 60, root = ROOT, env = process.env } = {}) {
  const dir = join(root, "sessions");
  const pin = readJson(pinPath(env, root));
  const lits = literalsFrom(pin, env);
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => LOG_NAME.test(n));
  } catch {
    /* none */
  }
  const info = names
    .map((n) => {
      try {
        const st = statSync(join(dir, n));
        return { name: n, bytes: st.size, mtime: st.mtime.toISOString() };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
  if (file == null || file === "") return { files: info.slice(0, 40) };
  const name = basename(String(file));
  if (name !== file || !LOG_NAME.test(name) || !names.includes(name)) {
    const err = new Error("file must be the name of a sessions/*.log file (see files list)");
    throw err;
  }
  const n = Math.max(1, Math.min(LOG_LINES_MAX, Math.floor(Number(lines)) || 60));
  const text = readFileSync(join(dir, name), "utf8");
  const tail = text.split(/\r?\n/).filter((l) => l !== "").slice(-n);
  return { file: name, lines: tail.map((l) => deskRedact(l, lits).slice(0, 500)) };
}

export async function deskGit({ root = ROOT, run = defaultRun, env = process.env } = {}) {
  const pin = readJson(pinPath(env, root));
  const lits = literalsFrom(pin, env);
  const g = (args) => run("git", args, { cwd: root, timeoutMs: 8000 });
  const [branch, sha, st] = await Promise.all([
    g(["rev-parse", "--abbrev-ref", "HEAD"]),
    g(["rev-parse", "--short", "HEAD"]),
    g(["status", "--porcelain=v1", "-b"]),
  ]);
  const rows = st.stdout.split("\n").filter(Boolean);
  const head = rows[0]?.startsWith("##") ? rows.shift() : "";
  const dirty = rows.map((r) => deskRedact(r, lits).slice(0, 200));
  return {
    branch: branch.stdout.trim(),
    sha: sha.stdout.trim(),
    tracking: deskRedact(head.replace(/^## /, ""), lits),
    dirtyCount: dirty.length,
    dirty: dirty.slice(0, 100),
    truncated: dirty.length > 100,
  };
}

export async function deskPanes({ run = defaultRun } = {}) {
  const fmt = "#{window_index}.#{pane_index}\t#{window_name}\t#{pane_current_command}\t#{pane_dead}\t#{pane_pid}";
  const r = await run("tmux", ["list-panes", "-s", "-t", TMUX_SESSION, "-F", fmt], { timeoutMs: 4000 });
  if (r.code !== 0) return { session: TMUX_SESSION, up: false, panes: [] };
  const panes = r.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [pane, window, command, dead, pid] = l.split("\t");
      return { pane, window: deskRedact(window), command: deskRedact(command), dead: dead === "1", pid: Number(pid) || null };
    });
  const ps = await run("ps", ["-axo", "pid=,etime=,%cpu=,%mem=,comm="], { timeoutMs: 4000 });
  const interesting = ps.stdout
    .split("\n")
    .map((l) => l.trim().match(/^(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/))
    .filter(Boolean)
    .filter((m) => /(^|\/)(node|tmux|himalaya|abra)$/.test(m[5]))
    .slice(0, 40)
    .map((m) => ({ pid: Number(m[1]), etime: m[2], cpu: m[3], mem: m[4], comm: basename(m[5]) }));
  return { session: TMUX_SESSION, up: true, panes, processes: interesting };
}

/** `gotchibot mail check` status only: first line (OK/FAIL), exit code, no mail content. */
export async function deskMailCheck({ root = ROOT, run = defaultRun, identity = "gotchibot.xyz", env = process.env } = {}) {
  if (!/^[a-z0-9.-]{1,64}$/i.test(identity)) throw new Error("bad identity");
  const bin = join(root, "scripts/gotchibot");
  if (!existsSync(bin)) return { ok: false, status: "unknown", note: "scripts/gotchibot missing" };
  const pin = readJson(pinPath(env, root));
  const r = await run(bin, ["mail", "check", "--as", identity], {
    cwd: root,
    timeoutMs: 45000,
    // Non-interactive: no TTY, so the server-down prompt cannot start anything.
    env: { ...env, CI: "1" },
  });
  const out = `${r.stdout}\n${r.stderr}`;
  const line = out.split("\n").map((l) => l.trim()).find((l) => /^(OK|FAIL)\b/.test(l)) || "";
  const ok = r.code === 0 && /^OK\b/.test(line);
  return {
    ok,
    status: ok ? "up" : r.code === 124 ? "timeout" : line ? "down" : "unknown",
    exitCode: r.code,
    line: deskRedact(line, literalsFrom(pin, env)).slice(0, 300),
  };
}
