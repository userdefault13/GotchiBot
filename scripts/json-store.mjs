/**
 * Small shared-JSON helpers for the session caches several processes touch at
 * once (the avatar pane, the roster scan, meet, a spawn gate).
 *
 * Two failure modes have already bitten `sessions/.hero-agent-state.json`:
 *
 *   1. A plain writeFileSync is not atomic. A reader that catches the file
 *      mid-write parses nothing, falls back to `{}`, and writes that back —
 *      every other hero's entry is gone, and the next few writers repopulate
 *      collateral-only rows. That is how seven heroes lost their agentStatus
 *      inside one second, which in turn makes the sandbox availability gate
 *      refuse a hero that is genuinely available.
 *   2. `readJson(path, {})` cannot tell "no file yet" from "unreadable right
 *      now", so a transient error looks like an empty map.
 *
 * `readJsonMap` distinguishes the two, and `writeJsonAtomic` publishes through
 * a temp file + rename so a reader sees either the old map or the new one.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from "node:fs";

/**
 * @returns {{ data: object, ok: boolean, missing: boolean }}
 *   ok=false means the file exists but could not be parsed — the caller must
 *   NOT treat that as an empty map and write over it.
 */
export function readJsonMap(path) {
  if (!existsSync(path)) return { data: {}, ok: true, missing: true };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { data: {}, ok: false, missing: false };
    }
    return { data: parsed, ok: true, missing: false };
  } catch {
    return { data: {}, ok: false, missing: false };
  }
}

/** Write via temp + rename so concurrent readers never see a partial file. */
export function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(tmp, path);
    return true;
  } catch {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* nothing else to do */
    }
    return false;
  }
}

/**
 * Merge one entry into a shared map on disk. Skips the write when the file is
 * present but unreadable, so a transient read failure can never truncate the
 * map for every other key.
 *
 * @returns {{ ok: boolean, skipped?: string, value?: object }}
 */
export function mergeJsonEntry(path, key, entry) {
  const { data, ok } = readJsonMap(path);
  if (!ok) return { ok: false, skipped: "unreadable-map" };
  data[key] = entry;
  return writeJsonAtomic(path, data) ? { ok: true, value: entry } : { ok: false, skipped: "write-failed" };
}
