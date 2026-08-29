#!/usr/bin/env node
/**
 * Pick where/which cAavegotchi should take the next job.
 *
 *   abra run gotchibot -- node scripts/delegate-pick.mjs [--json] ["hint"]
 *
 * Prefers: SUB focus → idle cartridge hero → spawn on iMac if SSH up, else local.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FOCUS = `${ROOT}/sessions/.focus.json`;
const LIST_CACHE = `${ROOT}/sessions/.focus-list.json`;

function loadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function refreshList() {
  const r = spawnSync(process.execPath, [`${ROOT}/scripts/agent-focus.mjs`, "list", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
  });
  // list --json → { numbered, remote, … }; cache file → { entries, remote, … }
  if (r.status === 0 && r.stdout?.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(r.stdout);
      const entries = parsed.entries || parsed.numbered || [];
      return { ...parsed, entries, remote: parsed.remote };
    } catch {}
  }
  const cache = loadJson(LIST_CACHE);
  if (cache) {
    return { ...cache, entries: cache.entries || cache.numbered || [] };
  }
  return null;
}

function busyHeroes(entries) {
  const busy = new Set();
  for (const e of entries || []) {
    if (e.kind === "session" && e.status === "running" && e.hero) busy.add(e.hero);
  }
  return busy;
}

function main() {
  const json = process.argv.includes("--json");
  const hint = process.argv
    .slice(2)
    .filter((a) => a !== "--json")
    .join(" ")
    .trim();

  const focus = loadJson(FOCUS) || { mode: "orch" };
  const roster = refreshList() || loadJson(LIST_CACHE) || { entries: [], remote: { ok: false } };
  const entries = roster.entries || [];
  const busy = busyHeroes(entries);
  const heroes = entries.filter((e) => e.kind === "hero");
  const idleHero =
    heroes.find((h) => !busy.has(h.id) && (h.status === "available" || !h.status || h.status === "idle")) ||
    heroes.find((h) => !busy.has(h.id)) ||
    heroes[0] ||
    null;

  const remoteOk = Boolean(roster.remote?.ok);
  // Prefer iMac when reachable (always-on host); else local MBP.
  let host = remoteOk ? "imac" : "local";
  if (/\b(local|mbp|laptop)\b/i.test(hint)) host = "local";
  if (/\b(imac|remote|home)\b/i.test(hint)) host = remoteOk ? "imac" : "local";

  let decision;
  if (focus.mode === "sub" && focus.heroId) {
    decision = {
      action: "chat",
      reason: "SUB focus already set — route prompt to focused gotchi",
      host: focus.host === "imac" && remoteOk ? "imac" : "local",
      heroId: focus.heroId,
      sessionId: focus.sessionId || null,
      command: `./scripts/agent-focus.mjs chat ${JSON.stringify(hint || "<user prompt>")}`,
    };
  } else if (!idleHero) {
    decision = {
      action: "blocked",
      reason: "no cAavegotchi available — run wallet-gate / identity bind",
      host: null,
      heroId: null,
      command: "./scripts/wallet-gate.mjs",
    };
  } else {
    const spawnCmd =
      host === "imac"
        ? `GOTCHIBOT_HERO_ID=${idleHero.id} abra run gotchibot -- ./scripts/gotchi-orchestrate.mjs spawn --host imac --model auto "<self-contained prompt>"`
        : `GOTCHIBOT_HERO_ID=${idleHero.id} ./scripts/gotchi-orchestrate.mjs spawn --host local --model auto "<self-contained prompt>"`;
    decision = {
      action: "spawn",
      reason: remoteOk && host === "imac"
        ? "delegate to idle cAavegotchi on iMac via Tailscale SSH (preferred always-on host)"
        : "delegate to idle cAavegotchi on local MBP",
      host,
      heroId: idleHero.id,
      sessionId: null,
      remoteOk,
      command: spawnCmd,
      focusFirst: `./scripts/agent-focus.mjs select ${idleHero.id}`,
      wait: host === "imac"
        ? `abra run gotchibot -- ./scripts/gotchi-orchestrate.mjs wait --host imac <id>`
        : `./scripts/gotchi-orchestrate.mjs wait <id>`,
      output: host === "imac"
        ? `abra run gotchibot -- ./scripts/gotchi-orchestrate.mjs output --host imac <id>`
        : `./scripts/gotchi-orchestrate.mjs output <id>`,
    };
  }

  if (json) {
    console.log(JSON.stringify({ decision, focus, heroes: heroes.map((h) => h.id), busy: [...busy] }, null, 2));
  } else {
    console.log(`action:  ${decision.action}`);
    console.log(`host:    ${decision.host || "—"}`);
    console.log(`hero:    ${decision.heroId || "—"}`);
    console.log(`reason:  ${decision.reason}`);
    console.log(`command: ${decision.command}`);
    if (decision.focusFirst) console.log(`focus:   ${decision.focusFirst}`);
    if (decision.wait) console.log(`wait:    ${decision.wait}`);
    if (decision.output) console.log(`output:  ${decision.output}`);
  }
}

main();
