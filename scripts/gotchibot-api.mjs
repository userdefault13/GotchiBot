#!/usr/bin/env node
/**
 * Dev helper: start / stop / status for gotchibot-api on the Hub.
 *
 *   gotchibot api start [--bg]
 *   gotchibot api stop
 *   gotchibot api status [--json]
 *
 * Does not install LaunchAgents/systemd — that is hub install (next run).
 */
import { spawn, spawnSync } from "node:child_process";
import {
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
  mkdirSync,
  openSync,
  closeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { isMainModule } from "./is-main.mjs";
import { resolveApiConfig } from "../services/gotchibot-api/config.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_PATH = resolve(ROOT, "services/gotchibot-api/server.mjs");

export const SERVICE_LABEL = "com.gotchibot.hub-api";
export const SYSTEMD_UNIT = "gotchibot-api.service";

export function launchAgentPath(home = homedir()) {
  return resolve(home, "Library/LaunchAgents", `${SERVICE_LABEL}.plist`);
}

export function systemdUnitPath(home = homedir()) {
  return resolve(home, ".config/systemd/user", SYSTEMD_UNIT);
}

function defaultPidFile(env = process.env) {
  return (
    String(env.GOTCHIBOT_API_PIDFILE || "").trim() ||
    resolve(ROOT, "sessions/.gotchibot-api.pid")
  );
}

function defaultLogFile(env = process.env) {
  return (
    String(env.GOTCHIBOT_API_LOG || "").trim() ||
    resolve(ROOT, "sessions/.gotchibot-api.log")
  );
}

/**
 * GET /health — returns parsed JSON or null if unreachable.
 */
export async function healthCheck(port, host = "127.0.0.1") {
  const url = `http://${host}:${port}/health`;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1500);
    const res = await fetch(url, { signal: ac.signal });
    clearTimeout(t);
    const json = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, status: res.status, body: json };
    return json;
  } catch {
    return null;
  }
}

/**
 * Read-only: whether Tailscale serve is configured for this port.
 * @returns {{ available: boolean, configured: boolean|null, detail?: string }}
 */
export function tailscaleServeStatus(port) {
  const r = spawnSync("tailscale", ["serve", "status", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error && r.error.code === "ENOENT") {
    return { available: false, configured: null, detail: "tailscale not installed" };
  }
  if (r.status !== 0) {
    return {
      available: true,
      configured: false,
      detail: String(r.stderr || r.stdout || "tailscale serve status failed").slice(0, 200),
    };
  }
  try {
    const j = JSON.parse(r.stdout || "{}");
    const portStr = String(port);
    // Shape varies by TS version — look for the port anywhere in the JSON text
    const text = JSON.stringify(j);
    const configured =
      text.includes(`:${portStr}`) ||
      text.includes(`"${portStr}"`) ||
      Boolean(j?.TCP?.[portStr] || j?.Web?.[portStr] || j?.Web?.[`http://127.0.0.1:${portStr}`]);
    return { available: true, configured: Boolean(configured) };
  } catch {
    return { available: true, configured: false, detail: "unparseable serve status" };
  }
}

function serviceUnitInstalled() {
  const mac = launchAgentPath();
  const linux = systemdUnitPath();
  return {
    launchAgent: existsSync(mac) ? mac : null,
    systemd: existsSync(linux) ? linux : null,
    installed: existsSync(mac) || existsSync(linux),
  };
}

function readPid(pidfile) {
  try {
    const n = Number(String(readFileSync(pidfile, "utf8")).trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function usage() {
  console.log(`gotchibot-api dev helper (Hub only)

  gotchibot api start [--bg]   foreground (default) or background + pidfile
  gotchibot api stop           stop only a process we started (pidfile)
  gotchibot api status [--json]
`);
}

async function cmdStart(opts) {
  const config = resolveApiConfig();
  const existing = await healthCheck(config.port, "127.0.0.1");
  if (existing?.ok) {
    console.log(
      `gotchibot-api already answering on http://127.0.0.1:${config.port} (db ${existing.db || "?"}) — not starting again.`,
    );
    return 0;
  }

  if (!opts.bg) {
    const child = spawn(process.execPath, [SERVER_PATH], {
      stdio: "inherit",
      env: process.env,
      cwd: ROOT,
    });
    const forward = (sig) => {
      try {
        child.kill(sig);
      } catch {
        /* ignore */
      }
    };
    process.on("SIGINT", () => forward("SIGINT"));
    process.on("SIGTERM", () => forward("SIGTERM"));
    return await new Promise((resolveExit) => {
      child.on("exit", (code, signal) => {
        if (signal) resolveExit(1);
        else resolveExit(code ?? 0);
      });
    });
  }

  // --bg
  const pidfile = defaultPidFile();
  const logfile = defaultLogFile();
  mkdirSync(dirname(pidfile), { recursive: true });
  mkdirSync(dirname(logfile), { recursive: true });
  const outFd = openSync(logfile, "a");
  const child = spawn(process.execPath, [SERVER_PATH], {
    detached: true,
    stdio: ["ignore", outFd, outFd],
    env: process.env,
    cwd: ROOT,
  });
  closeSync(outFd);
  writeFileSync(pidfile, `${child.pid}\n`, { mode: 0o600 });
  child.unref();

  const deadline = Date.now() + 10_000;
  let health = null;
  while (Date.now() < deadline) {
    health = await healthCheck(config.port, "127.0.0.1");
    if (health?.ok) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (health?.ok) {
    console.log(
      `gotchibot-api started in background (pid ${child.pid}) — http://127.0.0.1:${config.port} db=${health.db || "?"}`,
    );
    console.log(`  pidfile ${pidfile}`);
    console.log(`  log     ${logfile}`);
    return 0;
  }
  console.error(
    `started pid ${child.pid} but /health did not answer within 10s — check ${logfile}`,
  );
  return 1;
}

async function cmdStop() {
  const pidfile = defaultPidFile();
  const pid = readPid(pidfile);
  if (!pid) {
    const svc = serviceUnitInstalled();
    if (svc.installed) {
      console.log(
        "No pidfile from `gotchibot api start --bg`. A service unit is installed:",
      );
      if (svc.launchAgent) console.log(`  ${svc.launchAgent}`);
      if (svc.systemd) console.log(`  ${svc.systemd}`);
      console.log(
        "Manage it with: gotchibot hub install --uninstall  (or launchctl/systemctl).",
      );
      console.log("Refusing to kill unknown processes.");
      return 0;
    }
    console.log("No pidfile — nothing for us to stop.");
    return 0;
  }
  if (!pidAlive(pid)) {
    try {
      unlinkSync(pidfile);
    } catch {
      /* ignore */
    }
    console.log(`Stale pidfile (pid ${pid} not alive) — removed.`);
    return 0;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (e) {
    console.error(`Could not signal pid ${pid}: ${e.message || e}`);
    return 1;
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && pidAlive(pid)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (pidAlive(pid)) {
    console.error(`pid ${pid} still alive after SIGTERM (5s) — leaving pidfile.`);
    return 1;
  }
  try {
    unlinkSync(pidfile);
  } catch {
    /* ignore */
  }
  console.log(`Stopped gotchibot-api (was pid ${pid}).`);
  return 0;
}

async function cmdStatus(opts) {
  const config = resolveApiConfig();
  const health = await healthCheck(config.port, "127.0.0.1");
  const pidfile = defaultPidFile();
  const pid = readPid(pidfile);
  const alive = pidAlive(pid);
  const svc = serviceUnitInstalled();
  const serve = tailscaleServeStatus(config.port);
  const out = {
    ok: Boolean(health?.ok),
    port: config.port,
    host: config.host,
    health: health
      ? { ok: health.ok, db: health.db, service: health.service, version: health.version }
      : null,
    pidfile: { path: pidfile, pid, alive },
    serviceUnit: {
      installed: svc.installed,
      launchAgent: svc.launchAgent,
      systemd: svc.systemd,
    },
    tailscaleServe: serve,
  };
  if (opts.json) {
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }
  if (health?.ok) {
    console.log(`health: ok  db=${health.db}  version=${health.version || "?"}`);
  } else {
    console.log("health: down (nothing answering on loopback)");
  }
  console.log(
    `pidfile: ${pid ? `${pid} (${alive ? "alive" : "dead"})` : "none"}`,
  );
  console.log(
    `service unit: ${svc.installed ? "installed" : "not installed"}` +
      (svc.launchAgent ? ` (${svc.launchAgent})` : "") +
      (svc.systemd ? ` (${svc.systemd})` : ""),
  );
  if (!serve.available) {
    console.log("tailscale serve: tailscale not installed / not in PATH");
  } else {
    console.log(
      `tailscale serve port ${config.port}: ${serve.configured ? "configured" : "not configured"}`,
    );
  }
  return 0;
}

async function main(argv = process.argv.slice(2)) {
  const cmd = argv[0] || "help";
  const rest = argv.slice(1);
  const opts = {
    bg: rest.includes("--bg"),
    json: rest.includes("--json"),
  };
  if (cmd === "help" || cmd === "-h" || cmd === "--help") {
    usage();
    return 0;
  }
  if (cmd === "start") return cmdStart(opts);
  if (cmd === "stop") return cmdStop();
  if (cmd === "status") return cmdStatus(opts);
  usage();
  return 2;
}

if (isMainModule(import.meta.url)) {
  main().then((code) => process.exit(code ?? 0)).catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}

export { main, defaultPidFile, defaultLogFile };
