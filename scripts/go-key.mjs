#!/usr/bin/env node
/**
 * Is an OpenCode Go key available to this install?
 *
 * The key lives in abra (project "gotchibot"), and sub-agent runners inject it
 * with `abra run gotchibot -- opencode …`. Model selection, however, runs in the
 * parent shell BEFORE that injection, so checking `process.env` alone reports
 * "no key" even when the vault has one — and every sub-agent silently falls
 * back to free Zen models. This module answers the question the way the
 * runner will experience it: env first, then the vault's key *names*.
 *
 * Values are never read here. `abra ls` prints masked names only.
 *
 *   node scripts/go-key.mjs status      # JSON: { env, vault, source }
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = `${ROOT}/sessions/.go-key.json`;
const CACHE_TTL_MS = 10 * 60 * 1000;
export const ABRA_PROJECT = "gotchibot";
export const GO_KEY_NAME = "OPENCODE_API_KEY";

export function hasGoKeyInEnv(env = process.env) {
  return Boolean(env[GO_KEY_NAME]?.trim());
}

function readCache() {
  try {
    const c = JSON.parse(readFileSync(CACHE, "utf8"));
    if (Date.now() - Number(c.at || 0) < CACHE_TTL_MS) return c;
  } catch {}
  return null;
}

function writeCache(vault) {
  try {
    mkdirSync(dirname(CACHE), { recursive: true });
    writeFileSync(CACHE, `${JSON.stringify({ vault, at: Date.now() }, null, 2)}\n`);
  } catch {}
}

/** Names listed in the abra project (never values). Empty when abra is unavailable. */
export function abraKeyNames(project = ABRA_PROJECT) {
  if (process.env.GOTCHIBOT_SKIP_ABRA === "1") return [];
  const r = spawnSync("abra", ["ls", project], { encoding: "utf8", timeout: 8000 });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout
    .split("\n")
    .map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trim().split(/\s+/)[0])
    .filter((name) => /^[A-Z][A-Z0-9_]*$/.test(name));
}

/** True when the vault holds OPENCODE_API_KEY. Cached briefly — `abra ls` takes ~3s. */
export function goKeyInVault({ fresh = false } = {}) {
  if (!fresh) {
    const c = readCache();
    if (c) return Boolean(c.vault);
  }
  const vault = abraKeyNames().includes(GO_KEY_NAME);
  writeCache(vault);
  return vault;
}

export function goKeySource(opts = {}) {
  if (hasGoKeyInEnv()) return "env";
  if (goKeyInVault(opts)) return "abra";
  return null;
}

/** The check every model picker should use. */
export function hasGoKey(opts = {}) {
  return goKeySource(opts) !== null;
}

/** Drop the cache — call after `abra set gotchibot OPENCODE_API_KEY`. */
export function forgetGoKeyCache() {
  try {
    if (existsSync(CACHE)) writeFileSync(CACHE, "{}\n");
  } catch {}
}

if (process.argv[1]?.endsWith("go-key.mjs")) {
  const cmd = process.argv[2] || "status";
  if (cmd === "status") {
    const env = hasGoKeyInEnv();
    const vault = goKeyInVault({ fresh: process.argv.includes("--fresh") });
    console.log(JSON.stringify({ env, vault, source: env ? "env" : vault ? "abra" : null }, null, 2));
  } else if (cmd === "forget") {
    forgetGoKeyCache();
    console.log("go-key cache cleared");
  } else {
    console.error("usage: go-key.mjs status [--fresh] | forget");
    process.exit(2);
  }
}
