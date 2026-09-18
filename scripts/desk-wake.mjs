#!/usr/bin/env node
/**
 * desk-wake.mjs — common scheduled wake for seated GotchiBot desks.
 *
 * Desks with dedicated wakers (trader / infra / moltbook / comms) are mode=defer.
 * Everyone else can get a launchd job that chats the OpenClaw hero (or runs cycleCmd).
 *
 *   ./scripts/gotchibot wake list|status [--json] [--role <id>]
 *   ./scripts/gotchibot wake run <hero|role>
 *   ./scripts/gotchibot wake install <hero|role|--all>
 *   ./scripts/gotchibot wake uninstall <hero|role|--all>
 *
 * Install on the iMac (always-on). No paid cron402 from this CLI.
 */
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { isMainModule } from "./is-main.mjs";
import { install, uninstall, loaded, kickstart, plistPath } from "./lib/launchd-job.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_DIR = join(ROOT, "sessions", "desk-wake-logs");
const CONFIG_PATH = join(ROOT, "config", "desk-wakes.json");
const ROLES_PATH = join(ROOT, "config", "agent-roles.json");
const PLAYBOOKS_PATH = join(ROOT, "config", "agent-role-playbooks.json");

const TRAILER =
  " Address UserDefault only. Bounded cycle — stop after one unit of progress. Report to orch via bot inbox if useful.";

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function loadConfig() {
  const cfg = readJson(CONFIG_PATH, null);
  if (!cfg || typeof cfg !== "object") throw new Error(`missing or bad ${CONFIG_PATH}`);
  return {
    defaults: {
      intervalSec: 3600,
      mode: "chat",
      enabled: true,
      ...(cfg.defaults || {}),
    },
    roles: cfg.roles || {},
  };
}

function loadRoles() {
  return readJson(ROLES_PATH, {}) || {};
}

function loadPlaybooks() {
  return readJson(PLAYBOOKS_PATH, {}) || {};
}

function orchHeroId() {
  const roles = loadRoles();
  for (const [hero, role] of Object.entries(roles)) {
    if (role === "orchestrator") return hero;
  }
  return "owned-954";
}

function labelFor(heroId) {
  return `com.gotchibot.desk-wake.${String(heroId).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function roleConfig(roleId, cfg) {
  const base = { ...cfg.defaults };
  const over = cfg.roles[roleId] || {};
  return { ...base, ...over, roleId };
}

function resolveTarget(token, cfg) {
  const roles = loadRoles();
  const playbooks = loadPlaybooks();
  const t = String(token || "").trim();
  if (!t) throw new Error("need <hero|role>");

  if (roles[t]) {
    const roleId = roles[t];
    return {
      heroId: t,
      roleId,
      wake: roleConfig(roleId, cfg),
      playbook: playbooks[roleId] || null,
    };
  }

  const heroes = Object.entries(roles)
    .filter(([, r]) => r === t)
    .map(([h]) => h);
  if (!heroes.length) {
    // Unseated role that still has a wake config (e.g. trader-desk defer): let
    // runWake print the dedicated schedule CLI instead of erroring.
    if (cfg.roles[t]) return { heroId: null, roleId: t, wake: roleConfig(t, cfg), playbook: playbooks[t] || null };
    throw new Error(`unknown hero or role: ${t}`);
  }
  const heroId = heroes[0];
  return {
    heroId,
    roleId: t,
    wake: roleConfig(t, cfg),
    playbook: playbooks[t] || null,
    altHeroes: heroes.slice(1),
  };
}

function seatedDeskRows(cfg) {
  const roles = loadRoles();
  const playbooks = loadPlaybooks();
  const orch = orchHeroId();
  const rows = [];
  for (const [heroId, roleId] of Object.entries(roles)) {
    if (heroId === orch || roleId === "orchestrator") continue;
    const wake = roleConfig(roleId, cfg);
    const label = labelFor(heroId);
    const l = loaded(label);
    rows.push({
      heroId,
      roleId,
      title: playbooks[roleId]?.title || roleId,
      enabled: Boolean(wake.enabled) && wake.mode !== "defer",
      mode: wake.mode || "chat",
      intervalSec: Number(wake.intervalSec) || cfg.defaults.intervalSec,
      note: wake.note || null,
      label,
      plistInstalled: existsSync(plistPath(label)),
      loaded: Boolean(l),
      launchd: l,
      lastRun: lastRun(heroId),
    });
  }
  return rows.sort((a, b) => a.roleId.localeCompare(b.roleId) || a.heroId.localeCompare(b.heroId));
}

function lastRun(heroId) {
  const path = join(LOG_DIR, `${heroId}.jsonl`);
  if (!existsSync(path)) return null;
  try {
    const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
    if (!lines.length) return null;
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

function appendLog(heroId, entry) {
  mkdirSync(LOG_DIR, { recursive: true });
  appendFileSync(join(LOG_DIR, `${heroId}.jsonl`), `${JSON.stringify(entry)}\n`);
}

function buildPrompt(target) {
  const custom = String(target.wake.prompt || "").trim();
  let prompt;
  if (custom) {
    prompt = custom.includes("UserDefault") ? custom : custom + TRAILER;
  } else {
    const title = target.playbook?.title || target.roleId;
    const auto = String(target.playbook?.autonomy || "").split(/(?<=\.)\s+/)[0] || title;
    prompt = `Scheduled desk wake (${title}). One bounded cycle of your desk work: ${auto}${TRAILER}`;
  }
  return prompt
    .replaceAll("{{HERO}}", target.heroId)
    .replaceAll("{{ROLE}}", target.roleId)
    .replaceAll("<your-hero-id>", target.heroId);
}

async function runWake(target) {
  const at = new Date().toISOString();
  const { wake, heroId, roleId, playbook } = target;

  if (wake.mode === "defer") {
    const note = wake.note || "dedicated schedule CLI";
    const sc = wake.scheduleCmd || null;
    const entry = { type: "desk-wake", at, heroId: heroId || roleId, roleId, mode: "defer", ok: false, reason: note, scheduleCmd: sc };
    appendLog(heroId || roleId, entry);
    console.error(`defer ${roleId}${heroId ? ` (${heroId})` : ""}: ${sc ? `use ${sc}` : note}`);
    return { ...entry, exitCode: 2 };
  }

  if (!wake.enabled) {
    const entry = { type: "desk-wake", at, heroId, roleId, mode: wake.mode, ok: false, reason: "disabled" };
    appendLog(heroId, entry);
    console.error(`disabled ${roleId} (${heroId})`);
    return { ...entry, exitCode: 2 };
  }

  if (wake.mode === "cycle") {
    const cmd = playbook?.cycleCmd;
    if (!cmd) {
      const entry = { type: "desk-wake", at, heroId, roleId, mode: "cycle", ok: false, reason: "no-cycleCmd" };
      appendLog(heroId, entry);
      console.error(`no cycleCmd for ${roleId}`);
      return { ...entry, exitCode: 1 };
    }
    const r = spawnSync("bash", ["-lc", cmd], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, GOTCHIBOT_HERO_ID: heroId },
    });
    const entry = {
      type: "desk-wake",
      at,
      heroId,
      roleId,
      mode: "cycle",
      ok: r.status === 0,
      status: r.status,
      stdout: (r.stdout || "").slice(0, 4000),
      stderr: (r.stderr || "").slice(0, 1000),
    };
    appendLog(heroId, entry);
    if (entry.ok) console.log(`ok cycle ${roleId} (${heroId})`);
    else console.error(`FAIL cycle ${roleId}: ${(r.stderr || r.stdout || "").trim().slice(0, 200)}`);
    return { ...entry, exitCode: entry.ok ? 0 : 1 };
  }

  // chat mode
  const prompt = buildPrompt(target);
  const { chatViaOpenClaw, gatewayReachable } = await import("./openclaw-fleet.mjs");
  const reachable = await gatewayReachable();
  if (!reachable) {
    const entry = {
      type: "desk-wake",
      at,
      heroId,
      roleId,
      mode: "chat",
      ok: false,
      reason: "gateway-unreachable",
    };
    appendLog(heroId, entry);
    console.error(`gateway unreachable — cannot wake ${heroId}`);
    return { ...entry, exitCode: 1 };
  }

  const chat = await chatViaOpenClaw(heroId, prompt);
  const entry = {
    type: "desk-wake",
    at,
    heroId,
    roleId,
    mode: "chat",
    ok: Boolean(chat?.ok),
    reason: chat?.reason || null,
    replyPreview: String(chat?.text || chat?.content || "").slice(0, 500) || null,
  };
  appendLog(heroId, entry);
  if (entry.ok) console.log(`ok chat ${roleId} (${heroId})`);
  else console.error(`FAIL chat ${heroId}: ${entry.reason || "unknown"}`);
  return { ...entry, exitCode: entry.ok ? 0 : 1 };
}

function installHero(target) {
  const { heroId, roleId, wake } = target;
  if (wake.mode === "defer" || !wake.enabled) {
    throw new Error(`cannot install ${roleId}: mode=${wake.mode} enabled=${wake.enabled}${wake.note ? ` (${wake.note})` : ""}`);
  }
  const intervalSec = Number(wake.intervalSec) || 3600;
  const label = labelFor(heroId);
  const spec = {
    label,
    args: [`${ROOT}/scripts/desk-wake.mjs`, "run", heroId],
    cwd: ROOT,
    intervalSec,
    logDir: LOG_DIR,
    runAtLoad: false,
  };
  const r = install(spec);
  return { heroId, roleId, label, intervalSec, ...r };
}

function uninstallHero(heroId) {
  const label = labelFor(heroId);
  uninstall(label);
  return { heroId, label, uninstalled: true };
}

function printStatus(rows, { roleFilter } = {}) {
  const filtered = roleFilter ? rows.filter((r) => r.roleId === roleFilter || r.heroId === roleFilter) : rows;
  console.log(`desk-wake on ${hostname()} — ${filtered.length} seated desk(s)`);
  for (const r of filtered) {
    const sched =
      r.mode === "defer"
        ? `defer`
        : r.enabled
          ? r.loaded
            ? `scheduled every ${r.intervalSec}s`
            : `enabled, not scheduled (install: gotchibot wake install ${r.roleId})`
          : `disabled`;
    const last = r.lastRun?.at ? ` last=${r.lastRun.at}${r.lastRun.ok === false ? " FAIL" : ""}` : "";
    console.log(
      `  ${r.enabled && r.mode !== "defer" ? (r.loaded ? "ok   " : "MISS ") : "—    "}${r.roleId.padEnd(22)} ${r.heroId.padEnd(18)} ${sched}${last}`,
    );
    if (r.note && r.mode === "defer") console.log(`         ${r.note}`);
  }
}

function usage() {
  console.log(`Usage:
  gotchibot wake list|status [--json] [--role <id>]
  gotchibot wake run|run-now <hero|role>
  gotchibot wake install <hero|role|--all>
  gotchibot wake uninstall <hero|role|--all>

Common skill desk-wake. Dedicated desks (trader/infra/moltbook/comms) are defer — use their schedule CLIs.
Install launchd on the iMac. No paid cron402 from this command.`);
}

async function main(argv) {
  const args = argv.slice();
  const cmd = args.shift() || "status";
  if (cmd === "-h" || cmd === "--help" || cmd === "help") {
    usage();
    process.exit(0);
  }

  const cfg = loadConfig();
  const json = args.includes("--json");
  const roleIdx = args.indexOf("--role");
  const roleFilter = roleIdx >= 0 ? args[roleIdx + 1] : null;
  const positional = args.filter((a, i) => a !== "--json" && a !== "--role" && !(roleIdx >= 0 && i === roleIdx + 1));

  if (cmd === "list" || cmd === "status") {
    const rows = seatedDeskRows(cfg);
    const filtered = roleFilter ? rows.filter((r) => r.roleId === roleFilter || r.heroId === roleFilter) : rows;
    if (json) {
      console.log(JSON.stringify({ host: hostname(), desks: filtered }, null, 2));
    } else {
      printStatus(rows, { roleFilter });
    }
    process.exit(0);
  }

  if (cmd === "run" || cmd === "run-now") {
    const token = positional[0] || roleFilter;
    if (!token) {
      usage();
      process.exit(2);
    }
    const target = resolveTarget(token, cfg);
    const result = await runWake(target);
    process.exit(result.exitCode ?? 1);
  }

  if (cmd === "install") {
    const token = positional[0];
    if (!token) {
      usage();
      process.exit(2);
    }
    if (token === "--all") {
      const rows = seatedDeskRows(cfg).filter((r) => r.enabled && r.mode !== "defer");
      const out = [];
      for (const r of rows) {
        try {
          const target = resolveTarget(r.heroId, cfg);
          out.push(installHero(target));
          console.log(`installed ${r.roleId} (${r.heroId}) every ${r.intervalSec}s → ${labelFor(r.heroId)}`);
        } catch (e) {
          console.error(`skip ${r.roleId}: ${e.message}`);
        }
      }
      if (json) console.log(JSON.stringify(out, null, 2));
      process.exit(0);
    }
    const target = resolveTarget(token, cfg);
    const r = installHero(target);
    console.log(`${r.changed ? "wrote" : "kept"} ${r.path}`);
    console.log(`loaded ${r.label}: every ${r.intervalSec}s (gotchibot wake run ${r.heroId})`);
    if (json) console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  }

  if (cmd === "uninstall") {
    const token = positional[0];
    if (!token) {
      usage();
      process.exit(2);
    }
    if (token === "--all") {
      const rows = seatedDeskRows(cfg);
      for (const r of rows) {
        if (!r.plistInstalled && !r.loaded) continue;
        uninstallHero(r.heroId);
        console.log(`uninstalled ${r.label}`);
      }
      process.exit(0);
    }
    const target = resolveTarget(token, cfg);
    uninstallHero(target.heroId);
    console.log(`uninstalled ${labelFor(target.heroId)}`);
    process.exit(0);
  }

  if (cmd === "kick") {
    const token = positional[0];
    if (!token) {
      usage();
      process.exit(2);
    }
    const target = resolveTarget(token, cfg);
    kickstart(labelFor(target.heroId));
    console.log(`kickstarted ${labelFor(target.heroId)}`);
    process.exit(0);
  }

  usage();
  process.exit(2);
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e?.stack || e);
    process.exit(1);
  });
}
