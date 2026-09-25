#!/usr/bin/env node
/**
 * Auto-pick a free, currently listed model.
 *   node scripts/model-auto.mjs pin [--probe] [--json]
 *   node scripts/model-auto.mjs list [--json]
 *   node scripts/model-auto.mjs resolve <alias>
 *
 * Never prints API keys. Hosted providers only (OpenCode Zen / Go); no network
 * calls on the pick path. --probe is accepted for compatibility (no-op).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CFG_PATH = `${ROOT}/config/models.auto.json`;
const CACHE_PATH = `${ROOT}/sessions/.model-auto.json`;
const PIN_PATH = `${ROOT}/sessions/.gotchi-model.env`;

const DEFAULT_CFG = {
  goPrefer: [
    "opencode-go/kimi-k3",
    "opencode-go/glm-5.3-flash",
    "opencode-go/glm-5.3",
    "opencode-go/glm-5.2",
    "opencode-go/gpt-5.6-luna",
    "opencode-go/grok-4.6",
  ],
  prefer: [
    "opencode/big-pickle",
    "opencode/mimo-v2.5-free",
    "opencode/nemotron-3.5-lightning-free",
    "opencode/nemotron-3-ultra-free",
  ],
  skip: ["opencode/hy3-free"],
  lastResort: "opencode/big-pickle",
  ttlOkSec: 0,
  ttlFailSec: 1800,
};

function loadCfg() {
  try {
    return { ...DEFAULT_CFG, ...JSON.parse(readFileSync(CFG_PATH, "utf8")) };
  } catch {
    return DEFAULT_CFG;
  }
}

function loadCache() {
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveCache(data) {
  mkdirSync(`${ROOT}/sessions`, { recursive: true });
  writeFileSync(CACHE_PATH, `${JSON.stringify({ ...data, updatedAt: new Date().toISOString() }, null, 2)}\n`);
}

function oc(id) {
  return String(id || "").trim();
}

function hasOpencodeKey() {
  return !!(process.env.OPENCODE_API_KEY || process.env.OPENCODE_ZEN_API_KEY);
}

function hasOpencodeGoKey() {
  return !!process.env.OPENCODE_API_KEY;
}

function buildPrefer(cfg) {
  const skip = new Set((cfg.skip || []).map(oc));
  const base = (cfg.prefer || []).map(oc).filter((id) => !skip.has(id));
  if (!hasOpencodeGoKey()) return base;
  const go = (cfg.goPrefer || []).map(oc).filter((id) => !skip.has(id));
  const seen = new Set(go);
  return [...go, ...base.filter((id) => !seen.has(id))];
}
function aliases() {
  return {
    auto: "AUTO",
    free: "AUTO",
    go: hasOpencodeGoKey() ? "opencode-go/kimi-k3" : "AUTO",
    hy3: "opencode/big-pickle",
    nim: "opencode/big-pickle",
    fast: "opencode/big-pickle",
    heavy: "opencode/nemotron-3-ultra-free",
    ultra: "opencode/nemotron-3-ultra-free",
    lightning: "opencode/nemotron-3.5-lightning-free",
    pickle: "opencode/big-pickle",
    flash: hasOpencodeGoKey() ? "opencode-go/glm-5.3-flash" : "opencode/big-pickle",
    pro: hasOpencodeGoKey() ? "opencode-go/kimi-k3" : "opencode/nemotron-3-ultra-free",
    claudemode: "claudemode/@claudemode",
    "@claudemode": "claudemode/@claudemode",
    "claude-mode": "claudemode/@claudemode",
  };
}
function pinModel(model) {
  mkdirSync(`${ROOT}/sessions`, { recursive: true });
  writeFileSync(PIN_PATH, `export GOTCHIBOT_OPENCODE_MODEL=${model}\n`);
}

export function markModelCooldown(model, { reason = "failed", ttlSec } = {}) {
  const cfg = loadCfg();
  const cache = loadCache();
  const now = Date.now();
  const ttl = (ttlSec ?? cfg.ttlFailSec ?? 1800) * 1000;
  const id = oc(model);
  if (!id) return cache;
  cache.cooldown = cache.cooldown || {};
  cache.cooldown[id] = now + ttl;
  cache.lastFail = { model: id, reason, at: now };
  saveCache(cache);
  return cache;
}

/** Prefer list for “working models only” walkers (meet, spawn). Skips cooldown + skip list. */
export function workingModelCandidates({ includeGo = true } = {}) {
  const cfg = loadCfg();
  const cache = loadCache();
  const now = Date.now();
  const skip = new Set((cfg.skip || []).map(oc));
  const out = [];
  const push = (id) => {
    const m = oc(id);
    if (!m || skip.has(m) || out.includes(m)) return;
    if (m.startsWith("opencode-go/") && !includeGo && !hasOpencodeGoKey()) return;
    if (cache.cooldown?.[m] && now < cache.cooldown[m]) return;
    out.push(m);
  };
  for (const id of cfg.subagentPrefer || []) push(id);
  for (const id of buildPrefer(cfg)) push(id);
  push(cfg.subagentFallback || cfg.lastResort || "opencode/big-pickle");
  push(cfg.lastResort || "opencode/big-pickle");
  return out;
}

export async function pickSubagentModel({ json = false } = {}) {
  const cfg = loadCfg();
  const cache = loadCache();
  const now = Date.now();
  const goKeyPresent = hasOpencodeGoKey();
  const fallback = cfg.subagentFallback || "opencode/big-pickle";

  // Free Zen first (no Go key required). Skip opencode-go/* unless Go key is present.
  const prefer = (cfg.subagentPrefer || []).map(oc);
  for (const model of prefer) {
    if (model.startsWith("opencode-go/") && !goKeyPresent) continue;
    if (cache.cooldown?.[model] && now < cache.cooldown[model]) continue;
    const result = {
      route: "spawn",
      model,
      reason: model.startsWith("opencode-go/") ? "subagent-prefer-go" : "subagent-prefer-zen-free",
      cached: false,
    };
    if (json) return result;
    process.stdout.write(model);
    return;
  }

  // Optional: cursor-agent when no free/Go model picked
  try {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync("command", ["-v", "cursor-agent"], {
      encoding: "utf8",
      shell: true,
    });
    const found = (r.stdout || "").trim().split("\n")[0];
    if (found && require("node:fs").existsSync(found)) {
      const result = {
        route: "cursor-cli",
        reason: "cursor-available",
        cached: false,
      };
      if (json) return result;
      process.stdout.write("cursor-cli");
      return;
    }
  } catch {}

  const result3 = {
    route: "spawn",
    model: fallback,
    reason: "subagent-fallback",
    cached: false,
  };
  if (json) return result3;
  process.stdout.write(fallback);
}

export async function pickModel({ probe = false, json = false } = {}) {
  const cfg = loadCfg();
  const cache = loadCache();
  const now = Date.now();
  const ttlOk = Number(cfg.ttlOkSec ?? 0) * 1000;

  if (cache.pick && cache.at && now - cache.at < ttlOk) {
    const out = { model: cache.pick, reason: cache.reason || "cache", cached: true };
    if (json) return out;
    return out.model;
  }

  const skip = new Set((cfg.skip || []).map(oc));
  const report = [];
  for (const model of buildPrefer(cfg)) {
    if (skip.has(model)) continue;
    if (cache.cooldown?.[model] && now < cache.cooldown[model]) {
      report.push({ model, skip: "cooldown" });
      continue;
    }
    saveCache({ pick: model, at: now, reason: "prefer", cooldown: cache.cooldown || {} });
    const out = { model, reason: "prefer", report };
    if (json) return out;
    return out.model;
  }

  saveCache({ pick: cfg.lastResort, at: now, reason: "last-resort", cooldown: cache.cooldown || {} });
  const out = { model: cfg.lastResort, reason: "last-resort", report };
  if (json) return out;
  return out.model;
}

export async function resolveAlias(name, opts = {}) {
  const a = aliases();
  const key = String(name || "auto").trim();
  if (!key || key === "auto" || key === "free") return pickModel(opts);
  if (a[key] && a[key] !== "AUTO") return opts.json ? { model: a[key], reason: "alias" } : a[key];
  if (key === "sub") {
    const picked = pickSubagentModel({ json: opts.json });
    if (opts.json) return picked;
    return picked.model;
  }
  return opts.json ? { model: key, reason: "passthrough" } : key;
}

const isCli = process.argv[1]?.endsWith("model-auto.mjs");
if (isCli) {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const probe = argv.includes("--probe");
  const cmd = argv.find((a) => !a.startsWith("--")) || "pick";
  const rest = argv.filter((a) => !a.startsWith("--") && a !== cmd);
  const out = async () => {
    if (cmd === "pick") return pickModel({ probe, json });
    if (cmd === "pin") {
      const r = await pickModel({ probe, json: true });
      pinModel(r.model);
      return { ...r, pinned: PIN_PATH };
    }
    if (cmd === "list") {
      const cfg = loadCfg();
      return {
        goPrefer: cfg.goPrefer,
        prefer: cfg.prefer,
        effectivePrefer: buildPrefer(cfg),
        opencodeKey: hasOpencodeKey(),
        lastResort: cfg.lastResort,
        cache: loadCache(),
      };
    }
    if (cmd === "resolve") return resolveAlias(rest[0] || "auto", { probe, json: true });
if (cmd === "subagent") {
  const r = await pickSubagentModel({ json: argv.includes("--json") });
  if (argv.includes("--json")) {
    return r;
  } else {
    // pickSubagentModel already wrote the model to stdout in non-json mode.
    return r?.model ?? "";
  }
}
    throw new Error("usage: model-auto.mjs pick|pin|list|resolve [alias] [--json] [--probe]");
  };
  out()
    .then((r) => {
      if (json || typeof r !== "string") console.log(JSON.stringify(r, null, 2));
      else console.log(r);
    })
    .catch((e) => {
      console.error(String(e.message || e));
      process.exit(1);
    });
}
