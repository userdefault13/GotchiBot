#!/usr/bin/env node
/**
 * Hub dashboard — cockpit → Hub… 
 *
 * Local desk, remote desks, database, projects, logs, and the shared QEMU
 * guest's serial preview. Reads status the desk already has. A missing source
 * is "unavailable", never a made-up count. Does not start QEMU, the hub API,
 * Docker, or a receiver.
 *
 * Full dashboard is hub-only (sessions/.hub-api.json — this computer is the Hub).
 * Any other desk gets --lite: pairing and remote desk names, nothing else.
 *
 *   node scripts/hub-dashboard.mjs [--once]
 *   node scripts/hub-dashboard.mjs --lite [--once]
 *   q back · r refresh
 */
import { spawnSync } from "node:child_process";
import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { isMainModule } from "./is-main.mjs";
import { readHubPin, readMongoPin, deskApiBase, isArcadeSharedChatBase } from "./infra-client.mjs";
import { hubNetworkSummary } from "./hub-network.mjs";
import { checkReceiverHealth, DESK_RECEIVER_PORT } from "./desk-receiver-ensure.mjs";
import { healthCheck } from "./gotchibot-api.mjs";
import { resolveApiConfig } from "../services/gotchibot-api/config.mjs";
import { buildRoster } from "./hub-roster.mjs";
import { currentProjectSlug, listProjectSlugsOnDisk } from "./project-context.mjs";
import { sharedGuestPreview } from "./gotchibot-vm.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ESC = "\x1b";
const c = {
  reset: `${ESC}[0m`,
  dim: `${ESC}[2m`,
  bold: `${ESC}[1m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  red: `${ESC}[31m`,
  cyan: `${ESC}[36m`,
  gray: `${ESC}[90m`,
  pink: `${ESC}[38;5;212m`,
  rule: `${ESC}[38;5;240m`,
};

export const HUB_DASHBOARD_SECTIONS = [
  "LOCAL DESK",
  "REMOTE DESKS",
  "DATABASE",
  "PROJECTS",
  "LOGS",
  "VM PREVIEW",
];

/** Shown when a non-hub desk tries to open the full dashboard. */
export const HUB_DASHBOARD_DESK_REASON = "this desk is not the hub";

/** Smaller read-only page. No logs, database, or VM. */
export const HUB_LITE_SECTIONS = ["THIS DESK", "REMOTE DESKS"];

function visLen(s) {
  return String(s ?? "").replace(/\x1b\[[0-9;]*m/g, "").length;
}

function pad(str, width) {
  const s = String(str ?? "");
  const n = visLen(s);
  if (n <= width) return s + " ".repeat(width - n);
  let out = "";
  let vis = 0;
  for (let i = 0; i < s.length; ) {
    const m = s[i] === ESC ? s.slice(i).match(/^\x1b\[[0-9;]*m/) : null;
    if (m) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    if (vis >= width - 1) return `${out}…${c.reset}`;
    out += s[i];
    vis += 1;
    i += 1;
  }
  return out;
}

function cut(str, n) {
  return visLen(str) <= n ? String(str ?? "") : pad(str, n);
}

/** Wrap a colored row on spaces so a long unavailable reason stays readable. */
function wrapAnsi(str, width) {
  const s = String(str ?? "");
  if (width < 4 || visLen(s) <= width) return [s];
  const tokens = [];
  let i = 0;
  let pending = "";
  while (i < s.length) {
    while (i < s.length) {
      const m = s[i] === ESC ? s.slice(i).match(/^\x1b\[[0-9;]*m/) : null;
      if (!m) break;
      pending += m[0];
      i += m[0].length;
    }
    if (i >= s.length) break;
    if (s[i] === " ") {
      i += 1;
      continue;
    }
    let word = "";
    while (i < s.length && s[i] !== " ") {
      const m = s[i] === ESC ? s.slice(i).match(/^\x1b\[[0-9;]*m/) : null;
      if (m) break;
      word += s[i];
      i += 1;
    }
    let post = "";
    while (i < s.length) {
      const m = s[i] === ESC ? s.slice(i).match(/^\x1b\[[0-9;]*m/) : null;
      if (!m) break;
      post += m[0];
      i += m[0].length;
    }
    tokens.push({ pre: pending, word, post });
    pending = "";
  }
  const lines = [];
  let line = "";
  let carry = "";
  const commit = () => {
    if (!visLen(line)) return;
    lines.push(line.endsWith(c.reset) ? line : line + c.reset);
    line = "";
  };
  for (const tok of tokens) {
    const piece = `${tok.pre}${tok.word}${tok.post}`;
    const next = visLen(line) ? `${line} ${piece}` : `${carry}${piece}`;
    if (visLen(line) && visLen(next) > width) {
      commit();
      line = `${carry}${piece}`;
    } else {
      line = next;
    }
    const style = `${tok.pre}${tok.post}`;
    carry = style.includes("[0m") ? "" : style || carry;
  }
  commit();
  return lines.length ? lines : [""];
}

/** Same dossier box the Factory pane uses. */
function panel(title, rows, width, { note = "", border = c.rule, titleTint = c.pink } = {}) {
  const inner = Math.max(8, width - 2);
  const noteW = note ? visLen(note) + 3 : 0;
  const t = cut(title, Math.max(1, inner - 3 - noteW));
  const fill = Math.max(0, inner - 3 - visLen(t) - noteW);
  const tail = note ? ` ${c.reset}${c.dim}${note}${c.reset}${border} ─` : "";
  const out = [`${border}┌─ ${c.reset}${titleTint}${c.bold}${t}${c.reset}${border} ${"─".repeat(fill)}${tail}┐${c.reset}`];
  const body = (rows.length ? rows : [""]).flatMap((row) => wrapAnsi(row, inner - 2));
  for (const row of body) out.push(`${border}│${c.reset} ${pad(row, inner - 2)} ${border}│${c.reset}`);
  out.push(`${border}└${"─".repeat(inner)}┘${c.reset}`);
  return out;
}

function mark(ok) {
  if (ok === true) return `${c.green}✓${c.reset}`;
  if (ok === false) return `${c.red}✗${c.reset}`;
  return `${c.yellow}?${c.reset}`;
}

function unavailable(reason) {
  return `${c.yellow}? unavailable${c.reset} ${c.dim}— ${reason}${c.reset}`;
}

function redact(line) {
  return String(line)
    .replace(/mongodb(\+srv)?:\/\/\S+/gi, "mongodb://***")
    .replace(/((?:token|bearer|password|secret|api[_-]?key)[=:]\s*)\S+/gi, "$1***");
}

function remoteDeskRows(remote) {
  const rows = [];
  if (remote.state === "unavailable") {
    rows.push(unavailable(remote.reason || "remote desk list could not be read"));
  } else if (!remote.desks?.length) {
    rows.push(`${c.dim}none — no other desk answered GotchiBot ports${c.reset}`);
  } else {
    for (const d of remote.desks) {
      const dot = d.connected ? `${c.green}●${c.reset}` : `${c.gray}○${c.reset}`;
      rows.push(`${dot} ${d.label || "?"}  ${c.dim}${d.detail || ""}${c.reset}`);
    }
  }
  return rows;
}

/**
 * Turn already-collected facts into the six sections. No I/O.
 * state: "up" | "down" | "empty" | "unavailable"
 */
export function assembleHubDashboard(facts = {}) {
  const local = facts.local || {};
  const remote = facts.remote || {};
  const db = facts.db || {};
  const projects = facts.projects || {};
  const logs = facts.logs || {};
  const vm = facts.vm || {};

  const localRows = [];
  if (local.state === "unavailable") {
    localRows.push(unavailable(local.reason || "local desk status could not be read"));
  } else if (local.state === "up") {
    localRows.push(`${mark(true)} connected  ${c.dim}${local.detail || ""}${c.reset}`);
  } else {
    localRows.push(`${mark(false)} not connected  ${c.dim}${local.detail || ""}${c.reset}`);
  }
  if (local.pair) localRows.push(`${c.dim}${local.pair}${c.reset}`);

  const remoteRows = remoteDeskRows(remote);

  const dbRows = [];
  if (db.state === "unavailable") {
    dbRows.push(unavailable(db.reason || "database status could not be read"));
  } else if (db.state === "up") {
    dbRows.push(`${mark(true)} up  ${c.dim}${db.detail || ""}${c.reset}`);
  } else {
    dbRows.push(`${mark(false)} down  ${c.dim}${db.detail || ""}${c.reset}`);
  }
  if (db.pin) dbRows.push(`${c.dim}${db.pin}${c.reset}`);

  const projectRows = [];
  if (projects.state === "unavailable") {
    projectRows.push(unavailable(projects.reason || "project list could not be read"));
  } else if (!projects.items?.length) {
    projectRows.push(`${c.dim}none — no project rooms on this desk${c.reset}`);
  } else {
    for (const p of projects.items) {
      const cur = p.current ? `${c.cyan} current${c.reset}` : "";
      projectRows.push(`${p.current ? `${c.cyan}●${c.reset}` : `${c.gray}·${c.reset}`} ${p.slug}${cur}`);
    }
  }

  const logRows = [];
  if (logs.state === "unavailable") {
    logRows.push(unavailable(logs.reason || "log file is not on this desk"));
  } else if (!logs.lines?.length) {
    logRows.push(`${c.dim}log file is empty${c.reset}`);
  } else {
    for (const line of logs.lines) logRows.push(`${c.dim}${redact(line)}${c.reset}`);
  }

  const vmRows = [];
  if (vm.state === "unavailable") {
    vmRows.push(unavailable(vm.reason || "VM preview unavailable"));
  } else {
    const run = vm.running ? `${mark(true)} running` : `${mark(false)} not running`;
    vmRows.push(`${run}  ${c.dim}${vm.detail || ""}${c.reset}`);
    if (vm.lines?.length) {
      vmRows.push(`${c.dim}── serial${c.reset}`);
      for (const line of vm.lines) vmRows.push(`${c.gray}${redact(line)}${c.reset}`);
    } else if (!vm.running) {
      vmRows.push(unavailable("no serial log yet — this page does not start QEMU"));
    } else {
      vmRows.push(`${c.dim}serial log empty${c.reset}`);
    }
  }

  return {
    at: facts.at || null,
    sections: [
      { title: "LOCAL DESK", note: local.source || "", rows: localRows },
      { title: "REMOTE DESKS", note: remote.source || "", rows: remoteRows },
      { title: "DATABASE", note: db.source || "", rows: dbRows },
      { title: "PROJECTS", note: projects.source || "", rows: projectRows },
      { title: "LOGS", note: logs.source || "", rows: logRows },
      { title: "VM PREVIEW", note: vm.source || "gbvm-shared", rows: vmRows },
    ],
  };
}

export function renderHubDashboard(model, cols = 80) {
  const width = Math.max(40, Math.min(cols || 80, 160));
  const lines = [
    `${c.pink}${c.bold}HUB DASHBOARD${c.reset}  ${c.dim}cockpit → Hub…${c.reset}`,
    `${c.dim}live where a source exists · a missing source stays unavailable · QEMU is not started here${c.reset}`,
  ];
  if (model.at) lines.push(`${c.dim}${model.at}${c.reset}`);
  lines.push("");
  for (const section of model.sections || []) {
    lines.push(...panel(section.title, section.rows, width, { note: section.note || "" }));
  }
  lines.push(`${c.dim}r refresh · q back to Hub…${c.reset}`);
  return lines.join("\n");
}

/**
 * Desk-sized page. Facts only: this desk paired or not, and remote desk
 * names from a hub-roster read. No database, logs, or VM.
 */
export function assembleHubLite(facts = {}) {
  const local = facts.local || {};
  const remote = facts.remote || {};
  const localRows = [];
  if (local.state === "unavailable") {
    localRows.push(unavailable(local.reason || "this desk's hub pin could not be read"));
  } else if (local.paired) {
    localRows.push(`${mark(true)} paired  ${c.dim}${local.detail || ""}${c.reset}`);
  } else {
    localRows.push(`${mark(false)} not paired  ${c.dim}${local.detail || "no hub pin on this desk"}${c.reset}`);
  }
  return {
    at: facts.at || null,
    lite: true,
    sections: [
      { title: "THIS DESK", note: local.source || "sessions/.hub.json", rows: localRows },
      { title: "REMOTE DESKS", note: remote.source || "hub-roster", rows: remoteDeskRows(remote) },
    ],
  };
}

export function renderHubLite(model, cols = 80) {
  const width = Math.max(40, Math.min(cols || 80, 160));
  const lines = [
    `${c.pink}${c.bold}HUB LITE${c.reset}  ${c.dim}lite view · not the hub dashboard${c.reset}`,
    `${c.dim}read-only · this desk's pairing and remote desk names${c.reset}`,
    `${c.dim}logs, database, and VM stay on the hub dashboard${c.reset}`,
  ];
  if (model.at) lines.push(`${c.dim}${model.at}${c.reset}`);
  lines.push("");
  for (const section of model.sections || []) {
    lines.push(...panel(section.title, section.rows, width, { note: section.note || "" }));
  }
  lines.push(`${c.dim}r refresh · q back to Hub…${c.reset}`);
  return lines.join("\n");
}

function tailFile(path, maxLines) {
  if (!existsSync(path)) return null;
  const st = statSync(path);
  const len = Math.min(st.size, 64 * 1024);
  const buf = Buffer.alloc(len);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, len, Math.max(0, st.size - len));
  } finally {
    closeSync(fd);
  }
  return buf
    .toString("utf8")
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length)
    .slice(-maxLines);
}

function tmuxDesk(session) {
  const r = spawnSync("tmux", ["has-session", "-t", `=${session}`], { stdio: "ignore", timeout: 1500 });
  if (r.error) return { checked: false, up: false, reason: r.error.code || "tmux-error" };
  return { checked: true, up: r.status === 0, session };
}

async function probeHealth(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body) return null;
    return body;
  } catch {
    return null;
  }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
  ]);
}

function remoteFactsFromRoster(rosterSettled) {
  if (!rosterSettled.ok) {
    return {
      state: "unavailable",
      reason: rosterSettled.error?.message || "hub roster failed",
      source: "hub-roster",
    };
  }
  if (!rosterSettled.value?.tailnet?.ok) {
    return {
      state: "unavailable",
      reason: "tailscale status unavailable",
      source: "hub-roster",
    };
  }
  const desks = (rosterSettled.value.desks || [])
    .filter((d) => !d.self)
    .map((d) => ({
      label: d.host || d.label || "?",
      connected: Boolean(d.online),
      detail: d.why || (d.online ? "online" : "offline"),
    }));
  return { state: "up", desks, source: "hub-roster" };
}

function loadRoster() {
  return withTimeout(buildRoster({ live: false }), 12000, "hub roster").then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
}

/** Pairing this desk already stored. Never includes the desk token. */
function liteLocalFromPin(pin) {
  const paired = Boolean(pin?.deskToken && pin?.deskApiBase);
  if (!paired) {
    return {
      state: "down",
      paired: false,
      detail: pin ? "hub pin has no desk pairing" : "no hub pin (sessions/.hub.json)",
      source: "sessions/.hub.json",
    };
  }
  const name = pin.deskName || pin.name || pin.deskId || "this desk";
  const host = String(pin.tailscaleHost || "").trim();
  const base = String(pin.deskApiBase || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return {
    state: "up",
    paired: true,
    detail: [name, host || base].filter(Boolean).join(" · "),
    source: "sessions/.hub.json",
  };
}

function pairLine(pin) {
  if (!pin) return "no hub pin (sessions/.hub.json)";
  const name = pin.name || pin.deskName || pin.deskId || "paired";
  const host = pin.tailscaleHost || pin.deskApiBase || "";
  return `pin ${name}${host ? ` · ${host}` : ""}`.replace(/\/+$/, "");
}

function pinLine(mongo) {
  if (!mongo) return "no mongo pin (sessions/.mongo.json) — not a live ping";
  const kind = mongo.kind || "unknown";
  const db = mongo.dbName || "";
  return `pin ${kind}${db ? ` · ${db}` : ""} — config only, not a live ping`;
}

/** Best-available snapshot. Never starts services. */
export async function collectHubDashboard({ root = ROOT, env = process.env } = {}) {
  const session = env.GOTCHIBOT_TMUX_SESSION || "gotchibot";
  const [receiver, tmux, rosterSettled] = await Promise.all([
    checkReceiverHealth().then(
      (up) => ({ checked: true, up }),
      () => ({ checked: false, up: false }),
    ),
    Promise.resolve().then(() => tmuxDesk(session)),
    loadRoster(),
  ]);

  let local;
  if (!receiver.checked && !tmux.checked) {
    local = { state: "unavailable", reason: "desk receiver and tmux could not be checked", source: "receiver · tmux" };
  } else if (receiver.up || tmux.up) {
    const bits = [];
    if (receiver.checked) bits.push(receiver.up ? `receiver :${DESK_RECEIVER_PORT}` : `receiver :${DESK_RECEIVER_PORT} down`);
    else bits.push("receiver check failed");
    if (tmux.checked) bits.push(tmux.up ? `tmux ${session}` : `tmux ${session} not running`);
    else bits.push(`tmux check unavailable (${tmux.reason || "error"})`);
    local = { state: "up", detail: bits.join(" · "), source: "receiver · tmux" };
  } else {
    const bits = [];
    if (receiver.checked) bits.push(`receiver :${DESK_RECEIVER_PORT} down`);
    else bits.push("receiver check failed");
    if (tmux.checked) bits.push(`tmux ${session} not running`);
    else bits.push(`tmux check unavailable (${tmux.reason || "error"})`);
    local = { state: "down", detail: bits.join(" · "), source: "receiver · tmux" };
  }
  local.pair = pairLine(readHubPin(root));

  const remote = remoteFactsFromRoster(rosterSettled);

  let db = { state: "unavailable", reason: "no health endpoint answered", source: "GET /health" };
  const tried = [];
  try {
    const cfg = resolveApiConfig(env);
    const localHealth = await healthCheck(cfg.port, "127.0.0.1");
    tried.push(`127.0.0.1:${cfg.port}`);
    if (localHealth && (localHealth.db === "ok" || localHealth.db === "down")) {
      db = {
        state: localHealth.db === "ok" ? "up" : "down",
        detail: `GET /health on 127.0.0.1:${cfg.port}`,
        source: "GET /health",
      };
    }
  } catch (e) {
    db = { state: "unavailable", reason: e?.message || "api config unreadable", source: "GET /health" };
  }
  if (db.state === "unavailable") {
    const base = deskApiBase(env);
    if (base && !isArcadeSharedChatBase(base)) {
      tried.push(base.replace(/^https?:\/\//, ""));
      const body = await probeHealth(`${base.replace(/\/$/, "")}/health`);
      if (body && (body.db === "ok" || body.db === "down")) {
        db = {
          state: body.db === "ok" ? "up" : "down",
          detail: `GET /health on ${base.replace(/^https?:\/\//, "")}`,
          source: "GET /health",
        };
      }
    }
    if (db.state === "unavailable" && tried.length) {
      db.reason = `nothing answered (${tried.join(", ")}) — not started from this page`;
    }
  }
  db.pin = pinLine(readMongoPin(root));

  let projects;
  try {
    const current = currentProjectSlug();
    const slugs = listProjectSlugsOnDisk();
    const items = slugs.slice(0, 16).map((slug) => ({ slug, current: slug === current }));
    if (slugs.length > items.length) {
      items.push({ slug: `+${slugs.length - items.length} more`, current: false });
    }
    projects = { state: "up", items, source: "sessions/pstack" };
  } catch (e) {
    projects = { state: "unavailable", reason: e?.message || "project list failed", source: "sessions/pstack" };
  }

  const logPath = String(env.GOTCHIBOT_API_LOG || "").trim() || resolve(root, "sessions/.gotchibot-api.log");
  let logs;
  try {
    const lines = tailFile(logPath, 8);
    if (lines == null) {
      logs = {
        state: "unavailable",
        reason: `${logPath.replace(root, ".")} is not on this desk`,
        source: "hub api log",
      };
    } else {
      logs = { state: "up", lines, source: "hub api log" };
    }
  } catch (e) {
    logs = { state: "unavailable", reason: e?.message || "log unreadable", source: "hub api log" };
  }

  let vm;
  try {
    const preview = sharedGuestPreview({ maxLines: 10 });
    const bits = [preview.name || preview.id, preview.image];
    if (preview.running && preview.holder) bits.push(`holder ${preview.holder}`);
    if (preview.running && preview.port) bits.push(`ssh 127.0.0.1:${preview.port}`);
    const hasSerial = Array.isArray(preview.lines) && preview.lines.length > 0;
    if (!preview.running && !hasSerial) {
      vm = {
        state: "unavailable",
        reason: "shared guest is not running and has no serial log — this page does not start QEMU",
        source: "gbvm-shared serial",
        running: false,
      };
    } else {
      vm = {
        state: "up",
        running: preview.running,
        detail: bits.filter(Boolean).join(" · "),
        lines: hasSerial ? preview.lines : [],
        source: "gbvm-shared serial",
      };
    }
  } catch (e) {
    vm = { state: "unavailable", reason: e?.message || "vm preview failed", source: "gbvm-shared serial" };
  }

  return assembleHubDashboard({
    at: new Date().toISOString(),
    local,
    remote,
    db,
    projects,
    logs,
    vm,
  });
}

/**
 * Read-only snapshot for a desk that is not the hub.
 * Uses the hub pin and hub-roster (live: false). Does not read logs,
 * ping the database, or open the VM serial log.
 * Pass `roster` to skip the tailnet read (tests).
 */
export async function collectHubLite({ root = ROOT, roster } = {}) {
  const rosterSettled = roster ? { ok: true, value: roster } : await loadRoster();
  return assembleHubLite({
    at: new Date().toISOString(),
    local: liteLocalFromPin(readHubPin(root)),
    remote: remoteFactsFromRoster(rosterSettled),
  });
}

function paint(text) {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const body = text.split("\n").slice(0, Math.max(1, rows - 1));
  process.stdout.write(`${ESC}[2J${ESC}[H${body.join("\n")}\n`);
  void cols;
}

async function main() {
  const lite = process.argv.includes("--lite");
  if (!lite && !hubNetworkSummary().hubInstalled) {
    console.log(HUB_DASHBOARD_DESK_REASON);
    process.exit(1);
  }
  const once = process.argv.includes("--once") || !process.stdout.isTTY || !process.stdin.isTTY;
  const draw = async () => {
    const text = lite
      ? renderHubLite(await collectHubLite(), process.stdout.columns || 80)
      : renderHubDashboard(await collectHubDashboard(), process.stdout.columns || 80);
    if (once) process.stdout.write(`${text}\n`);
    else paint(text);
  };
  await draw();
  if (once) return;

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  await new Promise((done) => {
    const onKey = async (str, key) => {
      if (key?.ctrl && key?.name === "c") {
        cleanup();
        done();
        return;
      }
      if (key?.name === "q" || str === "q") {
        cleanup();
        done();
        return;
      }
      if (key?.name === "r" || str === "r") {
        try {
          await draw();
        } catch (e) {
          paint(unavailable(e?.message || e));
        }
      }
    };
    const cleanup = () => {
      process.stdin.off("keypress", onKey);
      try {
        process.stdin.setRawMode(false);
      } catch {
        /* not a tty anymore */
      }
      process.stdout.write(`${ESC}[0m`);
    };
    process.stdin.on("keypress", onKey);
  });
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e?.message || e);
    process.exit(1);
  });
}
