#!/usr/bin/env node
/**
 * Auto-pick a free, currently listed model.
 *   node scripts/model-auto.mjs pin [--probe] [--json]
 *   node scripts/model-auto.mjs list [--json]
 *   node scripts/model-auto.mjs resolve <alias>
 *
 * Never prints API keys. Live completion probes are opt-in (--probe).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CFG_PATH = `${ROOT}/config/models.auto.json`;
const CACHE_PATH = `${ROOT}/sessions/.model-auto.json`;
const PIN_PATH = `${ROOT}/sessions/.gotchi-model.env`;
const CATALOG_URL = "https://openrouter.ai/api/v1/models";
const KEY_URL = "https://openrouter.ai/api/v1/key";
const CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

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
    "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
    "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
    "openrouter/nvidia/nemotron-3.5-lightning:free",
    "openrouter/z-ai/glm-5.2:free",
    "openrouter/google/gemma-4-31b-it:free",
    "openrouter/google/gemma-4-26b-a4b-it:free",
    "openrouter/minimax/minimax-m2.7:free",
  ],
  skip: [
    "opencode/hy3-free",
    "openrouter/nvidia/nemotron-3.5-content-safety:free",
    "openrouter/openrouter/free",
  ],
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
  const s = String(id || "").trim();
  if (!s) return "";
  if (
    s.startsWith("openrouter/") ||
    s.startsWith("opencode-go/") ||
    s.startsWith("opencode/") ||
    s.startsWith("ollama/") ||
    s.startsWith("nvidia-nim/") ||
    s.startsWith("deepseek/")
  ) return s;
  return `openrouter/${s}`;
}

function orBare(id) {
  return String(id || "").replace(/^openrouter\//, "");
}

async function fetchCatalog() {
  const r = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`catalog http ${r.status}`);
  const data = await r.json();
  const listed = new Set();
  for (const m of data.data || []) {
    const id = String(m.id || "");
    if (id.endsWith(":free")) listed.add(oc(id));
  }
  return listed;
}

async function keyStatus() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { hasKey: false };
  const r = await fetch(KEY_URL, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) return { hasKey: true, ok: false, status: r.status };
  const j = await r.json();
  const d = j.data || j;
  return {
    hasKey: true,
    ok: true,
    limitRemaining: d.limit_remaining ?? d.limitRemaining ?? null,
    usage: d.usage ?? null,
  };
}

async function probeChat(model) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { ok: true, reason: "no-key" };
  const r = await fetch(CHAT_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: orBare(model),
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  if (r.ok) return { ok: true, reason: "probed" };
  if (/free-models-per-day/i.test(text)) return { ok: false, reason: "daily-limit", skipAllOr: true };
  if (r.status === 429 || r.status === 402) return { ok: false, reason: `http-${r.status}` };
  return { ok: false, reason: `http-${r.status}` };
}

async function ollamaUp() {
  try {
    const r = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
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
    flash: "deepseek/deepseek-v4-flash",
    pro: "deepseek/deepseek-v4-pro",
    local: "ollama/qwen2.5:3b",
    claudemode: "claudemode/@claudemode",
    "@claudemode": "claudemode/@claudemode",
    "claude-mode": "claudemode/@claudemode",
  };
}
function pinModel(model) {
  mkdirSync(`${ROOT}/sessions`, { recursive: true });
  writeFileSync(PIN_PATH, `export GOTCHIBOT_OPENCODE_MODEL=${model}\n`);
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
  const ttlFail = (cfg.ttlFailSec || 1800) * 1000;

  if (cache.dailyLimit && cache.dailyAt && now - cache.dailyAt < ttlFail) {
    const out = { model: cfg.lastResort, reason: "openrouter-daily-limit", cached: true };
    if (json) return out;
    return out.model;
  }
  if (cache.pick && cache.at && now - cache.at < ttlOk && !cache.dailyLimit) {
    const out = { model: cache.pick, reason: cache.reason || "cache", cached: true };
    if (json) return out;
    return out.model;
  }

  let listed = new Set();
  let catalogOk = false;
  try {
    listed = await fetchCatalog();
    catalogOk = true;
  } catch {
    listed = new Set();
  }

  const skip = new Set((cfg.skip || []).map(oc));
  const prefer = buildPrefer(cfg);
  const extras = [...listed].filter((id) => !prefer.includes(id) && !skip.has(id));
  extras.sort();
  const candidates = [...prefer, ...extras, cfg.lastResort];

  const ks = await keyStatus();
  if (ks.hasKey && ks.ok && ks.limitRemaining === 0) {
    saveCache({ pick: cfg.lastResort, at: now, dailyLimit: true, dailyAt: now, reason: "key-limit-remaining-0" });
    const out = { model: cfg.lastResort, reason: "key-exhausted", cached: false };
    if (json) return out;
    return out.model;
  }

  const report = [];
  for (const model of candidates) {
    if (cache.cooldown?.[model] && now < cache.cooldown[model]) {
      report.push({ model, skip: "cooldown" });
      continue;
    }
    if (catalogOk && model.startsWith("openrouter/") && !listed.has(model)) {
      report.push({ model, skip: "not-in-catalog" });
      continue;
    }
    if (probe && model.startsWith("openrouter/")) {
      const p = await probeChat(model);
      if (p.skipAllOr) {
        saveCache({ pick: cfg.lastResort, at: now, dailyLimit: true, dailyAt: now, reason: "daily-limit" });
        const out = { model: cfg.lastResort, reason: "daily-limit", catalog: [...listed], report };
        if (json) return out;
        return out.model;
      }
      if (!p.ok) {
        cache.cooldown = cache.cooldown || {};
        cache.cooldown[model] = now + ttlFail;
        report.push({ model, skip: p.reason });
        continue;
      }
    }
    saveCache({ pick: model, at: now, dailyLimit: false, reason: probe ? "probed" : catalogOk ? "catalog" : "prefer", cooldown: cache.cooldown || {} });
    const out = { model, reason: probe ? "probed" : catalogOk ? "in-catalog" : "offline-prefer", catalogCount: listed.size, report };
    if (json) return out;
    return out.model;
  }

  if (await ollamaUp()) {
    const local = "ollama/qwen2.5:3b";
    saveCache({ pick: local, at: now, reason: "ollama" });
    const out = { model: local, reason: "ollama" };
    if (json) return out;
    return out.model;
  }

  saveCache({ pick: cfg.lastResort, at: now, reason: "last-resort" });
  const out = { model: cfg.lastResort, reason: "last-resort" };
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
      let listed = [];
      try { listed = [...await fetchCatalog()].sort(); } catch { listed = []; }
      return {
        goPrefer: cfg.goPrefer,
        prefer: cfg.prefer,
        effectivePrefer: buildPrefer(cfg),
        opencodeKey: hasOpencodeKey(),
        lastResort: cfg.lastResort,
        listed,
        cache: loadCache(),
      };
    }
    if (cmd === "resolve") return resolveAlias(rest[0] || "auto", { probe, json: true });
if (cmd === "subagent") {
  const r = await pickSubagentModel({ json: argv.includes("--json") });
  if (argv.includes("--json")) {
    return r;
  } else {
    return r.model;
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
