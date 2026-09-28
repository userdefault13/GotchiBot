#!/usr/bin/env node
/**
 * Project desks on the Hub — one orchestrator conversation per project, the
 * same on the phone and on every terminal.
 *
 *   gotchibot hub desk open [slug] [--ssh user@host]   attach this terminal to the project's desk
 *   gotchibot hub desk run [--once]                    desk runner (Hub; the systemd unit runs this)
 *   gotchibot hub desk service install|uninstall|status  Hub services (Linux): OpenCode server + desk runner
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SYSTEMD_TEMPLATES = join(ROOT, "services/gotchibot-api/systemd");
const PREFS = join(ROOT, "sessions/.hub-desk.json");
export const DESK_UNITS = ["gotchibot-opencode.service", "gotchibot-desk-runner.service"];
const DEFAULT_PORT = 4096;

function readPrefs() {
  try {
    return JSON.parse(readFileSync(PREFS, "utf8"));
  } catch {
    return {};
  }
}

function writePrefs(patch) {
  mkdirSync(dirname(PREFS), { recursive: true });
  writeFileSync(PREFS, `${JSON.stringify({ ...readPrefs(), ...patch }, null, 2)}\n`);
}

function flagValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function sameDir(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Remote shell line that attaches to the desk session on the Hub. */
export function remoteAttachCommand({ repoDir, opencodeUrl, sessionId }) {
  const bin = `"$(command -v opencode || echo "$HOME/.local/bin/opencode")"`;
  return `cd ${shellQuote(repoDir)} && exec ${bin} attach ${shellQuote(opencodeUrl)} --session ${shellQuote(sessionId)} --dir ${shellQuote(repoDir)}`;
}

async function openDesk(argv) {
  const { hubRequest } = await import("./chat-hub-client.mjs");
  const { currentProjectSlug } = await import("./project-context.mjs");
  const positional = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--ssh");
  const slug = positional[0] || currentProjectSlug();
  if (!slug) {
    console.error("which project? gotchibot hub desk open <slug>   (or pick one: gotchibot project use <slug>)");
    return 1;
  }
  const desk = await hubRequest("GET", `/api/gotchibot/projects/${encodeURIComponent(slug)}/desk`, {
    query: { session: 1 },
  });
  if (!desk.sessionId) {
    console.error(desk.sessionError || "the Hub has no desk session for this project yet");
    return 1;
  }
  console.log(`${desk.title} · thread ${desk.threadId} · session ${desk.sessionId}`);

  if (sameDir(desk.repoDir, ROOT)) {
    const r = spawnSync(
      "opencode",
      ["attach", desk.opencodeUrl, "--session", desk.sessionId, "--dir", desk.repoDir],
      { stdio: "inherit" },
    );
    return r.status ?? 1;
  }

  const target = flagValue(argv, "--ssh") || process.env.GOTCHIBOT_HUB_SSH || readPrefs().ssh;
  if (!target) {
    console.error("first time on this machine: gotchibot hub desk open --ssh <user>@<hub-host>  (remembered after that)");
    return 1;
  }
  if (flagValue(argv, "--ssh")) writePrefs({ ssh: target });
  const child = spawn("ssh", ["-t", target, remoteAttachCommand(desk)], { stdio: "inherit" });
  return new Promise((done) => child.on("exit", (code) => done(code ?? 1)));
}

async function runDesk(argv) {
  const { resolveApiConfig } = await import("../services/gotchibot-api/config.mjs");
  const { connectStore } = await import("../services/gotchibot-api/store.mjs");
  const { createDeskRunner, createOpencodeClient } = await import("../services/gotchibot-api/desk-runner.mjs");
  const { orchestratorHeroId } = await import("./openclaw-fleet.mjs");

  const config = resolveApiConfig(process.env);
  const store = await connectStore({ mongoUri: config.mongoUri, dbName: config.dbName });
  await store.ensureIndexes();
  const client = createOpencodeClient({
    baseUrl: config.opencodeUrl,
    directory: ROOT,
    password: process.env.OPENCODE_SERVER_PASSWORD || null,
  });
  const runner = createDeskRunner({
    store,
    client,
    agent: process.env.GOTCHIBOT_DESK_AGENT || undefined,
    orchestratorHeroId: () => {
      try {
        return orchestratorHeroId();
      } catch {
        return null;
      }
    },
  });

  const shutdown = async () => {
    await runner.stop();
    await store.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (argv.includes("--once")) {
    await runner.tick();
    await shutdown();
    return 0;
  }
  runner.start();
  return null;
}

function which(bin, extraDirs = []) {
  for (const dir of extraDirs) {
    const p = join(dir, bin);
    if (existsSync(p)) return p;
  }
  const r = spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function renderDeskUnit(template, vars) {
  return template.replace(/@([A-Z_]+)@/g, (m, key) => (vars[key] != null ? String(vars[key]) : m));
}

function systemctl(...args) {
  return spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
}

function serviceCommand(action) {
  if (platform() !== "linux") {
    console.error("desk services run on the Linux Hub — run this there (or: gotchibot remote -- gotchibot hub desk service …)");
    return 1;
  }
  const unitDir = join(homedir(), ".config/systemd/user");

  if (action === "status") {
    for (const unit of DESK_UNITS) {
      const r = systemctl("is-active", unit);
      console.log(`${unit}: ${r.stdout.trim() || "unknown"}`);
    }
    return 0;
  }

  if (action === "uninstall") {
    for (const unit of [...DESK_UNITS].reverse()) {
      systemctl("disable", "--now", unit);
      rmSync(join(unitDir, unit), { force: true });
      rmSync(join(unitDir, `${unit}.d`), { recursive: true, force: true });
    }
    systemctl("daemon-reload");
    console.log("desk services removed");
    return 0;
  }

  if (action !== "install") {
    console.error("usage: gotchibot hub desk service install|uninstall|status");
    return 1;
  }
  const home = homedir();
  const nodeDir = dirname(process.execPath);
  const abra = which("abra", [nodeDir, join(home, ".local/bin")]);
  const opencode = which("opencode", [join(home, ".local/bin"), join(home, ".opencode/bin")]);
  if (!abra || !opencode) {
    console.error(`missing ${!abra ? "abra" : "opencode"} on this Hub — install it first, then rerun`);
    return 1;
  }
  const vars = {
    REPO: ROOT,
    HOME: home,
    NODE: process.execPath,
    NODE_DIR: nodeDir,
    ABRA: abra,
    OPENCODE: opencode,
    PORT: Number(process.env.GOTCHIBOT_OPENCODE_PORT) || DEFAULT_PORT,
  };
  mkdirSync(unitDir, { recursive: true });
  for (const unit of DESK_UNITS) {
    const body = renderDeskUnit(readFileSync(join(SYSTEMD_TEMPLATES, unit), "utf8"), vars);
    writeFileSync(join(unitDir, unit), body);
  }
  // The OpenCode server runs under abra like the phone runner: reuse its drop-ins
  // (abra agent wait, keystore) so both get provider keys the same way.
  const runnerDropins = join(unitDir, "gotchibot-hub-runner.service.d");
  if (existsSync(runnerDropins)) {
    const dest = join(unitDir, "gotchibot-opencode.service.d");
    mkdirSync(dest, { recursive: true });
    for (const f of readdirSync(runnerDropins)) copyFileSync(join(runnerDropins, f), join(dest, f));
  }
  systemctl("daemon-reload");
  for (const unit of DESK_UNITS) {
    const r = systemctl("enable", "--now", unit);
    if (r.status !== 0) {
      console.error(`${unit}: ${r.stderr.trim()}`);
      return 1;
    }
  }
  console.log(`desk services running: OpenCode on 127.0.0.1:${vars.PORT}, desk runner`);
  return 0;
}

function usage() {
  console.error(`usage:
  gotchibot hub desk open [slug] [--ssh user@host]      attach this terminal to the project's desk
  gotchibot hub desk run [--once]                       desk runner (Hub)
  gotchibot hub desk service install|uninstall|status   Hub services (Linux)`);
}

async function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  if (cmd === "open") return openDesk(rest);
  if (cmd === "run") return runDesk(rest);
  if (cmd === "service") return serviceCommand(rest[0]);
  usage();
  return cmd === "-h" || cmd === "--help" ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  main().then(
    (code) => {
      if (code != null) process.exit(code);
    },
    (err) => {
      console.error(String(err?.message || err).replace(/gbd_[A-Za-z0-9_-]+/g, "gbd_***"));
      process.exit(1);
    },
  );
}

export { main };
