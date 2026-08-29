#!/usr/bin/env node
/**
 * Auto-pick a free, currently listed model.
 *   node scripts/model-auto.mjs pick [--probe] [--json]
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
const CATALOG_URL = "https://openrouter.ai/api/v1/models";
const KEY_URL = "https://openrouter.ai/api/v1/key";
const CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

const DEFAULT_CFG = {
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
    "openrouter/nvidia/nemotron-3.5-content-safety:free",
    "openrouter/openrouter/free",
  ],
  lastResort: "opencode/hy3-free",
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
  if (s.startsWith("openrouter/") || s.startsWith("opencode/") || s.startsWith("ollama/") || s.startsWith("nvidia-nim/")) return s;
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

function aliases() {
  return {
    auto: "AUTO",
    free: "AUTO",
    hy3: "opencode/hy3-free",
    nim: "opencode/hy3-free",
    fast: "opencode/hy3-free",
    heavy: "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
    ultra: "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
    lightning: "openrouter/nvidia/nemotron-3.5-lightning:free",
    flash: "deepseek/deepseek-v4-flash",
    pro: "deepseek/deepseek-v4-pro",
    local: "ollama/qwen2.5:3b",
  };
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
  const prefer = (cfg.prefer || []).map(oc).filter((id) => !skip.has(id));
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
    if (cmd === "pick") return pickModel({ probe, json: true });
    if (cmd === "list") {
      const cfg = loadCfg();
      let listed = [];
      try { listed = [...await fetchCatalog()].sort(); } catch { listed = []; }
      return { prefer: cfg.prefer, lastResort: cfg.lastResort, listed, cache: loadCache() };
    }
    if (cmd === "resolve") return resolveAlias(rest[0] || "auto", { probe, json: true });
    throw new Error("usage: model-auto.mjs pick|list|resolve [alias] [--json] [--probe]");
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
