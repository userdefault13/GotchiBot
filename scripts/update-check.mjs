#!/usr/bin/env node
/**
 * Launch-time update check for GotchiBot.
 *
 * Compares config/version.json to CDN latest.json (or git origin when no CDN).
 * Prompts on tmux / attach / onboard before loading the cockpit.
 *
 *   node scripts/update-check.mjs              # prompt if update available
 *   node scripts/update-check.mjs --check      # print versions only
 *   node scripts/update-check.mjs --apply      # install without prompt
 *   node scripts/update-check.mjs --force      # bypass 24h cache
 */
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION_FILE = join(ROOT, "config", "version.json");
const CACHE_FILE = join(ROOT, "sessions", ".update-cache.json");
const DEFAULT_CDN =
  process.env.GOTCHIBOT_CDN_LATEST ?? "https://cdn.aarcadeghst.com/releases/gotchibot/latest.json";
const DEFAULT_GITHUB =
  process.env.GOTCHIBOT_GITHUB_LATEST ??
  "https://raw.githubusercontent.com/userdefault13/GotchiBot/main/config/latest.json";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  return {
    check: argv.includes("--check"),
    apply: argv.includes("--apply"),
    force: argv.includes("--force") || process.env.GOTCHIBOT_UPDATE_CHECK === "always",
    quiet: argv.includes("--quiet"),
    launch: argv.includes("--launch"),
  };
}

function readLocalVersion() {
  try {
    const data = JSON.parse(readFileSync(VERSION_FILE, "utf8"));
    return typeof data.version === "string" ? data.version.trim() : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function writeLocalVersion(version) {
  writeFileSync(VERSION_FILE, `${JSON.stringify({ version }, null, 2)}\n`);
}

function parseSemver(v) {
  const m = String(v).trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function isNewer(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return true;
    if (pa[i] < pb[i]) return false;
  }
  return false;
}

function readCache() {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeCache(data) {
  writeFileSync(CACHE_FILE, `${JSON.stringify(data, null, 2)}\n`);
}

async function fetchJson(url, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseManifest(raw) {
  if (!raw || typeof raw !== "object") return null;
  const version = typeof raw.version === "string" ? raw.version.trim() : "";
  if (!version) return null;
  return {
    version,
    url: typeof raw.url === "string" ? raw.url : undefined,
    notes: typeof raw.notes === "string" ? raw.notes : undefined,
    publishedAt: typeof raw.publishedAt === "string" ? raw.publishedAt : undefined,
  };
}

async function fetchCdnLatest() {
  for (const url of [DEFAULT_CDN, DEFAULT_GITHUB]) {
    const raw = await fetchJson(url);
    const m = parseManifest(raw);
    if (m) return { manifest: m, source: url.includes("github") ? "github" : "cdn" };
  }
  return null;
}

function gitDir() {
  return existsSync(join(ROOT, ".git")) ? ROOT : null;
}

function gitRemoteBranch() {
  const branch =
    spawnSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout?.trim() ||
    "main";
  const upstream = spawnSync("git", ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (upstream.status === 0 && upstream.stdout?.trim()) {
    return upstream.stdout.trim();
  }
  return `origin/${branch}`;
}

function gitFetchQuiet() {
  return spawnSync("git", ["fetch", "--quiet", "origin"], { cwd: ROOT, encoding: "utf8", stdio: "pipe" }).status === 0;
}

function gitBehindCount() {
  if (!gitDir()) return null;
  gitFetchQuiet();
  const upstream = gitRemoteBranch();
  const out = spawnSync("git", ["rev-list", "--count", `HEAD..${upstream}`], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (out.status !== 0) return null;
  const n = Number(out.stdout?.trim() || "0");
  return Number.isFinite(n) ? n : null;
}

function gitShortSha() {
  const out = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8", stdio: "pipe" });
  return out.status === 0 ? out.stdout?.trim() : null;
}

async function resolveLatest(force) {
  const cache = readCache();
  if (!force && cache?.latestVersion && Date.now() - cache.checkedAt < CHECK_INTERVAL_MS) {
    return {
      manifest: { version: cache.latestVersion, notes: cache.notes },
      source: cache.source ?? "cdn",
      gitBehind: cache.gitBehind ?? null,
    };
  }

  const cdn = await fetchCdnLatest();
  const gitBehind = gitBehindCount();
  const latest = cdn ?? (gitBehind && gitBehind > 0 ? { manifest: { version: "git" }, source: "git" } : null);

  if (latest) {
    writeCache({
      checkedAt: Date.now(),
      latestVersion: latest.manifest.version,
      source: latest.source,
      notes: latest.manifest.notes,
      gitBehind,
    });
  }

  return latest ? { ...latest, gitBehind } : { manifest: null, source: null, gitBehind };
}

function updateAvailable(localVersion, latest, gitBehind) {
  if (latest?.manifest?.version && latest.manifest.version !== "git") {
    if (isNewer(latest.manifest.version, localVersion)) return true;
  }
  return typeof gitBehind === "number" && gitBehind > 0;
}

function prompt(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve("");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function applyGitPull() {
  const upstream = gitRemoteBranch();
  console.log(`→ git pull --ff-only (${upstream})`);
  const r = spawnSync("git", ["pull", "--ff-only"], { cwd: ROOT, stdio: "inherit", encoding: "utf8" });
  if (r.status !== 0) {
    console.error("✗ git pull failed — resolve locally, then retry");
    return false;
  }
  return true;
}

async function applyUpdate(latest, gitBehind) {
  if (gitDir() && (gitBehind ?? 0) > 0) {
    const ok = applyGitPull();
    if (ok && latest?.manifest?.version && latest.manifest.version !== "git") {
      writeLocalVersion(latest.manifest.version);
    }
    return ok;
  }

  if (latest?.manifest?.url) {
    console.log(`download: ${latest.manifest.url}`);
    console.log("  (non-git install — re-clone or rsync from your maintainer)");
    return false;
  }

  console.error("✗ no git repo and no CDN url — cannot auto-update");
  return false;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (process.env.GOTCHIBOT_SKIP_UPDATE_CHECK === "1") {
    if (opts.check) console.log("update check skipped (GOTCHIBOT_SKIP_UPDATE_CHECK=1)");
    return;
  }

  const localVersion = readLocalVersion();
  const resolved = await resolveLatest(opts.force);
  const latest = resolved.manifest ? { manifest: resolved.manifest, source: resolved.source } : null;
  const gitBehind = resolved.gitBehind ?? gitBehindCount();
  const available = updateAvailable(localVersion, latest, gitBehind);

  if (opts.check) {
    console.log(`current: ${localVersion}${gitShortSha() ? ` (${gitShortSha()})` : ""}`);
    if (latest?.manifest?.version && latest.manifest.version !== "git") {
      console.log(`latest:  ${latest.manifest.version} (${latest.source})`);
    } else if (gitBehind) {
      console.log(`git:     ${gitBehind} commit(s) behind ${gitRemoteBranch()}`);
    } else {
      console.log("latest:  (could not reach CDN; git up to date)");
    }
    return;
  }

  if (!available) return;

  const latestLabel =
    latest?.manifest?.version && latest.manifest.version !== "git"
      ? latest.manifest.version
      : `${gitBehind} commit(s) on ${gitRemoteBranch()}`;

  if (opts.apply) {
    if (!opts.quiet) console.log(`\nGotchiBot update: ${localVersion} → ${latestLabel}`);
    const ok = await applyUpdate(latest, gitBehind);
    process.exit(ok ? 0 : 1);
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) return;

  console.log(`\nGotchiBot update available: ${localVersion} → ${latestLabel}`);
  if (latest?.manifest?.notes) console.log(`  ${latest.manifest.notes}`);
  const answer = (await prompt("Install update before continuing? [y/N]: ")).trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") {
    console.log("  continuing with current version\n");
    return;
  }

  const ok = await applyUpdate(latest, gitBehind);
  if (!ok && opts.launch) {
    const cont = (await prompt("Continue anyway? [y/N]: ")).trim().toLowerCase();
    if (cont !== "y" && cont !== "yes") process.exit(1);
  } else if (!ok) {
    process.exit(1);
  }
  console.log("");
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
