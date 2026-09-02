#!/usr/bin/env node
/**
 * Agent roster + focus for gotchi mode.
 *
 *   node scripts/agent-focus.mjs list [--json]
 *   node scripts/agent-focus.mjs switch [index|id]  # list all, or switch avatar+direct chat (headless)
 *   node scripts/agent-focus.mjs select <index|id> [--host local|imac] [--respawn]
 *   node scripts/agent-focus.mjs orch [--respawn]
 *   node scripts/agent-focus.mjs status [--json]
 *   node scripts/agent-focus.mjs chat "prompt…"   # route to focused sub-agent
 *
 * /switch, /list, and /orch OpenCode commands call this. Switching a gotchi pins
 * the avatar and sets SUB focus so chat prompts that agent directly; /orch returns
 * to the orchestrator hero. In OpenCode primary mode `sub`, /switch lists exclude
 * the orchestrator. select/switch/orch are headless by default (chat pane
 * stays up); pass --respawn/--restart to reload OpenCode. cockpit/meet still respawn.
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMeta, saveMeta } from "./identity.mjs";
import {
  pinAvatar,
  loadOnboarding,
  fetchCartridgeHeroes,
} from "./onboarding-lib.mjs";
import { resolveThumbCollateral } from "./collateral-resolve.mjs";
import { classifyFocusRoute } from "./focus-classify.mjs";
import { loadAgentMap, gatewayUrl, loadOpenClawFocus } from "./openclaw-fleet.mjs";
import { runLayout } from "./tmux-layout.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = `${ROOT}/sessions`;
const FOCUS = `${SESSIONS}/.focus.json`;
const LIST_CACHE = `${SESSIONS}/.focus-list.json`;
const PIN = `${SESSIONS}/.pin`;

function ensureSessions() {
  mkdirSync(SESSIONS, { recursive: true });
}

function loadFocus() {
  try {
    return JSON.parse(readFileSync(FOCUS, "utf8"));
  } catch {
    return { mode: "orch", updatedAt: null };
  }
}

function saveFocus(data) {
  ensureSessions();
  writeFileSync(
    FOCUS,
    `${JSON.stringify({ ...data, updatedAt: new Date().toISOString() }, null, 2)}\n`,
  );
}

function signalAvatar(heroId) {
  try {
    writeFileSync(PIN, `${heroId}\n`);
  } catch {}
  spawnSync("bash", [`${ROOT}/scripts/poke-avatar.sh`], { stdio: "ignore" });
}

function field(path, key) {
  try {
    const line = readFileSync(path, "utf8")
      .split("\n")
      .find((l) => l.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1) : "";
  } catch {
    return "";
  }
}

function scanLocalSessions() {
  if (!existsSync(SESSIONS)) return [];
  const out = [];
  for (const name of readdirSync(SESSIONS)) {
    if (!/^s\d/.test(name)) continue;
    const dir = `${SESSIONS}/${name}`;
    const st = `${dir}/state.env`;
    if (!existsSync(st)) continue;
    out.push({
      kind: "session",
      host: "local",
      id: name,
      status: field(st, "status") || "?",
      hero: field(st, "hero") || null,
      model: field(st, "model") || null,
      started: field(st, "started") || null,
    });
  }
  out.sort((a, b) => String(b.started).localeCompare(String(a.started)));
  return out;
}

async function scanRemoteSessionsAsync() {
  const host = process.env.REMOTE_HOST || "";
  const user = process.env.REMOTE_USER || "";
  const key = process.env.SSH_PRIVATE_KEY || "";
  if (!host || !user || !key) {
    return { ok: false, reason: "no-remote-ssh-env (abra run gotchibot -- …)", sessions: [] };
  }
  const { runSsh, assertRemoteReady, materializeKey } = await import("./remote-lib.mjs");
  let cfg;
  let keyMat;
  try {
    cfg = assertRemoteReady();
    keyMat = materializeKey(cfg.key);
  } catch (e) {
    return { ok: false, reason: String(e.message || e).split("\n")[0], sessions: [] };
  }
  try {
    const script = [
      `cd ${shellQuote(cfg.dir)}`,
      `for d in sessions/s*/; do`,
      `  [ -f "$d/state.env" ] || continue`,
      `  id=$(basename "$d")`,
      `  st=$(grep -E '^status=' "$d/state.env" | head -1 | cut -d= -f2-)`,
      `  hero=$(grep -E '^hero=' "$d/state.env" | head -1 | cut -d= -f2-)`,
      `  model=$(grep -E '^model=' "$d/state.env" | head -1 | cut -d= -f2-)`,
      `  started=$(grep -E '^started=' "$d/state.env" | head -1 | cut -d= -f2-)`,
      `  printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$id" "$st" "$hero" "$model" "$started"`,
      `done`,
    ].join("\n");
    const r = runSsh(cfg, keyMat.path, script, { stdio: "pipe" });
    if (r.status !== 0) {
      return { ok: false, reason: (r.stderr || "ssh failed").slice(0, 200), sessions: [] };
    }
    const sessions = String(r.stdout || "")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [id, status, hero, model, started] = line.split("\t");
        return {
          kind: "session",
          host: "imac",
          id,
          status: status || "?",
          hero: hero || null,
          model: model || null,
          started: started || null,
        };
      })
      .sort((a, b) => String(b.started).localeCompare(String(a.started)));
    return { ok: true, sessions };
  } finally {
    keyMat?.dispose?.();
  }
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

async function loadHeroes() {
  const meta = loadMeta();
  const fromApi = [];
  if (meta?.cartridgeId) {
    try {
      const heroes = await fetchCartridgeHeroes(meta.cartridgeId);
      for (const h of heroes) {
        const thumb = resolveThumbCollateral(h.id, h.collateral || h.collateralAddress, h.hauntId);
        fromApi.push({
          kind: "hero",
          host: "cartridge",
          id: h.id,
          status: h.agentStatus || "available",
          hero: h.id,
          collateral: thumb.collateral || h.collateral || h.collateralAddress || null,
          hauntId: thumb.hauntId || h.hauntId || null,
          bindType: h.bindType || null,
          name: h.name || null,
          agentSessionId: h.agentSessionId || null,
          agentTask: h.agentTask || null,
        });
      }
    } catch {
      /* fall through to cache / meta */
    }
  }
  if (fromApi.length) return fromApi;

  try {
    const cache = JSON.parse(readFileSync(LIST_CACHE, "utf8"));
    const cached = (cache.entries || []).filter((e) => e.kind === "hero");
    if (cached.length) return cached;
  } catch {}

  try {
    const map = loadAgentMap();
    if (map?.agents) {
      const seen = new Set();
      const out = [];
      for (const [agentId, m] of Object.entries(map.agents)) {
        const id = m.heroId || agentId;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
          kind: "hero",
          host: "cartridge",
          id,
          status: m.isOrchestrator ? "active" : "available",
          hero: id,
          collateral: null,
          bindType: m.isOrchestrator ? "orchestrator" : "sub",
          name: null,
        });
      }
      if (out.length) return out;
    }
  } catch {}

  if (meta?.activeHeroId) {
    return [
      {
        kind: "hero",
        host: "cartridge",
        id: meta.activeHeroId,
        status: "available",
        hero: meta.activeHeroId,
        collateral: null,
        bindType: null,
        name: null,
      },
    ];
  }
  return [];
}

async function buildRoster({ syncFleet = false, useCacheMs = 0 } = {}) {
  if (useCacheMs > 0) {
    try {
      const cache = JSON.parse(readFileSync(LIST_CACHE, "utf8"));
      const age = Date.now() - new Date(cache.at).getTime();
      if (age >= 0 && age < useCacheMs && Array.isArray(cache.entries) && cache.entries.length) {
        return {
          numbered: cache.entries,
          remote: cache.remote ?? { ok: false, sessions: [] },
          heroes: cache.entries.filter((e) => e.kind === "hero").length,
          local: cache.entries.filter((e) => e.host === "local").length,
          cached: true,
        };
      }
    } catch {
      /* refresh below */
    }
  }

  const local = scanLocalSessions();
  const remote = await scanRemoteSessionsAsync();
  const heroes = await loadHeroes();
  const entries = [];
  for (const h of heroes) entries.push(h);
  for (const s of local) entries.push(s);
  for (const s of remote.sessions || []) entries.push(s);
  const numbered = entries.map((e, i) => ({ index: i + 1, ...e }));
  ensureSessions();
  writeFileSync(
    LIST_CACHE,
    `${JSON.stringify({ remote, entries: numbered, at: new Date().toISOString() }, null, 2)}\n`,
  );
  if (syncFleet) {
    try {
      const { syncFleet: sync } = await import("./openclaw-fleet.mjs");
      await sync({ quiet: true });
    } catch {
      /* OpenClaw fleet sync optional */
    }
  }
  return { numbered, remote, heroes: heroes.length, local: local.length, cached: false };
}

/** OpenCode primary agent from sessions/.agent-mode.json (gotchi|sub|verse|…). */
function openCodePrimaryMode() {
  try {
    const data = JSON.parse(readFileSync(`${ROOT}/sessions/.agent-mode.json`, "utf8"));
    const a = String(data.agent || "").toLowerCase();
    if (a === "sub-agent" || a === "subagent") return "sub";
    return a || "gotchi";
  } catch {
    return "gotchi";
  }
}

function isOrchHeroEntry(e, orchId = orchestratorHeroId()) {
  if (!e || e.kind !== "hero") return false;
  if (e.bindType === "orchestrator") return true;
  const id = e.id || e.hero;
  return id && id === orchId;
}

/** Roster for Sub desk — heroes excluding orchestrator; renumbered for /switch. */
function forSubDesk(roster) {
  const orch = orchestratorHeroId();
  const numbered = (roster.numbered || [])
    .filter((e) => !isOrchHeroEntry(e, orch))
    .map((e, i) => ({ ...e, index: i + 1 }));
  return {
    ...roster,
    numbered,
    heroes: numbered.filter((e) => e.kind === "hero").length,
    subDesk: true,
  };
}

function printRoster({ numbered, remote }, { switchMode = false, subDesk = false } = {}) {
  console.log(
    switchMode
      ? subDesk
        ? "GotchiBot /switch — sub-agents only (orch excluded)"
        : "GotchiBot /switch — pick an agent (avatar + direct chat)"
      : subDesk
        ? "GotchiBot agents — sub desk (orch excluded)"
        : "GotchiBot agents — select with: /switch <n|id>   or   ./scripts/agent-focus.mjs switch <n|id>",
  );
  console.log("");

  const heroes = numbered.filter((e) => e.kind === "hero");
  const local = numbered.filter((e) => e.host === "local");
  const imac = numbered.filter((e) => e.host === "imac");

  if (heroes.length) {
    console.log(
      subDesk
        ? "cAavegotchis — sub roster (OpenClaw agent id = hero id)"
        : "cAavegotchis (OpenClaw agent id = hero id)",
    );
    for (const e of heroes) {
      const coll = e.collateral ? ` · ${String(e.collateral).slice(0, 12)}` : "";
      const bt = e.bindType ? ` · ${e.bindType}` : "";
      const st = e.status || e.agentStatus ? ` [${e.status || e.agentStatus}]` : "";
      console.log(`  ${String(e.index).padStart(2)}. ${e.id}${bt}${coll}${st}`);
    }
    console.log("");
  }

  console.log("Local MBP sessions");
  if (!local.length) console.log("  (none)");
  for (const e of local) {
    console.log(
      `  ${String(e.index).padStart(2)}. ${e.id}  [${e.status}]  hero=${e.hero || "—"}`,
    );
  }
  console.log("");

  console.log("Remote iMac sessions");
  if (!remote.ok) {
    console.log(`  (unreachable: ${remote.reason})`);
    console.log("  tip: abra run gotchibot -- ./scripts/gotchibot agents");
  } else if (!imac.length) {
    console.log("  (none)");
  }
  for (const e of imac) {
    console.log(
      `  ${String(e.index).padStart(2)}. ${e.id}  [${e.status}]  hero=${e.hero || "—"}`,
    );
  }
  console.log("");

  const focus = loadFocus();
  if (focus.mode === "sub") {
    console.log(
      `Focus: SUB  hero=${focus.heroId || "—"}  session=${focus.sessionId || "—"}  host=${focus.host || "—"}`,
    );
  } else {
    console.log("Focus: ORCH (orchestrator)");
  }
  if (switchMode) {
    console.log("Next: /switch <n|id>   ·   back: /orch");
  } else {
    console.log("Switch: /switch <n|id>   ·   back: /orch");
  }
}

function shortModel(model) {
  const m = String(model || "").trim();
  if (!m) return "";
  if (m.includes("/")) return m.split("/").pop();
  return m.length > 28 ? `${m.slice(0, 25)}…` : m;
}

function statusCounts(entries) {
  const counts = {};
  for (const e of entries) {
    const s = String(e.status || "?").toLowerCase();
    counts[s] = (counts[s] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([s, n]) => `${n} ${s}`)
    .join(" · ");
}

/** Full cockpit roster — cAavegotchis, MBP/iMac OpenCode sessions, OpenClaw fleet. */
export function printCockpitRoster({ numbered, remote, cached }) {
  const heroes = numbered.filter((e) => e.kind === "hero");
  const local = numbered.filter((e) => e.host === "local");
  const imac = numbered.filter((e) => e.host === "imac");

  console.log("OpenClaw agent roster — MBP (local) + iMac (remote)");
  if (cached) console.log("(refreshing live scan…)\n");
  else console.log("");

  try {
    const map = loadAgentMap();
    const focus = loadOpenClawFocus();
    console.log(`Gateway  ${gatewayUrl()}`);
    if (map?.agents) {
      console.log("Fleet    OpenClaw agents (orchestrator + sub-agents)");
      for (const [agentId, m] of Object.entries(map.agents)) {
        const tag = m.isOrchestrator || agentId === map.orchestratorAgentId ? "orch" : "sub";
        const alias = m.aliasOf ? ` → ${m.aliasOf}` : "";
        console.log(`  ${agentId} [${tag}] hero=${m.heroId || "—"}${alias}`);
      }
    } else {
      console.log("Fleet    (no map — run ./scripts/openclaw-fleet.mjs sync)");
    }
    if (focus) {
      console.log(
        `Focus    ${focus.mode === "sub" ? `SUB agent=${focus.agentId} hero=${focus.heroId}` : "ORCH orchestrator"}`,
      );
    }
    console.log("");
  } catch {
    /* OpenClaw fleet optional */
  }

  if (heroes.length) {
    console.log(`cAavegotchis (${heroes.length}) — cartridge identities`);
    for (const e of heroes) {
      const coll = e.collateral ? ` · ${String(e.collateral).slice(0, 10)}` : "";
      const bt = e.bindType ? ` · ${e.bindType}` : "";
      const st = e.status || e.agentStatus || "available";
      const sess = e.agentSessionId ? ` · session ${e.agentSessionId}` : "";
      const task = e.agentTask ? ` · ${String(e.agentTask).slice(0, 40)}` : "";
      console.log(`  ${String(e.index).padStart(2)}. ${e.id} [${st}]${bt}${coll}${sess}${task}`);
    }
    console.log("");
  }

  console.log(`MBP sessions (${local.length})${local.length ? ` — ${statusCounts(local)}` : ""}`);
  if (!local.length) console.log("  (none)");
  for (const e of local) {
    const model = shortModel(e.model);
    const modelBit = model ? ` · ${model}` : "";
    console.log(
      `  ${String(e.index).padStart(2)}. ${e.id} [${e.status}] hero=${e.hero || "—"}${modelBit}`,
    );
  }
  console.log("");

  console.log(`iMac sessions (${imac.length})`);
  if (!remote.ok) {
    console.log(`  (unreachable: ${remote.reason})`);
    console.log("  tip: abra run gotchibot -- ./scripts/gotchibot agents");
  } else if (!imac.length) {
    console.log(`  (none)${remote.ok ? "" : ""}`);
  } else {
    console.log(`  ${statusCounts(imac)}`);
    for (const e of imac) {
      const model = shortModel(e.model);
      const modelBit = model ? ` · ${model}` : "";
      console.log(
        `  ${String(e.index).padStart(2)}. ${e.id} [${e.status}] hero=${e.hero || "—"}${modelBit}`,
      );
    }
  }
  console.log("");

  const focus = loadFocus();
  if (focus.mode === "sub") {
    console.log(
      `Chat focus: SUB → ${focus.heroId || "—"} (${focus.host || "—"}) session=${focus.sessionId || "—"}`,
    );
  } else {
    console.log("Chat focus: ORCH (orchestrator)");
  }
  console.log("");
  console.log("Switch agent: /switch <n|id>   ·   mesh: ./scripts/gotchibot mesh --live");
}

export async function showCockpitRoster() {
  const roster = await buildRoster({ syncFleet: true, useCacheMs: 0 });
  printCockpitRoster(roster);
  return roster;
}

function csvCell(value) {
  const s = value == null ? "" : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function defaultRosterCsvPath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${SESSIONS}/roster-${stamp}.csv`;
}

/** Flatten roster entries (+ OpenClaw fleet) into CSV rows. */
export function rosterToCsv(roster) {
  const exportedAt = new Date().toISOString();
  const headers = [
    "index",
    "kind",
    "host",
    "id",
    "status",
    "hero",
    "model",
    "collateral",
    "bind_type",
    "name",
    "agent_session_id",
    "task",
    "started",
    "exported_at",
  ];
  const rows = [headers.join(",")];
  const seen = new Set();

  const pushEntry = (e, index = e.index ?? "") => {
    const id = String(e.id || "");
    if (id) seen.add(id);
    rows.push(
      [
        index,
        e.kind || "",
        e.host || "",
        id,
        e.status || e.agentStatus || "",
        e.hero || "",
        e.model || "",
        e.collateral || "",
        e.bindType || "",
        e.name || "",
        e.agentSessionId || "",
        e.agentTask || "",
        e.started || "",
        exportedAt,
      ]
        .map(csvCell)
        .join(","),
    );
  };

  for (const e of roster.numbered || []) pushEntry(e);

  try {
    const map = loadAgentMap();
    for (const [agentId, m] of Object.entries(map?.agents || {})) {
      if (seen.has(agentId) || (m.heroId && seen.has(m.heroId))) continue;
      pushEntry({
        kind: "fleet",
        host: "openclaw",
        id: agentId,
        status: m.isOrchestrator ? "orchestrator" : "sub",
        hero: m.heroId || "",
        bindType: m.aliasOf ? `alias:${m.aliasOf}` : m.isOrchestrator ? "orch" : "sub",
      });
    }
  } catch {
    /* fleet optional */
  }

  return `${rows.join("\n")}\n`;
}

export async function exportRosterCsv(outPath, { syncFleet = true } = {}) {
  const roster = await buildRoster({ syncFleet, useCacheMs: 0 });
  const csv = rosterToCsv(roster);
  const path = outPath?.trim() || defaultRosterCsvPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, csv, "utf8");
  return {
    path,
    rowCount: Math.max(0, csv.trim().split("\n").length - 1),
    roster,
  };
}

function resolveEntry(arg, hostFilter, { subDesk = false } = {}) {
  let cache;
  try {
    cache = JSON.parse(readFileSync(LIST_CACHE, "utf8"));
  } catch {
    cache = null;
  }
  let all = cache?.entries || [];
  if (subDesk) {
    const orch = orchestratorHeroId();
    all = all
      .filter((e) => !isOrchHeroEntry(e, orch))
      .map((e, i) => ({ ...e, index: i + 1 }));
  }
  const entries = all.filter((e) =>
    hostFilter ? e.host === hostFilter || (hostFilter === "local" && e.host === "cartridge") : true,
  );
  if (/^\d+$/.test(arg)) {
    const n = Number(arg);
    const hit = all.find((e) => e.index === n);
    if (!hit) throw new Error(`no entry #${n} — run list first`);
    return hit;
  }
  const hit = all.find((e) => e.id === arg) || entries.find((e) => e.id === arg);
  if (hit) return hit;
  // Allow selecting a hero id even without fresh list
  if (arg.startsWith("starter-") || arg.startsWith("owned-") || arg.startsWith("s20")) {
    if (subDesk && (arg === orchestratorHeroId() || arg === "owned-954")) {
      throw new Error("orch excluded in Sub mode — Tab to gotchi or /orch");
    }
    return {
      kind: arg.startsWith("s20") ? "session" : "hero",
      host: arg.startsWith("s20") ? "local" : "cartridge",
      id: arg,
      hero: arg.startsWith("s20") ? null : arg,
      status: "?",
    };
  }
  throw new Error(`unknown id ${arg} — run list first`);
}

function orchestratorHeroId() {
  const ob = loadOnboarding();
  const meta = loadMeta();
  // Prefer owned-* orchestrator; ignore starter-* left over from a bad pin
  if (ob.orchestratorHeroId && String(ob.orchestratorHeroId).startsWith("owned-")) {
    return ob.orchestratorHeroId;
  }
  try {
    const cache = JSON.parse(readFileSync(LIST_CACHE, "utf8"));
    const owned = (cache.entries || []).find(
      (e) => e.kind === "hero" && String(e.id).startsWith("owned-"),
    );
    if (owned) return owned.id;
  } catch {}
  if (meta?.activeHeroId && String(meta.activeHeroId).startsWith("owned-")) {
    return meta.activeHeroId;
  }
  if (ob.orchestratorHeroId) return ob.orchestratorHeroId;
  return meta?.activeHeroId || "owned-954";
}

async function cmdSelect(arg, { host, via = "select", respawn = false } = {}) {
  if (!arg) {
    console.error(`usage: agent-focus.mjs ${via} <index|id> [--respawn]`);
    process.exit(2);
  }
  const subDesk = openCodePrimaryMode() === "sub";
  // Always refresh roster so indexes match what the user just saw
  await buildRoster({ syncFleet: true, useCacheMs: 0 });
  const entry = resolveEntry(arg, host, { subDesk });
  let heroId = entry.hero || (entry.kind === "hero" ? entry.id : null);
  let sessionId = entry.kind === "session" ? entry.id : null;

  if (entry.kind === "session" && !heroId) {
    const st =
      entry.host === "local"
        ? `${SESSIONS}/${entry.id}/state.env`
        : null;
    if (st) heroId = field(st, "hero") || null;
  }

  if (!heroId && entry.kind === "hero") heroId = entry.id;
  if (!heroId) {
    console.error(`cannot pin avatar — no hero on ${entry.id}`);
    process.exit(1);
  }

  // Selecting the orchestrator hero returns to ORCH focus (not from Sub desk)
  if (heroId === orchestratorHeroId() && entry.kind === "hero") {
    if (subDesk) {
      console.error("orch excluded in Sub mode — Tab to gotchi, or: ./scripts/gotchibot mode gotchi");
      console.error("then /orch if you only need ORCH chat focus");
      process.exit(2);
    }
    await cmdOrch({ respawn });
    return;
  }

  pinAvatar(heroId, { asOrchestrator: false });
  signalAvatar(heroId);
  saveMeta({
    activeHeroId: heroId,
    sessionHeroes: {
      ...(loadMeta()?.sessionHeroes || {}),
      ...(sessionId ? { [sessionId]: heroId } : {}),
    },
  });
  const hostLabel =
    entry.host === "imac" ? "imac" : entry.host === "local" ? "local" : "local";
  saveFocus({
    mode: "sub",
    heroId,
    sessionId,
    host: hostLabel,
    kind: entry.kind,
    label: entry.id,
    openclawAgentId: heroId,
  });

  try {
    const { switchOpenClawAgent } = await import("./openclaw-fleet.mjs");
    await switchOpenClawAgent(heroId);
  } catch {
    /* OpenClaw optional */
  }

  // Cartridge: spun up, waiting for prompts
  try {
    spawnSync(
      process.execPath,
      [
        `${ROOT}/scripts/hero-agent-state.mjs`,
        "set",
        heroId,
        "idle",
        "--host",
        hostLabel,
        ...(sessionId ? ["--session", sessionId] : []),
        "--task",
        `focused via /${via}`,
      ],
      { cwd: ROOT, stdio: "ignore", env: process.env },
    );
  } catch {}

  console.log(`switched → ${entry.id}`);
  console.log(`avatar  → ${heroId}`);
  console.log(`host    → ${hostLabel}`);
  console.log(`focus   → SUB (OpenClaw agent ${heroId})`);
  console.log("");
  console.log("DIRECT_CHAT=1 — every following user message goes to this OpenClaw agent:");
  console.log(`  ./scripts/agent-focus.mjs chat --sub "<their message>"`);
  console.log("  (OpenClaw only — no auto dispatch; --dispatch / --spawn / GOTCHIBOT_SUB_CHAT_DISPATCH=1 to force)");
  console.log("Back to orchestrator: /orch   or   ./scripts/agent-focus.mjs orch");
  if (respawn) respawnChatPane();
  else console.log("pane    kept (use --respawn to reload OpenCode)");
}

/** /switch — list all agents, or switch to one (avatar + direct chat). */
async function cmdSwitch(arg, { host, json, respawn = false } = {}) {
  if (!arg) {
    let roster = await buildRoster({ syncFleet: false, useCacheMs: 30_000 });
    const subDesk = openCodePrimaryMode() === "sub";
    if (subDesk) roster = forSubDesk(roster);
    if (json) {
      console.log(JSON.stringify(roster, null, 2));
    } else {
      printRoster(roster, { switchMode: true, subDesk });
      if (roster.cached) {
        console.log("(cached roster — run /switch again to refresh remote sessions)");
      }
    }
    return;
  }
  await cmdSelect(arg, { host, via: "switch", respawn });
}

function respawnChatPane(extraEnv = {}) {
  if (!process.env.TMUX) return;
  const sess = process.env.GOTCHIBOT_TMUX_SESSION || "gotchibot";
  const envParts = Object.entries(extraEnv).map(([k, v]) => `${k}=${JSON.stringify(String(v))}`);
  const prefix = envParts.length ? `${envParts.join(" ")} ` : "";
  spawnSync(
    "tmux",
    [
      "respawn-pane",
      "-t",
      `${sess}:work.1`,
      "-k",
      `cd "${ROOT}" && ${prefix}exec ./scripts/chat-pane.sh`,
    ],
    { stdio: "ignore" },
  );
}

async function cmdCockpit() {
  if (process.env.TMUX) {
    runLayout("enter-chat-max");
    console.log("Opening GotchiBot cockpit in chat pane…");
    console.log("  mint cAavegotchi · change orchestrator avatar · return to chat");
    respawnChatPane({ GOTCHIBOT_COCKPIT: "1" });
    return;
  }
  console.log("Opening GotchiBot cockpit…");
  const r = spawnSync(process.execPath, [`${ROOT}/scripts/onboarding-gate.mjs`, "--cockpit"], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

async function cmdMeet() {
  if (process.env.TMUX) {
    console.log("Opening GotchiBot meeting room (Zoom gallery)…");
    respawnChatPane({ GOTCHIBOT_MEET: "1" });
    return;
  }
  console.log("Opening GotchiBot meeting room…");
  const r = spawnSync(process.execPath, [`${ROOT}/scripts/onboarding-gate.mjs`, "--meet"], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

async function cmdOrch({ respawn = false } = {}) {
  const heroId = orchestratorHeroId();
  pinAvatar(heroId, { asOrchestrator: true });
  signalAvatar(heroId);
  saveMeta({ activeHeroId: heroId });
  saveFocus({
    mode: "orch",
    heroId,
    sessionId: null,
    host: null,
    kind: null,
    openclawAgentId: heroId,
  });
  try {
    const { switchOpenClawAgent } = await import("./openclaw-fleet.mjs");
    await switchOpenClawAgent(heroId);
  } catch {
    /* OpenClaw optional */
  }
  console.log(`orchestrator focus restored`);
  console.log(`avatar → ${heroId}`);
  console.log(`OpenClaw agent → ${heroId}`);
  if (respawn) respawnChatPane();
  else console.log("pane    kept (use --respawn to reload OpenCode)");
}

function cmdStatus(json) {
  const focus = loadFocus();
  const pin = existsSync(PIN) ? readFileSync(PIN, "utf8").trim() : null;
  const payload = { focus, pin };
  if (json) console.log(JSON.stringify(payload, null, 2));
  else if (focus.mode === "sub") {
    console.log(
      `SUB focus hero=${focus.heroId} session=${focus.sessionId || "—"} host=${focus.host || "—"} pin=${pin || "—"}`,
    );
  } else {
    console.log(`ORCH focus hero=${focus.heroId || pin || "—"}`);
  }
}

function ensureGotchiAgentMode({ restart = false } = {}) {
  const args = [`${ROOT}/scripts/agent-mode.mjs`, "set", "gotchi"];
  if (restart) args.push("--restart");
  spawnSync(process.execPath, args, { cwd: ROOT, stdio: "ignore" });
}

/**
 * Switch SUB → ORCH + gotchi mode and hand the prompt back to the orchestrator.
 * By default does not spawn — the gotchi agent continues with the same prompt.
 * Pass spawn:true (CLI --spawn) to fan out immediately.
 */
async function escalateToOrch(prompt, { reason, spawn = false } = {}) {
  await cmdOrch();
  let mode = "gotchi";
  try {
    mode =
      spawnSync(process.execPath, [`${ROOT}/scripts/agent-mode.mjs`, "get"], {
        cwd: ROOT,
        encoding: "utf8",
      }).stdout?.trim() || "gotchi";
  } catch {}
  ensureGotchiAgentMode({ restart: mode !== "gotchi" });

  const payload = {
    escalated: true,
    route: "orch",
    reason: reason || "orch task",
    prompt: prompt.trim(),
    mode: "gotchi",
  };
  console.log(`escalated → orchestrator (${payload.reason})`);
  console.log(`gotchi mode + ORCH focus restored`);
  console.log(`prompt: ${payload.prompt}`);
  console.log(JSON.stringify(payload));

  if (!spawn) {
    console.log("");
    console.log("Continue as orchestrator: delegate-pick → spawn this prompt.");
    return;
  }

  const env = {
    ...process.env,
    GOTCHIBOT_SKIP_ABRA: process.env.GOTCHIBOT_SKIP_ABRA || "1",
    GOTCHIBOT_AUTO_APPROVE: "1",
  };
  delete env.GOTCHIBOT_HERO_ID;
  const wrapped = [
    `You are this cAavegotchi, spawned by the orchestrator. Speak in first person (I, me, my).`,
    `User task (escalated from SUB focus): ${prompt.trim()}`,
    `Write deliverable to sessions/<id>/output.md. Follow AGENTS.md.`,
  ].join("\n");
  const orchPath = `${ROOT}/scripts/gotchi-orchestrate.mjs`;
  const r = existsSync(orchPath)
    ? spawnSync(process.execPath, [orchPath, "spawn", "--model", "sub", wrapped], {
        cwd: ROOT,
        env,
        encoding: "utf8",
      })
    : spawnSync(`${ROOT}/scripts/opencode-dispatch.sh`, ["new", "--model", "sub", wrapped], {
        cwd: ROOT,
        env,
        encoding: "utf8",
      });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.status ?? 1);
}

async function cmdChat(prompt, { force, spawnOnEscalate = false } = {}) {
  const focus = loadFocus();
  if (!prompt?.trim()) {
    console.error('usage: agent-focus.mjs chat "prompt" [--orch|--sub] [--spawn]');
    process.exit(2);
  }

  const classification = classifyFocusRoute(prompt);
  const shouldEscalate =
    force === "orch" ||
    (force !== "sub" && focus.mode === "sub" && classification.route === "orch");

  if (shouldEscalate) {
    await escalateToOrch(prompt, {
      reason: force === "orch" ? "forced --orch" : classification.reason,
      spawn: spawnOnEscalate,
    });
    return;
  }

  if (focus.mode !== "sub") {
    console.error("not in sub-agent focus — already ORCH; handle as orchestrator (delegate-pick / spawn)");
    console.log(
      JSON.stringify({
        escalated: false,
        route: "orch",
        reason: "already-orch",
        prompt: prompt.trim(),
      }),
    );
    return;
  }

  const agentId = focus.openclawAgentId || focus.heroId;
  const allowDispatch =
    spawnOnEscalate ||
    process.env.GOTCHIBOT_SUB_CHAT_DISPATCH === "1" ||
    process.argv.includes("--dispatch");

  try {
    const { chatViaOpenClaw, gatewayReachable } = await import("./openclaw-fleet.mjs");
    if (await gatewayReachable()) {
      console.log(`sub chat → OpenClaw agent ${agentId} (${classification.reason})`);
      const oc = await chatViaOpenClaw(agentId, prompt.trim());
      if (oc.ok) {
        if (oc.stdout) process.stdout.write(oc.stdout);
        return;
      }
      console.error(
        `openclaw chat failed (${oc.reason}${oc.httpFallback ? `; http=${oc.httpFallback}` : ""})`,
      );
      if (!allowDispatch) {
        console.error(
          "hint: fix OpenClaw gateway / run openclaw doctor — dispatch fallback is off (pass --dispatch or GOTCHIBOT_SUB_CHAT_DISPATCH=1 to force)",
        );
        process.exit(1);
      }
      console.error("falling back to opencode dispatch (--dispatch)");
    } else if (!allowDispatch) {
      console.error("openclaw gateway unreachable — cannot chat while SUB-focused");
      console.error(
        "hint: check Tailscale / openclaw status; dispatch fallback is off (pass --dispatch to force)",
      );
      process.exit(1);
    }
  } catch (e) {
    if (!allowDispatch) {
      console.error(`openclaw chat error: ${e?.message || e}`);
      process.exit(1);
    }
  }

  const env = {
    ...process.env,
    GOTCHIBOT_HERO_ID: focus.heroId || "",
    GOTCHIBOT_SKIP_ABRA: process.env.GOTCHIBOT_SKIP_ABRA || "1",
    GOTCHIBOT_AUTO_APPROVE: "1",
  };

  const wrapped = [
    `You are ${focus.heroId || focus.label}. Speak in first person (I, me, my). You are this gotchi, not a narrator and not the orchestrator.`,
    focus.sessionId ? `Prior session: ${focus.sessionId} (host=${focus.host}).` : "",
    `User message: ${prompt.trim()}`,
    `Write deliverable to sessions/<new-id>/output.md. Follow AGENTS.md.`,
  ]
    .filter(Boolean)
    .join("\n");

  if (focus.host === "imac") {
    console.log(`sub chat → ${focus.heroId || focus.label} on imac (dispatch fallback)`);
    const r = spawnSync(
      process.execPath,
      [
        `${ROOT}/scripts/remote-spawn.mjs`,
        "--model",
        "nim",
        ...(focus.heroId ? ["--hero", focus.heroId] : []),
        wrapped,
      ],
      { cwd: ROOT, env, encoding: "utf8" },
    );
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    process.exit(r.status ?? 1);
  }

  console.log(`sub chat → ${focus.heroId || focus.label} local (dispatch fallback)`);
  const r = spawnSync(
    `${ROOT}/scripts/opencode-dispatch.sh`,
    ["new", "--model", "sub", wrapped],
    { cwd: ROOT, env, encoding: "utf8" },
  );
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.status ?? 1);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const json = rest.includes("--json") || process.argv.includes("--json");

  if (!cmd || cmd === "list" || cmd === "agents") {
    const hostIdx = rest.indexOf("--host");
    let roster = await buildRoster({ syncFleet: false, useCacheMs: 30_000 });
    const subDesk = openCodePrimaryMode() === "sub";
    if (subDesk) roster = forSubDesk(roster);
    if (json) {
      console.log(JSON.stringify(roster, null, 2));
    } else {
      printRoster(roster, { subDesk });
    }
    return;
  }

  if (cmd === "select" || cmd === "focus") {
    const hostIdx = rest.indexOf("--host");
    const host = hostIdx >= 0 ? rest[hostIdx + 1] : null;
    // Opt-in pane kill; --no-respawn/--no-restart kept as accepted no-ops (compat)
    const respawn = rest.includes("--respawn") || rest.includes("--restart");
    const skip = new Set([
      "--host",
      "--json",
      "--respawn",
      "--restart",
      "--no-respawn",
      "--no-restart",
    ]);
    if (host) skip.add(host);
    const arg = rest.find((a) => !skip.has(a));
    await cmdSelect(arg, { host, respawn });
    return;
  }

  if (cmd === "switch") {
    const hostIdx = rest.indexOf("--host");
    const host = hostIdx >= 0 ? rest[hostIdx + 1] : null;
    const respawn = rest.includes("--respawn") || rest.includes("--restart");
    const skip = new Set([
      "--host",
      "--json",
      "--respawn",
      "--restart",
      "--no-respawn",
      "--no-restart",
    ]);
    if (host) skip.add(host);
    const arg = rest.find((a) => !skip.has(a));
    await cmdSwitch(arg, { host, json, respawn });
    return;
  }

  if (cmd === "orch" || cmd === "orchestrator") {
    const respawn = rest.includes("--respawn") || rest.includes("--restart");
    await cmdOrch({ respawn });
    return;
  }

  if (cmd === "roster" || cmd === "view-roster") {
    const csvFlag = rest.includes("--csv") || rest.includes("--export");
    if (csvFlag) {
      const pathArg = rest.find((a) => a !== "--csv" && a !== "--export" && a !== "--json" && !a.startsWith("-"));
      const { path, rowCount } = await exportRosterCsv(pathArg);
      if (json) console.log(JSON.stringify({ ok: true, path, rowCount }, null, 2));
      else {
        console.log(`✓ roster exported → ${path} (${rowCount} rows)`);
        try {
          const copied = spawnSync(process.execPath, [`${ROOT}/scripts/clipboard-copy.mjs`, path], {
            cwd: ROOT,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          });
          if (copied.status === 0) console.log(`✓ ${(copied.stdout || "").trim() || "path copied to clipboard"}`);
        } catch {
          /* optional */
        }
      }
      return;
    }
    if (json) {
      const roster = await buildRoster({ syncFleet: true, useCacheMs: 0 });
      console.log(JSON.stringify(roster, null, 2));
    } else {
      await showCockpitRoster();
    }
    return;
  }

  if (cmd === "cockpit" || cmd === "onboarding") {
    await cmdCockpit();
    return;
  }

  if (cmd === "meet" || cmd === "meeting") {
    await cmdMeet();
    return;
  }

  if (cmd === "status") {
    cmdStatus(json);
    return;
  }

  if (cmd === "classify") {
    const prompt = rest.filter((a) => a !== "--json").join(" ").trim();
    const result = classifyFocusRoute(prompt);
    if (json) console.log(JSON.stringify(result));
    else console.log(result.route);
    return;
  }

  if (cmd === "chat") {
    const forceOrch = rest.includes("--orch");
    const forceSub = rest.includes("--sub");
    const spawnOnEscalate = rest.includes("--spawn");
    const prompt = rest
      .filter(
        (a) =>
          a !== "--json" &&
          a !== "--orch" &&
          a !== "--sub" &&
          a !== "--spawn" &&
          a !== "--dispatch",
      )
      .join(" ")
      .trim();
    await cmdChat(prompt, {
      force: forceOrch ? "orch" : forceSub ? "sub" : null,
      spawnOnEscalate,
    });
    return;
  }

  console.error(`usage:
  agent-focus.mjs list [--json]
  agent-focus.mjs switch [index|id] [--respawn]  # list, or headless avatar+SUB focus (pane stays up)
  agent-focus.mjs select <index|id> [--respawn]  # same; --respawn/--restart reloads OpenCode pane
  agent-focus.mjs orch [--respawn]               # headless ORCH focus; --respawn reloads pane
  agent-focus.mjs roster              # full MBP + iMac OpenClaw roster (cockpit)
  agent-focus.mjs roster --csv [path] # export roster to CSV (default: sessions/roster-<timestamp>.csv)
  agent-focus.mjs cockpit              # mint / change orchestrator avatar menu (respawns pane)
  agent-focus.mjs meet                 # shared meeting room menu (respawns pane)
  agent-focus.mjs status [--json]
  agent-focus.mjs classify "prompt" [--json]
  agent-focus.mjs chat "prompt" [--orch|--sub] [--spawn] [--dispatch]
    # SUB chat = OpenClaw only by default; --dispatch enables opencode-dispatch fallback`);
  process.exit(2);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
