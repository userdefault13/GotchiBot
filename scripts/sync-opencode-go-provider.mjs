#!/usr/bin/env node
/**
 * Register OpenCode Go (opencode-go/*) in opencode.json from the live catalog.
 * Makes /models show "OpenCode Go" — separate from OpenCode Zen (opencode/*).
 *
 * Per-model `provider.npm` is required: Grok/Luna/Muse use Responses (@ai-sdk/openai);
 * MiniMax/some Qwen use Anthropic messages (@ai-sdk/anthropic); the rest stay oa-compat.
 *
 *   node scripts/sync-opencode-go-provider.mjs
 *   node scripts/sync-opencode-go-provider.mjs --force
 *   node scripts/sync-opencode-go-provider.mjs --check
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = `${ROOT}/opencode.json`;
const CACHE = `${ROOT}/sessions/.opencode-go-catalog.json`;
const GO_MODELS_URL = "https://opencode.ai/zen/go/v1/models";
const META_URL = "https://models.opencode.ai/api.json";
const LOCAL_MODELS = `${homedir()}/.cache/opencode/models.json`;

/** Fallback when models.dev metadata is unavailable (from OpenCode Go docs + catalog). */
const NPM_OVERRIDE = {
  "grok-4.6": "@ai-sdk/openai",
  "grok-4.5": "@ai-sdk/openai",
  "gpt-5.6-luna": "@ai-sdk/openai",
  "muse-spark-1.2-contributor": "@ai-sdk/openai",
  "minimax-m3": "@ai-sdk/anthropic",
  "minimax-m2.7": "@ai-sdk/anthropic",
  "minimax-m2.5": "@ai-sdk/anthropic",
  "qwen3.8-flash": "@ai-sdk/anthropic",
  "qwen3.8-max": "@ai-sdk/anthropic",
  "qwen3.7-max": "@ai-sdk/anthropic",
  "qwen3.7-plus": "@ai-sdk/anthropic",
  "qwen3.6-plus": "@ai-sdk/anthropic",
};

function titleCase(id) {
  return String(id || "")
    .replace(/[-_.]+/g, " ")
    .replace(/\bv(\d)/gi, " v$1")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function loadMetaModels() {
  try {
    if (existsSync(LOCAL_MODELS)) {
      const j = JSON.parse(readFileSync(LOCAL_MODELS, "utf8"));
      return j["opencode-go"]?.models || {};
    }
  } catch {
    /* fall through */
  }
  return {};
}

async function fetchMetaModels() {
  try {
    const r = await fetch(META_URL, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) return loadMetaModels();
    const j = await r.json();
    return j["opencode-go"]?.models || loadMetaModels();
  } catch {
    return loadMetaModels();
  }
}

function npmFor(id, meta) {
  return meta?.provider?.npm || meta?.npm || NPM_OVERRIDE[id] || null;
}

/** Catalog fields OpenCode uses to shape provider requests (see opencode.ai/config.json). */
const MODEL_META_KEYS = [
  "temperature",
  "reasoning",
  "tool_call",
  "interleaved",
  "attachment",
  "structured_output",
];

function buildProvider(modelIds, metaById) {
  const models = {};
  for (const id of [...modelIds].sort()) {
    const meta = metaById[id] || {};
    const entry = { name: meta.name || titleCase(id) };
    const npm = npmFor(id, meta);
    if (npm) entry.provider = { npm };
    if (meta.limit) entry.limit = meta.limit;
    for (const key of MODEL_META_KEYS) {
      if (meta[key] !== undefined) entry[key] = meta[key];
    }
    models[id] = entry;
  }
  return {
    npm: "@ai-sdk/openai-compatible",
    name: "OpenCode Go",
    env: ["OPENCODE_API_KEY"],
    options: {
      baseURL: "https://opencode.ai/zen/go/v1",
      apiKey: "{env:OPENCODE_API_KEY}",
    },
    models,
  };
}

async function fetchModelIds() {
  const r = await fetch(GO_MODELS_URL, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`OpenCode Go catalog HTTP ${r.status}`);
  const body = await r.json();
  return (body.data || []).map((m) => m.id).filter(Boolean);
}

function loadCache() {
  try {
    return JSON.parse(readFileSync(CACHE, "utf8"));
  } catch {
    return null;
  }
}

function saveCache(hash, count) {
  mkdirSync(dirname(CACHE), { recursive: true });
  writeFileSync(
    CACHE,
    `${JSON.stringify({ hash, count, syncedAt: new Date().toISOString(), url: GO_MODELS_URL }, null, 2)}\n`,
  );
}

export async function syncOpenCodeGoProvider({ force = false } = {}) {
  const ids = await fetchModelIds();
  const metaById = await fetchMetaModels();
  const fingerprint = ids
    .map((id) => {
      const meta = metaById[id] || {};
      const metaSig = MODEL_META_KEYS.map((k) => `${k}=${meta[k] ?? ""}`).join(",");
      return `${id}:${npmFor(id, meta) || "compat"}:${metaSig}`;
    })
    .sort()
    .join("\n");
  const hash = createHash("sha256").update(fingerprint).digest("hex");
  const cached = loadCache();
  if (!force && cached?.hash === hash) {
    return { changed: false, count: ids.length, hash };
  }

  const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
  cfg.provider = cfg.provider || {};
  cfg.provider["opencode-go"] = buildProvider(ids, metaById);
  if (!String(cfg.model || "").startsWith("opencode-go/")) {
    cfg.model = "opencode-go/kimi-k3";
  }
  writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`);
  saveCache(hash, ids.length);
  return { changed: true, count: ids.length, hash };
}

async function main() {
  const check = process.argv.includes("--check");
  try {
    const result = await syncOpenCodeGoProvider({ force: process.argv.includes("--force") });
    if (check) {
      process.exit(result.changed ? 1 : 0);
    }
    if (result.changed) {
      console.log(`OpenCode Go: synced ${result.count} models → opencode.json`);
    } else {
      console.log(`OpenCode Go: up to date (${result.count} models)`);
    }
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
}

if (process.argv[1]?.endsWith("sync-opencode-go-provider.mjs")) {
  main();
}
