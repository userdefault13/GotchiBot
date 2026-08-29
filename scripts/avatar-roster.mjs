#!/usr/bin/env node
/**
 * Snapshot for avatar pane: role label + other cartridge cAavegotchis.
 *
 *   node scripts/avatar-roster.mjs [--json] [--refresh]
 */
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMeta } from "./identity.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = `${ROOT}/sessions`;
const FOCUS = `${SESSIONS}/.focus.json`;
const PIN = `${SESSIONS}/.pin`;
const LIST_CACHE = `${SESSIONS}/.focus-list.json`;
const ROSTER_CACHE = `${SESSIONS}/.avatar-roster.json`;
const AVATARS = `${SESSIONS}/.avatars`;

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
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

function heroStateCache() {
  return readJson(`${SESSIONS}/.hero-agent-state.json`, {}) || {};
}

function resolveStatus(h, busy) {
  const cached = heroStateCache()[h.id]?.status || null;
  const fromCache = cached && cached !== "available" ? cached : null;
  const fromSim = h.agentStatus && h.agentStatus !== "available" ? h.agentStatus : null;
  if (busy.has(h.id)) {
    if (fromCache === "assigned" || fromCache === "watching" || fromCache === "active") return fromCache;
    return "working";
  }
  return fromSim || fromCache || "available";
}

function busyHeroIds() {
  const busy = new Set();
  if (!existsSync(SESSIONS)) return busy;
  for (const name of readdirSync(SESSIONS)) {
    if (!/^s\d/.test(name)) continue;
    const st = `${SESSIONS}/${name}/state.env`;
    if (!existsSync(st)) continue;
    if ((field(st, "status") || "") !== "running") continue;
    const hero = field(st, "hero");
    if (hero) busy.add(hero);
  }
  // Remote running from last focus-list cache
  const cache = readJson(LIST_CACHE, {});
  for (const e of cache.entries || []) {
    if (e.kind === "session" && e.host === "imac" && e.status === "running" && e.hero) {
      busy.add(e.hero);
    }
  }
  return busy;
}

function heroesFromCache() {
  const cache = readJson(LIST_CACHE, {});
  return (cache.entries || [])
    .filter((e) => e.kind === "hero")
    .map((e) => ({
      id: e.id,
      collateral: e.collateral || null,
      bindType: e.bindType || null,
      name: e.name || null,
      agentStatus: e.status || e.agentStatus || "available",
    }));
}

async function heroesFresh() {
  try {
    const { fetchCartridgeHeroes } = await import("./onboarding-lib.mjs");
    const meta = loadMeta();
    if (!meta?.cartridgeId) return heroesFromCache();
    const heroes = await fetchCartridgeHeroes(meta.cartridgeId);
    return heroes.map((h) => ({
      id: h.id,
      collateral: h.collateral || h.collateralAddress || null,
      bindType: h.bindType || null,
      name: h.name || null,
      agentStatus: h.agentStatus || "available",
    }));
  } catch {
    return heroesFromCache();
  }
}

function pinId() {
  try {
    return readFileSync(PIN, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function roleFromFocus() {
  const focus = readJson(FOCUS, { mode: "orch" });
  if (focus.mode === "sub") return "sub-agent";
  return "orchestrator";
}

async function build() {
  const refresh = process.argv.includes("--refresh");
  const pinned = pinId() || loadMeta()?.activeHeroId || null;
  const role = roleFromFocus();
  const heroes = refresh ? await heroesFresh() : heroesFromCache();
  const list = heroes.length ? heroes : heroesFromCache();
  const busy = busyHeroIds();

  const others = list
    .filter((h) => h.id && h.id !== pinned)
    .map((h) => {
      const status = resolveStatus(h, busy);
      return {
        id: h.id,
        name: h.name || null,
        collateral: h.collateral || null,
        bindType: h.bindType || null,
        status,
        svg: existsSync(`${AVATARS}/${h.id}.svg`) ? `${AVATARS}/${h.id}.svg` : null,
      };
    });

  const pinnedHero = list.find((h) => h.id === pinned);
  const pinnedStatus = pinned
    ? resolveStatus(pinnedHero || { id: pinned, agentStatus: null }, busy)
    : null;

  const payload = {
    role,
    pinned,
    pinnedStatus,
    pinnedSvg: pinned && existsSync(`${AVATARS}/${pinned}.svg`) ? `${AVATARS}/${pinned}.svg` : null,
    others,
    at: new Date().toISOString(),
  };

  mkdirSync(SESSIONS, { recursive: true });
  writeFileSync(ROSTER_CACHE, `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

const json = process.argv.includes("--json");
const payload = await build();
if (json) {
  console.log(JSON.stringify(payload));
} else {
  console.log(`role:   ${payload.role}`);
  console.log(`pinned: ${payload.pinned || "—"}`);
  for (const o of payload.others) {
    console.log(`  ${o.id}  ${o.status}`);
  }
}
