#!/usr/bin/env node
/**
 * Push cAavegotchi agentStatus to the AarcadeGh-t cartridge sim.
 *
 * Statuses:
 *   available — not spun up as an agent
 *   active    — spun up with an assignment
 *   working   — currently building / computing
 *   assigned  — ongoing task that may need a cron
 *   idle      — assigned a role but not currently in a live session
 *   watching  — cron / wait loop
 *
 * usage:
 *   abra run gotchibot -- node scripts/hero-agent-state.mjs set <heroId> <status> [--session id] [--task "…"] [--model m] [--host local|imac]
 *   abra run gotchibot -- node scripts/hero-agent-state.mjs sync
 *   abra run gotchibot -- node scripts/hero-agent-state.mjs get [heroId]
 */
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { call } from "./identity.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = `${ROOT}/sessions`;
const CACHE = `${SESSIONS}/.hero-agent-state.json`;
const ONBOARDING = `${SESSIONS}/.onboarding.json`;
const FOCUS = `${SESSIONS}/.focus.json`;
const STATUSES = ["available", "active", "working", "assigned", "idle", "watching"];


/** Standing / cron-backed task (monitor, watch, trader desk, schedule). */
export function looksStandingTask(text) {
  const t = String(text || "").toLowerCase();
  return /\b(cron|crontab|monitor|watch(?:ing|er)?|schedul|standing|trader|loop|daily|hourly|every\s+\d)\b/.test(t);
}

function orchestratorHeroId(heroes = []) {
  try {
    const ob = JSON.parse(readFileSync(ONBOARDING, "utf8"));
    if (ob.orchestratorHeroId && heroes.some((h) => h.id === ob.orchestratorHeroId)) {
      return ob.orchestratorHeroId;
    }
  } catch {}
  try {
    const focus = JSON.parse(readFileSync(FOCUS, "utf8"));
    if (focus.mode === "orch" && focus.heroId && heroes.some((h) => h.id === focus.heroId)) {
      return focus.heroId;
    }
  } catch {}
  const owned = heroes.find((h) => String(h.id).startsWith("owned-"));
  return owned?.id || heroes[0]?.id || null;
}

/** Live OpenCode gotchi TUI / serve → orchestrator is working. */
function detectLiveGotchiOpenCode() {
  const ps = spawnSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" });
  if (ps.status !== 0) return null;
  const lines = (ps.stdout || "").split("\n");
  for (const line of lines) {
    if (!/opencode\b/i.test(line)) continue;
    if (/\bserve\b/i.test(line)) continue; // headless serve alone ≠ active chat
    if (/--agent\s+gotchi\b|\bagent gotchi\b/i.test(line) || /\/GotchiBot\b/i.test(line)) {
      const pid = line.trim().split(/\s+/)[0];
      return { pid, host: "local", task: "opencode gotchi (live TUI)" };
    }
  }
  return null;
}

async function detectImacGotchiOpenCode() {
  const host = process.env.REMOTE_HOST?.trim();
  if (!host) return null;
  const user = process.env.OPENCODE_SERVER_USERNAME || "opencode";
  const pass = process.env.OPENCODE_SERVER_PASSWORD || "";
  const port = process.env.GOTCHIBOT_OPENCODE_PORT || "4096";
  const headers = {};
  if (pass) {
    headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
  }
  try {
    const res = await fetch(`http://${host}:${port}/api/session`, {
      headers,
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const rows = j?.data || [];
    const now = Date.now();
    const fresh = rows
      .filter((s) => s?.agent === "gotchi")
      .map((s) => ({
        id: s.id,
        updated: s?.time?.updated || 0,
        title: s?.title || "",
        model: s?.model?.id,
      }))
      .filter((s) => s.updated && now - s.updated < 45 * 60 * 1000)
      .sort((a, b) => b.updated - a.updated);
    if (!fresh.length) return null;
    return {
      sessionId: fresh[0].id,
      host: "imac",
      task: fresh[0].title || "opencode gotchi on iMac",
      model: fresh[0].model,
    };
  } catch {
    return null;
  }
}

function loadMeta() {
  try {
    return JSON.parse(readFileSync(`${SESSIONS}/.identity.json`, "utf8"));
  } catch {
    return null;
  }
}

function field(dir, key) {
  try {
    const line = readFileSync(`${dir}/state.env`, "utf8")
      .split("\n")
      .find((l) => l.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1) : "";
  } catch {
    return "";
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function writeLocalCache(heroId, status, extra = {}) {
  mkdirSync(SESSIONS, { recursive: true });
  let cache = {};
  try {
    cache = JSON.parse(readFileSync(CACHE, "utf8"));
  } catch {}
  const prev = cache[heroId] || {};
  cache[heroId] = {
    ...prev,
    status,
    sessionId: extra.sessionId || extra.session || prev.sessionId || null,
    task: extra.task !== undefined ? extra.task : (prev.task || null),
    model: extra.model || prev.model || null,
    host: extra.host || prev.host || null,
    collateral: extra.collateral || prev.collateral || null,
    collateralAddress: extra.collateralAddress || prev.collateralAddress || null,
    collateralName: extra.collateralName || prev.collateralName || null,
    hauntId: extra.hauntId ?? prev.hauntId ?? null,
    primary: extra.primary || prev.primary || null,
    secondary: extra.secondary || prev.secondary || null,
    sourceTokenId: extra.sourceTokenId || prev.sourceTokenId || null,
    at: new Date().toISOString(),
  };
  // A no-op sync must not touch the file: a fresh `at` alone used to churn the
  // cache every few seconds, which the avatar pane read as "state moved" and
  // repainted on. Keep the previous `at` when nothing else changed.
  const stable = (o) => JSON.stringify({ ...o, at: null });
  if (stable(prev) === stable(cache[heroId])) {
    if (prev.at) cache[heroId].at = prev.at;
    if (existsSync(CACHE)) return;
  }
  writeFileSync(CACHE, `${JSON.stringify(cache, null, 2)}\n`);
}

export async function setHeroAgentStatus(heroId, status, extra = {}) {
  const st = String(status || "").toLowerCase();
  if (!STATUSES.includes(st)) {
    throw new Error(`invalid status "${status}" (want ${STATUSES.join("|")})`);
  }
  const body = {
    status: st,
    sessionId: extra.sessionId || undefined,
    task: extra.task || undefined,
    model: extra.model || undefined,
    host: extra.host || undefined,
  };
  // Local cache first so the avatar pane flips even if the sim POST fails.
  writeLocalCache(heroId, st, extra);

  const meta = loadMeta();
  if (!meta?.cartridgeId) {
    return { ok: true, cached: true, heroId, agentStatus: st };
  }
  if (!process.env.AARCADE_GOTCHIBOT_SERVICE_SECRET) {
    return { ok: true, cached: true, heroId, agentStatus: st };
  }

  const r = await call(`/cartridges/${meta.cartridgeId}/heroes/${encodeURIComponent(heroId)}/agent-status`, {
    method: "POST",
    body,
  });
  if (!r.ok) {
    return {
      ok: true,
      cached: true,
      heroId,
      agentStatus: st,
      simError:
        r.data?.error ||
        (typeof r.data?.raw === "string" ? r.data.raw.slice(0, 120) : null) ||
        `HTTP ${r.status}`,
    };
  }
  return r.data;
}

/** Derive status from local (+cached remote) sessions and push to sim. */
export async function syncHeroAgentStatuses() {
  const meta = loadMeta();
  if (!meta?.cartridgeId) throw new Error("no cartridge");

  const snap = await call(`/cartridges/${meta.cartridgeId}`);
  if (!snap.ok) throw new Error(snap.data?.error || `GET cartridge HTTP ${snap.status}`);
  const heroes = (snap.data.cartridge ?? snap.data)?.cAavegotchis ?? [];

  /** @type {Map<string, { status: string, sessionId?: string, task?: string, model?: string }>} */
  const derived = new Map();
  for (const h of heroes) {
    derived.set(h.id, { status: "available" });
  }
  // Heroes with a running+alive session — these are "live", so role-idle does
  // not apply to them.
  const liveHeroes = new Set();

  const focusList = (() => {
    try {
      return JSON.parse(readFileSync(`${SESSIONS}/.focus-list.json`, "utf8"));
    } catch {
      return {};
    }
  })();

  const applySession = (hero, sessionId, status, model, host) => {
    if (!hero || !derived.has(hero)) return;
    if (status === "running") {
      const alive = host === "imac" ? true : pidAlive(field(`${SESSIONS}/${sessionId}`, "pid"));
      if (alive) liveHeroes.add(hero);
      const taskHint = (() => {
        try {
          return readFileSync(`${SESSIONS}/${sessionId}/prompt.txt`, "utf8").trim().slice(0, 200);
        } catch {
          return sessionId;
        }
      })();
      derived.set(hero, {
        status: alive ? (looksStandingTask(taskHint) ? "assigned" : "working") : "active",
        sessionId,
        task: (() => {
          try {
            return readFileSync(`${SESSIONS}/${sessionId}/prompt.txt`, "utf8").trim().slice(0, 200);
          } catch {
            return sessionId;
          }
        })(),
        model: model || undefined,
        host,
      });
    } else if (status === "done" || status === "failed") {
      // leave as available unless another running session owns the hero
      const cur = derived.get(hero);
      if (cur?.status === "working" || cur?.status === "active" || cur?.status === "assigned") return;
      let task = "";
      try {
        task = readFileSync(`${SESSIONS}/${sessionId}/prompt.txt`, "utf8").trim().slice(0, 200);
      } catch {}
      if (looksStandingTask(task)) {
        derived.set(hero, { status: "assigned", sessionId, task, host });
        return;
      }
      derived.set(hero, { status: "available" });
    }
  };

  if (existsSync(SESSIONS)) {
    for (const name of readdirSync(SESSIONS)) {
      if (!/^s\d/.test(name)) continue;
      const st = field(`${SESSIONS}/${name}`, "status");
      const hero = field(`${SESSIONS}/${name}`, "hero");
      const model = field(`${SESSIONS}/${name}`, "model");
      applySession(hero, name, st, model, "local");
    }
  }

  for (const e of focusList.entries || []) {
    if (e.kind === "session" && e.host === "imac" && e.hero) {
      applySession(e.hero, e.id, e.status, e.model, "imac");
    }
  }

  // Focused SUB with no running session → idle
  try {
    const focus = JSON.parse(readFileSync(FOCUS, "utf8"));
    if (focus.mode === "sub" && focus.heroId && derived.has(focus.heroId)) {
      const cur = derived.get(focus.heroId);
      if (cur.status === "available") {
        derived.set(focus.heroId, {
          status: "idle",
          sessionId: focus.sessionId || null,
          task: null,
          host: focus.host || "local",
        });
      }
    }
  } catch {}

  // Live OpenCode gotchi (MBP TUI and/or recent iMac API sessions) → orch working
  const orchId = orchestratorHeroId(heroes);
  if (orchId && derived.has(orchId)) {
    const cur = derived.get(orchId);
    const localLive = detectLiveGotchiOpenCode();
    const imacLive = localLive ? null : await detectImacGotchiOpenCode();
    const live = localLive || imacLive;
    if (live && cur.status !== "working") {
      derived.set(orchId, {
        status: "working",
        sessionId: live.sessionId || cur.sessionId || live.pid || null,
        task: live.task || cur.task,
        model: live.model || cur.model,
        host: live.host || cur.host,
      });
    }
  }


  // Keep standing assignments (cron / monitor) — do not drop to available/idle.
  try {
    const cache = JSON.parse(readFileSync(CACHE, "utf8"));
    for (const [heroId, row] of Object.entries(cache || {})) {
      if (!derived.has(heroId)) continue;
      const keep = row?.status === "assigned" || row?.status === "watching";
      if (!keep) continue;
      const cur = derived.get(heroId);
      if (cur.status === "available" || cur.status === "idle") {
        derived.set(heroId, {
          status: row.status,
          sessionId: row.sessionId || cur.sessionId,
          task: row.task || cur.task,
          model: row.model || cur.model,
          host: row.host || cur.host,
        });
      }
    }
  } catch {}

  // Respect persistent roles: a role-having agent that is NOT in a live session
  // shows `idle` (not `available`/`assigned`). "Live session" = a running+alive
  // session for that hero (tracked in liveHeroes) or the orchestrator's live TUI.
  try {
    const rolesPath = resolve(ROOT, "config", "agent-roles.json");
    if (existsSync(rolesPath)) {
      const roles = JSON.parse(readFileSync(rolesPath, "utf8"));
      for (const [heroId, role] of Object.entries(roles || {})) {
        if (!role) continue;
        if (!derived.has(heroId)) continue;
        if (liveHeroes.has(heroId)) continue; // live session → not idle
        const cur = derived.get(heroId);
        if (cur.status !== "available" && cur.status !== "assigned") continue;
        let task = role;
        try {
          const cache = JSON.parse(readFileSync(CACHE, "utf8"));
          if (cache?.[heroId]?.task) task = cache[heroId].task;
        } catch {}
        derived.set(heroId, {
          status: "idle",
          sessionId: null,
          task,
          model: cur.model,
          host: cur.host,
        });
      }
    }
  } catch {}

  const results = [];
  for (const [heroId, info] of derived) {
    try {
      await setHeroAgentStatus(heroId, info.status, {
        sessionId: info.sessionId,
        task: info.task,
        model: info.model,
        host: info.host,
      });
      results.push({ heroId, ...info, ok: true });
    } catch (e) {
      results.push({ heroId, ...info, ok: false, error: String(e.message || e) });
    }
  }
  return results;
}

async function cmdGet(heroId) {
  const meta = loadMeta();
  if (!meta?.cartridgeId) throw new Error("no cartridge");
  const snap = await call(`/cartridges/${meta.cartridgeId}`);
  if (!snap.ok) throw new Error(snap.data?.error || `HTTP ${snap.status}`);
  const heroes = (snap.data.cartridge ?? snap.data)?.cAavegotchis ?? [];
  const rows = heroes
    .filter((h) => !heroId || h.id === heroId)
    .map((h) => ({
      id: h.id,
      agentStatus: h.agentStatus || "available",
      agentSessionId: h.agentSessionId || null,
      agentTask: h.agentTask || null,
      agentUpdatedAt: h.agentUpdatedAt || null,
    }));
  console.log(JSON.stringify(rows, null, 2));
}

function usage() {
  console.error(`usage:
  hero-agent-state.mjs set <heroId> <${STATUSES.join("|")}> [--session id] [--task t] [--model m] [--host h]
  hero-agent-state.mjs sync
  hero-agent-state.mjs get [heroId]`);
  process.exit(2);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "set") {
    const heroId = rest[0];
    const status = rest[1];
    if (!heroId || !status) usage();
    const extra = {};
    for (let i = 2; i < rest.length; i++) {
      if (rest[i] === "--session" && rest[i + 1]) extra.sessionId = rest[++i];
      else if (rest[i] === "--task" && rest[i + 1]) extra.task = rest[++i];
      else if (rest[i] === "--model" && rest[i + 1]) extra.model = rest[++i];
      else if (rest[i] === "--host" && rest[i + 1]) extra.host = rest[++i];
    }
    const data = await setHeroAgentStatus(heroId, status, extra);
    const hero = (data.cartridge ?? data)?.cAavegotchis?.find((h) => h.id === heroId);
    console.log(
      JSON.stringify(
        {
          ok: true,
          heroId,
          agentStatus: hero?.agentStatus || status,
          agentSessionId: hero?.agentSessionId || null,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (cmd === "sync") {
    const results = await syncHeroAgentStatuses();
    console.log(JSON.stringify({ ok: true, results }, null, 2));
    return;
  }
  if (cmd === "get") {
    await cmdGet(rest[0] || null);
    return;
  }
  usage();
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
