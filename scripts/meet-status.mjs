#!/usr/bin/env node
/**
 * Per-participant meet status for the Zoom gallery.
 *
 * Statuses: idle | thinking | responding
 * Written by gotchi-meet / colabo; read by meet-room.mjs cell labels.
 *
 *   node scripts/meet-status.mjs get [--json]
 *   node scripts/meet-status.mjs set <id> <idle|thinking|responding>
 *   node scripts/meet-status.mjs clear
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATUS_FILE = `${ROOT}/sessions/.meet-status.json`;
const STATUSES = new Set(["idle", "thinking", "responding"]);

export function loadMeetStatus() {
  try {
    if (!existsSync(STATUS_FILE)) return { meetingId: null, byId: {}, updatedAt: null };
    const j = JSON.parse(readFileSync(STATUS_FILE, "utf8"));
    return {
      meetingId: j.meetingId || null,
      byId: j.byId && typeof j.byId === "object" ? j.byId : {},
      updatedAt: j.updatedAt || null,
    };
  } catch {
    return { meetingId: null, byId: {}, updatedAt: null };
  }
}

function pokeRoom() {
  spawnSync("bash", [`${ROOT}/scripts/poke-meet-room.sh`], { stdio: "ignore" });
}

export function saveMeetStatus(state, { poke = true } = {}) {
  mkdirSync(`${ROOT}/sessions`, { recursive: true });
  const out = {
    meetingId: state.meetingId || null,
    updatedAt: new Date().toISOString(),
    byId: state.byId || {},
  };
  writeFileSync(STATUS_FILE, `${JSON.stringify(out, null, 2)}\n`);
  if (poke) pokeRoom();
  return out;
}

export function statusFor(id, state = loadMeetStatus()) {
  const row = state.byId?.[id];
  const s = row?.status;
  if (STATUSES.has(s) && s !== "idle") {
    return { status: s, since: row.since || state.updatedAt };
  }
  return { status: "idle", since: null };
}

export function setMeetStatus(id, status, { meetingId = null, poke = true } = {}) {
  const s = String(status || "idle").toLowerCase();
  if (!STATUSES.has(s)) throw new Error(`status must be idle|thinking|responding (got ${status})`);
  const cur = loadMeetStatus();
  if (meetingId) cur.meetingId = meetingId;
  if (s === "idle") {
    delete cur.byId[id];
  } else {
    cur.byId[id] = { status: s, since: new Date().toISOString() };
  }
  return saveMeetStatus(cur, { poke });
}

/** Set many ids; others not listed stay as-is unless resetOthers. */
export function setMeetStatuses(map, { meetingId = null, resetOthers = false, poke = true } = {}) {
  const cur = loadMeetStatus();
  if (meetingId) cur.meetingId = meetingId;
  if (resetOthers) cur.byId = {};
  const now = new Date().toISOString();
  for (const [id, status] of Object.entries(map || {})) {
    const s = String(status || "idle").toLowerCase();
    if (!STATUSES.has(s) || s === "idle") delete cur.byId[id];
    else cur.byId[id] = { status: s, since: now };
  }
  return saveMeetStatus(cur, { poke });
}

export function clearMeetStatus({ poke = true } = {}) {
  try {
    unlinkSync(STATUS_FILE);
  } catch {
    /* ok */
  }
  if (poke) pokeRoom();
}

/** Animate dots for thinking/responding labels. */
export function statusLabel(status, since) {
  const s = status || "idle";
  if (s === "idle") return "idle";
  const t = Date.parse(since || "") || Date.now();
  const n = (Math.floor((Date.now() - t) / 500) % 3) + 1;
  const dots = ".".repeat(n);
  if (s === "thinking") return `thinking${dots}`;
  if (s === "responding") return `responding${dots}`;
  return s;
}

const isCli = process.argv[1]?.endsWith("meet-status.mjs");
if (isCli) {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const args = argv.filter((a) => a !== "--json");
  const cmd = args[0] || "get";
  if (cmd === "get") {
    const s = loadMeetStatus();
    if (json) console.log(JSON.stringify(s, null, 2));
    else {
      const ids = Object.keys(s.byId || {});
      if (!ids.length) console.log("(all idle)");
      else for (const id of ids) console.log(`${id}\t${s.byId[id].status}`);
    }
  } else if (cmd === "set") {
    setMeetStatus(args[1], args[2], { poke: true });
    console.log(`ok ${args[1]} → ${args[2]}`);
  } else if (cmd === "clear") {
    clearMeetStatus();
    console.log("cleared");
  } else {
    console.error("usage: meet-status.mjs get|set <id> <status>|clear [--json]");
    process.exit(2);
  }
}
