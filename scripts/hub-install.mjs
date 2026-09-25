#!/usr/bin/env node
/**
 * Hub install wizard — set up THIS computer as the always-on Hub.
 *
 *   gotchibot hub install [--dry-run] [--yes] [--name NAME] [--no-tailscale]
 *   gotchibot hub uninstall [--dry-run]
 *   gotchibot hub install --uninstall   (alias)
 *
 * Chat bodies stay in local Mongo. Arcade only gets metadata (kind / host).
 * ABSOLUTE: never run launchctl/systemctl/tailscale serve without --dry-run
 * when testing; production use is intentional.
 */
import { spawnSync } from "node:child_process";
import {
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface as createReadline } from "node:readline";
import { homedir } from "node:os";
import { MongoClient } from "mongodb";
import { isMainModule } from "./is-main.mjs";
import {
  SERVICE_LABEL,
  SYSTEMD_UNIT,
  launchAgentPath,
  systemdUnitPath,
  healthCheck,
} from "./gotchibot-api.mjs";
import {
  HUB_CONFIG_DEFAULT_PATH,
  readHubApiConfig,
  writeHubApiConfig,
} from "../services/gotchibot-api/config.mjs";
import { connectStore } from "../services/gotchibot-api/store.mjs";
import { hasInstallToken } from "./infra-client.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_PATH = resolve(ROOT, "services/gotchibot-api/server.mjs");
const COMPOSE_FILE = resolve(ROOT, "docker/chat-mongo/docker-compose.yml");
const DEFAULT_MONGO_URI = "mongodb://127.0.0.1:27017";
const DEFAULT_DB = "GotchiBot";
const DEFAULT_PORT = 8793;

const MAC_LOG = resolve(homedir(), "Library/Logs/gotchibot-api.log");

// ─── pure helpers (unit-tested) ──────────────────────────────────────────────

export function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * @param {{
 *   label?: string,
 *   nodePath: string,
 *   serverPath: string,
 *   workingDirectory: string,
 *   home: string,
 *   configPath: string,
 *   pathEnv?: string,
 *   stdoutPath?: string,
 *   stderrPath?: string,
 * }} opts
 */
export function renderLaunchAgentPlist(opts) {
  const label = opts.label || SERVICE_LABEL;
  const pathEnv =
    opts.pathEnv ||
    `${dirname(opts.nodePath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  const out = opts.stdoutPath || MAC_LOG;
  const err = opts.stderrPath || MAC_LOG;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${xmlEscape(label)}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>${xmlEscape(opts.nodePath)}</string>
\t\t<string>${xmlEscape(opts.serverPath)}</string>
\t</array>
\t<key>WorkingDirectory</key>
\t<string>${xmlEscape(opts.workingDirectory)}</string>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>${xmlEscape(pathEnv)}</string>
\t\t<key>HOME</key>
\t\t<string>${xmlEscape(opts.home)}</string>
\t\t<key>GOTCHIBOT_HUB_CONFIG</key>
\t\t<string>${xmlEscape(opts.configPath)}</string>
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>StandardOutPath</key>
\t<string>${xmlEscape(out)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xmlEscape(err)}</string>
</dict>
</plist>
`;
}

/**
 * @param {{
 *   nodePath: string,
 *   serverPath: string,
 *   workingDirectory: string,
 *   configPath: string,
 *   description?: string,
 * }} opts
 */
export function renderSystemdUnit(opts) {
  const desc = opts.description || "GotchiBot Hub API (gotchibot-api)";
  return `[Unit]
Description=${desc}
After=network-online.target

[Service]
ExecStart=${opts.nodePath} ${opts.serverPath}
WorkingDirectory=${opts.workingDirectory}
Environment=GOTCHIBOT_HUB_CONFIG=${opts.configPath}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;
}

/**
 * @param {Record<string, unknown>} json
 * @returns {{ running: boolean, dnsName: string|null, ownerLogin: string|null }}
 */
export function parseTailscaleStatus(json) {
  const j = json && typeof json === "object" ? json : {};
  const running = j.BackendState === "Running";
  let dnsName = null;
  if (j.Self?.DNSName) {
    dnsName = String(j.Self.DNSName).replace(/\.$/, "");
  }
  let ownerLogin = null;
  const uid = j.Self?.UserID;
  if (uid != null && j.User && typeof j.User === "object") {
    const u = j.User[String(uid)];
    if (u?.LoginName) ownerLogin = String(u.LoginName).trim();
  }
  return { running: Boolean(running), dnsName, ownerLogin };
}

/**
 * @param {Record<string, unknown>} statusJson
 * @param {number|string} port
 * @returns {{ present: boolean, target: string|null, funnel: boolean }}
 */
export function findServeHandler(statusJson, port) {
  const j = statusJson && typeof statusJson === "object" ? statusJson : {};
  const portStr = String(port);
  let present = false;
  let target = null;
  let funnel = false;

  const web = j.Web && typeof j.Web === "object" ? j.Web : {};
  for (const [key, val] of Object.entries(web)) {
    const hit =
      key === portStr ||
      key.endsWith(`:${portStr}`) ||
      key.includes(`:${portStr}/`) ||
      key.includes(`:${portStr}`);
    if (!hit) continue;
    present = true;
    const handlers = val && typeof val === "object" ? val.Handlers : null;
    const root = handlers && typeof handlers === "object" ? handlers["/"] : null;
    const proxy =
      root && typeof root === "object"
        ? root.Proxy || root.proxy || null
        : null;
    if (proxy) target = String(proxy);
  }

  const tcp = j.TCP && typeof j.TCP === "object" ? j.TCP : {};
  if (tcp[portStr]) present = true;

  const af = j.AllowFunnel && typeof j.AllowFunnel === "object" ? j.AllowFunnel : {};
  for (const [key, val] of Object.entries(af)) {
    if ((key === portStr || key.endsWith(`:${portStr}`)) && val) {
      funnel = true;
    }
  }

  return { present, target, funnel };
}

// ─── CLI / wizard ────────────────────────────────────────────────────────────

function parseFlags(argv) {
  const out = {
    _: [],
    dryRun: false,
    yes: false,
    noTailscale: false,
    uninstallFlag: false,
    name: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--no-tailscale") out.noTailscale = true;
    else if (a === "--uninstall") out.uninstallFlag = true;
    else if (a === "--name") out.name = argv[++i];
    else if (a === "-h" || a === "--help" || a === "help") out.help = true;
    else out._.push(a);
  }
  return out;
}

function usage() {
  console.log(`Set up THIS computer as your Hub (always-on chat API).

  gotchibot hub install [--dry-run] [--yes] [--name NAME] [--no-tailscale]
  gotchibot hub uninstall [--dry-run]

Your chats stay on this computer's database. Other computers reach it over
Tailscale (a private network that lets your other computers find this one).
`);
}

function say(msg) {
  console.log(msg);
}

function indent(text, prefix = "    ") {
  return String(text)
    .split("\n")
    .map((line) => (line.length ? prefix + line : prefix.trimEnd()))
    .join("\n");
}

function ask(rl, q) {
  return new Promise((resolveAsk) => rl.question(q, resolveAsk));
}

async function promptYesNo(opts, question, defaultNo = true) {
  if (opts.yes) return !defaultNo ? true : false;
  if (opts.dryRun) return !defaultNo ? true : false;
  const rl = createReadline({ input: process.stdin, output: process.stdout });
  const hint = defaultNo ? "y/N" : "Y/n";
  const ans = (await ask(rl, `${question} [${hint}]: `)).trim().toLowerCase();
  rl.close();
  if (!ans) return !defaultNo;
  return ans === "y" || ans === "yes";
}

function requireInteractiveOrFlags(opts) {
  if (opts.dryRun || opts.yes) return;
  if (process.stdin.isTTY) return;
  console.error(
    "This setup asks a few questions. Re-run with --yes to accept defaults, or --dry-run to preview.",
  );
  process.exit(2);
}

function configPath() {
  return process.env.GOTCHIBOT_HUB_CONFIG || HUB_CONFIG_DEFAULT_PATH;
}

function resolveDbName() {
  if (process.env.MONGO_DB_NAME) return String(process.env.MONGO_DB_NAME).trim() || DEFAULT_DB;
  const existing = readHubApiConfig(configPath());
  if (existing?.dbName) return String(existing.dbName).trim() || DEFAULT_DB;
  return DEFAULT_DB;
}

function resolvePort() {
  const raw = process.env.GOTCHIBOT_API_PORT;
  if (raw != null && String(raw).trim()) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0 && n <= 65535) return n;
  }
  const existing = readHubApiConfig(configPath());
  if (existing?.port != null) {
    const n = Number(existing.port);
    if (Number.isFinite(n) && n > 0 && n <= 65535) return n;
  }
  return DEFAULT_PORT;
}

async function probeMongo(uri = DEFAULT_MONGO_URI) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 1500 });
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    return true;
  } catch {
    return false;
  } finally {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
  }
}

function dockerInfoOk() {
  const r = spawnSync("docker", ["info"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return r.status === 0;
}

function readTailscaleStatusJson() {
  const r = spawnSync("tailscale", ["status", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error && r.error.code === "ENOENT") {
    return { ok: false, missing: true, json: null };
  }
  if (r.status !== 0) {
    return {
      ok: false,
      missing: false,
      json: null,
      err: String(r.stderr || r.stdout || "").slice(0, 200),
    };
  }
  try {
    return { ok: true, missing: false, json: JSON.parse(r.stdout || "{}") };
  } catch {
    return { ok: false, missing: false, json: null, err: "unparseable" };
  }
}

function readServeStatusJson() {
  const r = spawnSync("tailscale", ["serve", "status", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error && r.error.code === "ENOENT") {
    return { ok: false, missing: true, json: {} };
  }
  if (r.status !== 0) {
    // empty config often exits 0 with {}; treat failure as empty
    try {
      return { ok: true, missing: false, json: JSON.parse(r.stdout || "{}") };
    } catch {
      return { ok: false, missing: false, json: {}, err: String(r.stderr || "").slice(0, 200) };
    }
  }
  try {
    return { ok: true, missing: false, json: JSON.parse(r.stdout || "{}") };
  } catch {
    return { ok: true, missing: false, json: {} };
  }
}

function ourUnitExists() {
  return existsSync(launchAgentPath()) || existsSync(systemdUnitPath());
}

function platformKind() {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") {
    const which = spawnSync("systemctl", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (which.status === 0 || which.status === 1) return "linux";
    return "other";
  }
  return "other";
}

function writeFileIfChanged(path, content, { dryRun, mode = 0o600 } = {}) {
  const next = content.endsWith("\n") ? content : `${content}\n`;
  let prev = null;
  if (existsSync(path)) {
    try {
      prev = readFileSync(path, "utf8");
    } catch {
      prev = null;
    }
  }
  if (prev === next) {
    return { wrote: false, path };
  }
  if (dryRun) {
    return { wrote: true, path, dryRun: true };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next, { mode });
  try {
    chmodSync(path, mode);
  } catch {
    /* best-effort */
  }
  return { wrote: true, path };
}

function expectedServeTarget(port) {
  return `http://127.0.0.1:${port}`;
}

async function waitForHealth(port, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const h = await healthCheck(port, "127.0.0.1");
    if (h?.ok) return h;
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

async function cmdInstall(opts) {
  requireInteractiveOrFlags(opts);
  const dry = opts.dryRun;
  const changes = [];
  const port = resolvePort();
  const dbName = resolveDbName();
  const cfgPath = configPath();
  let loopbackOnly = Boolean(opts.noTailscale);
  let ownerLogin = null;
  let dnsName = null;

  say("");
  say("GotchiBot Hub setup");
  say("This computer will keep your chats and run a small local API.");
  say("Other computers reach it over Tailscale (a private network).");
  say("");

  // ── Step 1: Node ─────────────────────────────────────────────────────────
  say("Step 1 of 8: Check Node.js");
  const nodeVer = process.versions.node;
  const major = Number(String(nodeVer).split(".")[0]);
  if (!Number.isFinite(major) || major < 18) {
    say(`  Node ${nodeVer} is too old. GotchiBot needs Node 18 or newer.`);
    say("  Update: https://nodejs.org/  (or: brew install node)");
    return 1;
  }
  say(`  Node ${nodeVer} — ok.`);
  if (dry) say(`[dry run] I would keep using ${process.execPath}`);

  // ── Step 2: Mongo ────────────────────────────────────────────────────────
  say("");
  say("Step 2 of 8: Database (MongoDB)");
  say("  MongoDB is the database that stores your chat messages on this computer.");
  let mongoOk = await probeMongo(DEFAULT_MONGO_URI);
  if (mongoOk) {
    say(
      `  You already have a database running here. We'll keep GotchiBot's chats in their own database named ${dbName}.`,
    );
  } else if (dockerInfoOk()) {
    say("  No database answered on 127.0.0.1:27017.");
    say("  Docker is available. We can start a small local Mongo for GotchiBot.");
    if (dry) {
      say(
        `[dry run] I would run: docker compose -f ${COMPOSE_FILE} up -d`,
      );
      say(`[dry run] I would then re-check mongodb://127.0.0.1:27017`);
    } else {
      const go = await promptYesNo(
        opts,
        "Start local Mongo with Docker now?",
        false,
      );
      if (!go) {
        say("  Stopped. Start Mongo yourself, then re-run: gotchibot hub install");
        return 1;
      }
      mkdirSync(dirname(COMPOSE_FILE), { recursive: true });
      if (!existsSync(COMPOSE_FILE)) {
        writeFileSync(
          COMPOSE_FILE,
          `# GotchiBot BYO chat Mongo — bind 127.0.0.1 only (Hub Mac).
services:
  gotchibot-chat-mongo:
    image: mongo:7
    container_name: gotchibot-chat-mongo
    restart: unless-stopped
    ports:
      - "127.0.0.1:27017:27017"
    volumes:
      - gotchibot_chat_mongo_data:/data/db
volumes:
  gotchibot_chat_mongo_data:
`,
        );
        changes.push(`wrote ${COMPOSE_FILE}`);
      }
      const up = spawnSync(
        "docker",
        ["compose", "-f", COMPOSE_FILE, "up", "-d"],
        { cwd: dirname(COMPOSE_FILE), encoding: "utf8", stdio: "inherit" },
      );
      if (up.status !== 0) {
        say("  Docker compose failed. Fix Docker, then re-run.");
        return 1;
      }
      changes.push("started docker/chat-mongo");
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        mongoOk = await probeMongo(DEFAULT_MONGO_URI);
        if (mongoOk) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!mongoOk) {
        say("  Mongo did not answer within 20s after Docker start.");
        return 1;
      }
      say(`  Mongo is up. Chats go in database ${dbName}.`);
    }
  } else {
    say("  No database on 127.0.0.1:27017, and Docker is not available.");
    if (process.platform === "darwin") {
      say("  On macOS you can install Mongo with Homebrew:");
      say("    brew tap mongodb/brew && brew install mongodb-community");
      say("    brew services start mongodb-community");
    } else {
      say("  On Linux: install Docker and re-run, or install Mongo from your distro.");
    }
    say("  Then re-run: gotchibot hub install");
    return 1;
  }

  // ── Step 3: Tailscale (read-only) ────────────────────────────────────────
  say("");
  say("Step 3 of 8: Tailscale (private network)");
  const ts = readTailscaleStatusJson();
  if (ts.missing) {
    say("  Tailscale is not installed (or not in PATH).");
    say("  Tailscale is the private network that lets your other computers find this one.");
    if (opts.noTailscale || dry) {
      loopbackOnly = true;
      say(
        dry
          ? "[dry run] I would continue in loopback-only mode (desks on other computers can't reach it yet)."
          : "  Continuing in loopback-only mode (--no-tailscale).",
      );
    } else {
      const cont = await promptYesNo(
        opts,
        "Continue in loopback-only mode (this computer only)?",
        true,
      );
      if (!cont) {
        say("  Install Tailscale from https://tailscale.com/download then re-run.");
        return 1;
      }
      loopbackOnly = true;
    }
  } else if (!ts.ok || !ts.json) {
    say(`  Could not read Tailscale status${ts.err ? `: ${ts.err}` : "."}`);
    if (opts.noTailscale) {
      loopbackOnly = true;
      say("  Continuing in loopback-only mode (--no-tailscale).");
    } else if (dry) {
      loopbackOnly = true;
      say("[dry run] I would ask to continue loopback-only or stop.");
    } else {
      const cont = await promptYesNo(
        opts,
        "Continue in loopback-only mode?",
        true,
      );
      if (!cont) return 1;
      loopbackOnly = true;
    }
  } else {
    const parsed = parseTailscaleStatus(ts.json);
    if (!parsed.running) {
      say(`  Tailscale is installed but not Running (state: ${ts.json.BackendState || "?"}).`);
      say("  Open the Tailscale app and sign in, then re-run.");
      if (opts.noTailscale || dry) {
        loopbackOnly = true;
        say(
          dry
            ? "[dry run] I would continue loopback-only."
            : "  Continuing loopback-only (--no-tailscale).",
        );
      } else {
        const cont = await promptYesNo(
          opts,
          "Continue in loopback-only mode?",
          true,
        );
        if (!cont) return 1;
        loopbackOnly = true;
      }
    } else {
      dnsName = parsed.dnsName;
      ownerLogin = parsed.ownerLogin;
      say(`  Tailscale is Running.`);
      if (dnsName) say(`  MagicDNS name: ${dnsName}`);
      if (ownerLogin) say(`  Owner login:   ${ownerLogin}`);
      else say("  (Could not read login name from Tailscale status.)");
      if (opts.noTailscale) {
        loopbackOnly = true;
        say("  --no-tailscale set: staying loopback-only (no serve).");
      }
    }
  }

  // ── Step 4: Hub config ───────────────────────────────────────────────────
  say("");
  say("Step 4 of 8: Write Hub config");
  const existing = readHubApiConfig(cfgPath) || {};
  const now = new Date().toISOString();
  const nextCfg = {
    ...existing,
    ownerLogin: ownerLogin || existing.ownerLogin || null,
    host: "127.0.0.1",
    port,
    dbName,
    mongoUri: DEFAULT_MONGO_URI,
    tailscaleHost: dnsName || existing.tailscaleHost || null,
    installedAt: existing.installedAt || now,
    updatedAt: now,
  };
  if (ownerLogin) {
    say(`  Owner Tailscale login: ${ownerLogin}`);
    say(
      "  Only this Tailscale account can use the Hub from other computers.",
    );
  } else if (loopbackOnly) {
    say("  Loopback-only: no owner login yet (remote desks blocked until Tailscale is up).");
  }
  if (dry) {
    say(`[dry run] I would write ${cfgPath} (mode 0600):`);
    say(indent(JSON.stringify(nextCfg, null, 2)));
  } else {
    writeHubApiConfig(nextCfg, cfgPath);
    try {
      chmodSync(cfgPath, 0o600);
    } catch {
      /* ignore */
    }
    changes.push(`wrote ${cfgPath}`);
    say(`  Wrote ${cfgPath}`);
  }

  // ── Step 5: Service unit ─────────────────────────────────────────────────
  say("");
  say("Step 5 of 8: Start the Hub API by itself");
  const healthBefore = await healthCheck(port, "127.0.0.1");
  if (healthBefore?.ok && !ourUnitExists()) {
    say(
      `  Something already answers http://127.0.0.1:${port}/health, but our service file is missing.`,
    );
    say("  Stop that process first, or free the port, then re-run. Refusing to fight it.");
    return 1;
  }

  const plat = platformKind();
  const nodePath = process.execPath;
  const home = homedir();

  if (plat === "macos") {
    const plistPath = launchAgentPath();
    const plist = renderLaunchAgentPlist({
      nodePath,
      serverPath: SERVER_PATH,
      workingDirectory: ROOT,
      home,
      configPath: cfgPath,
      stdoutPath: MAC_LOG,
      stderrPath: MAC_LOG,
    });
    if (dry) {
      say(`[dry run] I would write ${plistPath}:`);
      say(indent(plist));
      say(
        `[dry run] I would run: launchctl bootout gui/${process.getuid?.() ?? "?"}/${SERVICE_LABEL} (ignore fail)`,
      );
      say(
        `[dry run] I would run: launchctl bootstrap gui/${process.getuid?.() ?? "?"} ${plistPath}`,
      );
      say(`[dry run] (or kickstart -k if already loaded and unchanged)`);
    } else {
      const uid = process.getuid();
      const domain = `gui/${uid}`;
      const target = `${domain}/${SERVICE_LABEL}`;
      const result = writeFileIfChanged(plistPath, plist, { dryRun: false, mode: 0o644 });
      if (result.wrote) changes.push(`wrote ${plistPath}`);

      const print = spawnSync("launchctl", ["print", target], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const loaded = print.status === 0;

      if (!result.wrote && loaded) {
        spawnSync("launchctl", ["kickstart", "-k", target], {
          encoding: "utf8",
          stdio: "inherit",
        });
        changes.push(`kickstart ${target}`);
        say(`  Restarted existing LaunchAgent (${SERVICE_LABEL}).`);
      } else {
        spawnSync("launchctl", ["bootout", target], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        const boot = spawnSync("launchctl", ["bootstrap", domain, plistPath], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        if (boot.status !== 0) {
          say(`  launchctl bootstrap failed: ${String(boot.stderr || boot.stdout).slice(0, 300)}`);
          return 1;
        }
        changes.push(`bootstrap ${target}`);
        say(`  Installed LaunchAgent at ${plistPath}`);
        say(`  Logs: ${MAC_LOG}`);
      }
    }
  } else if (plat === "linux") {
    const unitPath = systemdUnitPath();
    const unit = renderSystemdUnit({
      nodePath,
      serverPath: SERVER_PATH,
      workingDirectory: ROOT,
      configPath: cfgPath,
    });
    if (dry) {
      say(`[dry run] I would write ${unitPath}:`);
      say(indent(unit));
      say(`[dry run] I would run: systemctl --user daemon-reload`);
      say(`[dry run] I would run: systemctl --user enable --now ${SYSTEMD_UNIT}`);
      say(`[dry run] I would run: loginctl enable-linger $USER`);
    } else {
      writeFileIfChanged(unitPath, unit, { dryRun: false, mode: 0o644 });
      changes.push(`wrote ${unitPath}`);
      spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
      const en = spawnSync(
        "systemctl",
        ["--user", "enable", "--now", SYSTEMD_UNIT],
        { encoding: "utf8", stdio: "inherit" },
      );
      if (en.status !== 0) {
        say("  systemctl enable --now failed.");
        return 1;
      }
      changes.push(`enabled ${SYSTEMD_UNIT}`);
      say(
        "  Linger keeps the Hub running after you log out of this machine.",
      );
      const linger = spawnSync("loginctl", ["enable-linger", process.env.USER || ""], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (linger.status !== 0) {
        say("  Could not enable linger automatically. Run with sudo:");
        say(`    sudo loginctl enable-linger ${process.env.USER || "$USER"}`);
      } else {
        changes.push("enable-linger");
      }
    }
  } else {
    say("  This OS has no LaunchAgent/systemd helper here.");
    say("  Start the API yourself:");
    say("    gotchibot api start --bg");
    if (dry) say("[dry run] I would skip service install on this platform.");
  }

  // ── Step 6: Health wait ──────────────────────────────────────────────────
  say("");
  say("Step 6 of 8: Wait for health check");
  if (dry) {
    const h = await healthCheck(port, "127.0.0.1");
    say(
      `[dry run] I would wait up to 15s for http://127.0.0.1:${port}/health` +
        (h?.ok ? ` (already ok, db=${h.db})` : " (currently down)"),
    );
  } else if (plat === "other") {
    say("  Skipped auto-start — run `gotchibot api start --bg` then re-check.");
  } else {
    const h = await waitForHealth(port, 15_000);
    if (!h?.ok) {
      say(`  Health check failed for http://127.0.0.1:${port}/health`);
      if (plat === "macos") say(`  Check the log: ${MAC_LOG}`);
      else say(`  Check: journalctl --user -u ${SYSTEMD_UNIT} -n 50`);
      return 1;
    }
    say(`  Health ok (db=${h.db}, version=${h.version || "?"}).`);
  }

  // ── Step 7: tailscale serve ─────────────────────────────────────────────
  say("");
  say("Step 7 of 8: Tailscale serve (tailnet only — never public funnel)");
  if (loopbackOnly) {
    say("  Skipped (loopback-only mode). Desks on other computers can't reach this Hub yet.");
  } else {
    const serve = readServeStatusJson();
    const handler = findServeHandler(serve.json || {}, port);
    const want = expectedServeTarget(port);
    if (handler.present && handler.target === want) {
      say(`  Serve already proxies :${port} → ${want}. Skipping.`);
    } else if (handler.present && handler.target && handler.target !== want) {
      say(
        `  Port ${port} already serves something else (${handler.target}). Stop that first.`,
      );
      say(`  Then re-run, or free the port: tailscale serve --http=${port} off`);
      return 1;
    } else if (handler.present && !handler.target) {
      // TCP/HTTP flag without clear proxy — be careful
      say(
        `  Port ${port} appears in serve status without a clear proxy target. Inspect with:`,
      );
      say("    tailscale serve status");
      return 1;
    } else if (dry) {
      say(
        `[dry run] I would run: tailscale serve --bg --http=${port} ${want}`,
      );
      say(
        `[dry run] I would re-check AllowFunnel and warn if :${port} is funneled`,
      );
    } else {
      const r = spawnSync(
        "tailscale",
        ["serve", "--bg", `--http=${port}`, want],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      if (r.status !== 0) {
        say(`  tailscale serve failed: ${String(r.stderr || r.stdout).slice(0, 300)}`);
        return 1;
      }
      changes.push(`tailscale serve --http=${port}`);
      say(`  Serve: :${port} → ${want} (tailnet only).`);
    }

    // Funnel check (read-only warn)
    const after = dry ? serve : readServeStatusJson();
    const again = findServeHandler(after.json || {}, port);
    if (again.funnel) {
      say("");
      say("  WARNING: AllowFunnel is ON for this port. That would expose the Hub publicly.");
      say("  Turn funnel OFF (we never turn funnel ON):");
      say(`    tailscale funnel --http=${port} off`);
    }
  }

  // ── Step 8: First pairing code ───────────────────────────────────────────
  say("");
  say("Step 8 of 8: Pairing code for your first desk");
  if (dry) {
    say(
      "[dry run] I would connect to Mongo, list desks, and mint a pairing code only if none exist.",
    );
    say(
      `[dry run] Join hint would look like: gotchibot hub join ${dnsName || "<MagicDNS>"} <CODE>`,
    );
  } else {
    try {
      const store = await connectStore({
        mongoUri: DEFAULT_MONGO_URI,
        dbName,
      });
      try {
        await store.ensureIndexes();
        const desks = await store.listDesks();
        const active = desks.filter((d) => !d.revokedAt);
        if (active.length === 0) {
          const name = opts.name || "first desk";
          const { code, expiresAt } = await store.mintPairingCode({ name });
          const host = dnsName || "<MagicDNS>";
          say("");
          say("  ┌──────────────────────────────────────────────────────────");
          say(`  │  On your desk computer, run:`);
          say(`  │`);
          say(`  │    gotchibot hub join ${host} ${code}`);
          say(`  │`);
          say(`  │  (works once, for 15 minutes — until ${expiresAt.toLocaleString()})`);
          say("  └──────────────────────────────────────────────────────────");
          say("");
          changes.push("minted first pairing code");
        } else {
          say(`  You already have ${active.length} paired desk(s).`);
          say("  Make a new code anytime: gotchibot hub pair");
        }
      } finally {
        await store.close();
      }
    } catch (e) {
      say(`  Could not mint pairing code: ${e.message || e}`);
      say("  Later: gotchibot hub pair");
    }
  }

  // ── Arcade metadata (optional) ───────────────────────────────────────────
  say("");
  say("Arcade metadata (optional — never sends chats)");
  if (dry) {
    say(
      "[dry run] I would publish chatStore kind=local only if GOTCHIBOT_INFRA_TOKEN is set.",
    );
    if (dnsName) {
      say(`[dry run] I would print (not auto-run): node scripts/hub.mjs enable ${dnsName}`);
    }
  } else if (!hasInstallToken()) {
    say("  No install token in the environment — skipped Arcade pin.");
    say("  Later:");
    say("    abra run gotchibot -- ./scripts/gotchibot hub chat-store --kind local");
    if (dnsName) {
      say(`    node scripts/hub.mjs enable ${dnsName}`);
    }
  } else {
    try {
      const { publishChatStore } = await import("./mongo-byo.mjs");
      await publishChatStore("local", { dbName });
      changes.push("Arcade chatStore kind=local");
      say("  Published chatStore kind=local to Arcade (metadata only).");
    } catch (e) {
      say(`  Arcade chat-store skipped: ${e.message || e}`);
    }
    if (dnsName) {
      if (opts.yes) {
        say("  (--yes) Not auto-signing wallet enable. When ready:");
        say(`    node scripts/hub.mjs enable ${dnsName}`);
      } else {
        const doEnable = await promptYesNo(
          opts,
          `Publish MagicDNS to Arcade with wallet sign (node scripts/hub.mjs enable ${dnsName})?`,
          true,
        );
        if (doEnable) {
          spawnSync(process.execPath, [resolve(ROOT, "scripts/hub.mjs"), "enable", dnsName], {
            stdio: "inherit",
            cwd: ROOT,
          });
          changes.push("hub enable (Arcade tailscaleHost)");
        } else {
          say(`  Skipped. Later: node scripts/hub.mjs enable ${dnsName}`);
        }
      }
    }
  }

  say("");
  say("Done.");
  if (changes.length) {
    say("What changed:");
    for (const c of changes) say(`  • ${c}`);
  } else if (dry) {
    say("Dry run — nothing was written or started.");
  } else {
    say("Nothing new to write (already set up).");
  }
  say("To undo: gotchibot hub uninstall");
  say("");
  return 0;
}

async function cmdUninstall(opts) {
  requireInteractiveOrFlags({ ...opts, yes: opts.yes || opts.dryRun });
  const dry = opts.dryRun;
  const port = resolvePort();
  const cfgPath = configPath();
  say("");
  say("GotchiBot Hub uninstall");
  say("Stops our service and serve handler. Keeps your config and chat database.");
  say("");

  const plat = platformKind();

  if (plat === "macos") {
    const plistPath = launchAgentPath();
    const uid = typeof process.getuid === "function" ? process.getuid() : "?";
    const target = `gui/${uid}/${SERVICE_LABEL}`;
    if (dry) {
      say(`[dry run] I would run: launchctl bootout ${target}`);
      if (existsSync(plistPath)) say(`[dry run] I would delete ${plistPath}`);
      else say(`[dry run] No plist at ${plistPath} (already gone)`);
    } else {
      spawnSync("launchctl", ["bootout", target], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (existsSync(plistPath)) {
        unlinkSync(plistPath);
        say(`  Removed ${plistPath}`);
      } else {
        say("  LaunchAgent plist already absent.");
      }
    }
  } else if (plat === "linux") {
    const unitPath = systemdUnitPath();
    if (dry) {
      say(`[dry run] I would run: systemctl --user disable --now ${SYSTEMD_UNIT}`);
      if (existsSync(unitPath)) say(`[dry run] I would delete ${unitPath}`);
      say(`[dry run] I would run: systemctl --user daemon-reload`);
      say(
        "[dry run] I would NOT disable linger — print: loginctl disable-linger $USER",
      );
    } else {
      spawnSync("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (existsSync(unitPath)) {
        unlinkSync(unitPath);
        say(`  Removed ${unitPath}`);
      }
      spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
      say("  Linger left alone. To turn it off later:");
      say("    loginctl disable-linger $USER");
    }
  } else {
    say("  No service unit on this platform. If you used `gotchibot api start --bg`, run:");
    say("    gotchibot api stop");
  }

  // Serve off only if ours
  const serve = readServeStatusJson();
  const handler = findServeHandler(serve.json || {}, port);
  const want = expectedServeTarget(port);
  if (handler.present && handler.target === want) {
    if (dry) {
      say(`[dry run] I would run: tailscale serve --http=${port} off`);
    } else {
      spawnSync("tailscale", ["serve", `--http=${port}`, "off"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      say(`  Turned off tailscale serve for :${port}`);
    }
  } else if (handler.present) {
    say(
      `  Serve on :${port} points elsewhere (${handler.target || "?"}) — left alone.`,
    );
  } else {
    say(`  No serve handler for :${port} — nothing to turn off.`);
  }

  say("");
  say("Kept on purpose:");
  say(`  • Hub config: ${cfgPath}${existsSync(cfgPath) ? "" : " (not present)"}`);
  say(`  • Chat database: Mongo db "${resolveDbName()}" on ${DEFAULT_MONGO_URI}`);
  say("To delete chats later: drop that Mongo database yourself.");
  say("To delete config: rm " + cfgPath);
  say("");
  if (dry) say("Dry run — nothing was removed.");
  return 0;
}

async function main(argv = process.argv.slice(2)) {
  let cmd = argv[0] || "help";
  const allFlags = parseFlags(argv);
  if (allFlags.help || cmd === "help" || cmd === "-h" || cmd === "--help") {
    usage();
    return 0;
  }

  // `install --uninstall` or bare uninstall
  if (cmd === "uninstall" || (cmd === "install" && allFlags.uninstallFlag)) {
    return cmdUninstall({
      dryRun: allFlags.dryRun,
      yes: allFlags.yes,
    });
  }

  if (cmd === "install") {
    return cmdInstall({
      dryRun: allFlags.dryRun,
      yes: allFlags.yes,
      noTailscale: allFlags.noTailscale,
      name: allFlags.name,
    });
  }

  // allow `node hub-install.mjs --dry-run` → treat as install
  if (cmd.startsWith("--")) {
    if (allFlags.uninstallFlag) {
      return cmdUninstall({ dryRun: allFlags.dryRun, yes: allFlags.yes });
    }
    return cmdInstall({
      dryRun: allFlags.dryRun,
      yes: allFlags.yes,
      noTailscale: allFlags.noTailscale,
      name: allFlags.name,
    });
  }

  usage();
  return 2;
}

if (isMainModule(import.meta.url)) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((e) => {
      console.error(e.message || e);
      process.exit(1);
    });
}

export { main, usage };
