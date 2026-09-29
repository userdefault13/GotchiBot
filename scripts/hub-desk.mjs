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

/** `open` exit codes the desk chat pane uses to pick its local fallback. */
export const OPEN_EXIT = { ok: 0, error: 1, hubDown: 3, noSsh: 4 };
const FOLLOW_POLL_MS = 5_000;
const SSH_TARGET_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/;

/** A follower reattaches only when the Hub moved `current` to another session. */
export function followDecision(attachedSessionId, desk) {
  if (!desk?.sessionId || desk.sessionId === attachedSessionId) return "stay";
  return "reattach";
}

function sshTarget(argv) {
  return flagValue(argv, "--ssh") || process.env.GOTCHIBOT_HUB_SSH || readPrefs().ssh || null;
}

function slugArg(argv) {
  const positional = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--ssh");
  return positional[0] || null;
}

function deskPath(slug) {
  return `/api/gotchibot/projects/${encodeURIComponent(slug)}/desk`;
}

/** Undo whatever a killed TUI left behind (alternate screen, hidden cursor, raw tty). */
function resetTerminal() {
  if (!process.stdout.isTTY) return;
  process.stdout.write("\x1b[?1049l\x1b[?25h\x1b[0m\n");
  spawnSync("stty", ["sane"], { stdio: "inherit" });
}

async function openDesk(argv) {
  const { hubRequest } = await import("./chat-hub-client.mjs");
  const { currentProjectSlug } = await import("./project-context.mjs");
  const slug = slugArg(argv) || currentProjectSlug();
  if (!slug) {
    console.error("which project? gotchibot hub desk open <slug>   (or pick one: gotchibot project use <slug>)");
    return OPEN_EXIT.error;
  }
  const follow = argv.includes("--follow");

  let desk;
  try {
    desk = await hubRequest("GET", deskPath(slug), { query: { session: 1 } });
  } catch (err) {
    console.error(`Hub not reachable: ${String(err?.message || err).split("\n")[0]}`);
    return err?.status && err.status < 500 ? OPEN_EXIT.error : OPEN_EXIT.hubDown;
  }
  if (!desk.sessionId) {
    console.error(desk.sessionError || "the Hub has no desk session for this project yet");
    return OPEN_EXIT.hubDown;
  }

  const local = sameDir(desk.repoDir, ROOT);
  const target = local ? null : sshTarget(argv);
  if (!local && !target) {
    console.error("first time on this machine: gotchibot hub desk ssh <user>@<hub-host>  (remembered after that)");
    return OPEN_EXIT.noSsh;
  }
  if (flagValue(argv, "--ssh")) writePrefs({ ssh: target });

  const attach = () =>
    local
      ? spawn("opencode", ["attach", desk.opencodeUrl, "--session", desk.sessionId, "--dir", desk.repoDir], {
          stdio: "inherit",
        })
      : spawn("ssh", ["-t", target, remoteAttachCommand(desk)], { stdio: "inherit" });

  // Keystrokes belong to the TUI; a stray SIGINT must not kill the follower.
  const ignore = () => {};
  process.on("SIGINT", ignore);
  try {
    for (;;) {
      console.log(`${desk.title} · session ${desk.sessionId}${follow ? " · New session: gotchibot hub desk new" : ""}`);
      const child = attach();
      let switched = false;
      const poll = follow
        ? setInterval(async () => {
            try {
              const now = await hubRequest("GET", deskPath(slug));
              if (followDecision(desk.sessionId, now) === "reattach") {
                switched = true;
                desk = { ...desk, sessionId: now.sessionId, sessionStartedAt: now.sessionStartedAt };
                child.kill("SIGTERM");
              }
            } catch {
              /* Hub blip: keep the current attach */
            }
          }, FOLLOW_POLL_MS)
        : null;
      const code = await new Promise((done) => child.on("exit", (c) => done(c ?? 1)));
      if (poll) clearInterval(poll);
      if (!switched) return code;
      resetTerminal();
      console.log("New session started on another device — switching…");
    }
  } finally {
    process.off("SIGINT", ignore);
  }
}

async function newSession(argv) {
  const { hubRequest } = await import("./chat-hub-client.mjs");
  const { currentProjectSlug } = await import("./project-context.mjs");
  const slug = slugArg(argv) || currentProjectSlug();
  if (!slug) {
    console.error("which project? gotchibot hub desk new <slug>");
    return 1;
  }
  const r = await hubRequest("POST", `${deskPath(slug)}/session`, { body: {} });
  console.log(`new session ${r.sessionId} in ${r.threadId} — attached desks switch within a few seconds`);
  return 0;
}

function sshCommand(argv) {
  const value = argv[0];
  if (!value) {
    console.log(readPrefs().ssh || "(not set) — gotchibot hub desk ssh <user>@<hub-host>");
    return 0;
  }
  if (!SSH_TARGET_RE.test(value)) {
    console.error("expected <user>@<hub-host>, e.g. user_default@imacomarchy");
    return 1;
  }
  writePrefs({ ssh: value });
  console.log(`hub desk ssh target: ${value}`);
  return 0;
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
  // (vault unlock gate, keystore) so both get provider keys the same way.
  const runnerDropins = join(unitDir, "gotchibot-hub-runner.service.d");
  if (existsSync(runnerDropins)) {
    const dest = join(unitDir, "gotchibot-opencode.service.d");
    mkdirSync(dest, { recursive: true });
    for (const f of readdirSync(runnerDropins)) {
      if (f.endsWith(".conf")) copyFileSync(join(runnerDropins, f), join(dest, f));
    }
  }
  systemctl("daemon-reload");
  for (const unit of DESK_UNITS) {
    const r = systemctl("enable", unit);
    if (r.status !== 0) {
      console.error(`${unit}: ${r.stderr.trim()}`);
      return 1;
    }
    // --no-block: the OpenCode unit waits on the abra vault and retries until it is unlocked.
    systemctl("restart", "--no-block", unit);
  }
  console.log(`desk services enabled: OpenCode on 127.0.0.1:${vars.PORT}, desk runner`);
  console.log("check: gotchibot hub desk service status");
  return 0;
}

function usage() {
  console.error(`usage:
  gotchibot hub desk open [slug] [--ssh user@host] [--follow]  attach this terminal to the project's chat
                                                        (--follow: move along when a New session starts)
  gotchibot hub desk new [slug]                         New session in the project's chat (fresh context)
  gotchibot hub desk ssh [user@host]                    show / save the Hub SSH target for this machine
  gotchibot hub desk run [--once]                       desk runner (Hub)
  gotchibot hub desk service install|uninstall|status   Hub services (Linux)`);
}

async function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  if (cmd === "open") return openDesk(rest);
  if (cmd === "new") return newSession(rest);
  if (cmd === "ssh") return sshCommand(rest);
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
