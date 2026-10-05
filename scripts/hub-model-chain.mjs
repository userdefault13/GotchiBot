#!/usr/bin/env node
/**
 * Hub model chain — the Hub is the source of truth for which model answers.
 *
 * Order: the Hub's OpenCode configured model first, then `hubPrefer` in
 * config/models.auto.json, then the free last resort. Only models the Hub's
 * OpenCode actually lists (GET /config/providers — i.e. configured keys) are
 * kept, and anything cooling down is skipped.
 *
 * When a turn fails on the model, the failure is classified:
 *   - quota / billing / auth  → the whole provider cools down (one Go quota
 *     covers every opencode-go model; trying glm-5.2 next is pointless)
 *   - rate limit / overload / 5xx / stuck → just that model cools down
 *   - anything else is not a model problem and is not retried
 * Cooldowns live in sessions/.hub-model-cooldown.json on the Hub.
 *
 *   node scripts/hub-model-chain.mjs status [--json]   # chain + cooldowns (reads the local OpenCode)
 *   node scripts/hub-model-chain.mjs clear [<model|provider>]
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const FREE_LAST_RESORT = "opencode/big-pickle";
export const DEFAULT_HUB_PREFER = [
  "opencode-go/glm-5.3",
  "nvidia/z-ai/glm-5.3",
  "opencode-go/kimi-k3",
  "nvidia/z-ai/glm-5.3-flash",
  FREE_LAST_RESORT,
];
const PROVIDER_TTL_SEC = 3600;
const MODEL_TTL_SEC = 600;

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

export function cooldownPath(root = ROOT) {
  return join(root, "sessions", ".hub-model-cooldown.json");
}

export function loadCooldowns(root = ROOT) {
  const s = readJson(cooldownPath(root), {});
  return s && typeof s === "object" && s.until ? s : { until: {}, reasons: {} };
}

function saveCooldowns(state, root = ROOT) {
  const path = cooldownPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

/** "nvidia/z-ai/glm-5.3" → { providerID: "nvidia", modelID: "z-ai/glm-5.3" } */
export function splitModel(model) {
  const s = String(model || "").trim();
  const i = s.indexOf("/");
  if (i <= 0 || i === s.length - 1) return null;
  return { providerID: s.slice(0, i), modelID: s.slice(i + 1) };
}

/**
 * What a failed turn says about the model. null = not a model problem.
 * @returns {{ scope: "provider"|"model", ttlSec: number, reason: string } | null}
 */
export function classifyModelError(text) {
  const s = String(text || "");
  if (/usage limit|quota|credit balance|insufficient (?:quota|credits|balance)|billing|payment required|\b402\b/i.test(s)) {
    return { scope: "provider", ttlSec: PROVIDER_TTL_SEC, reason: "quota" };
  }
  if (/unauthori[sz]ed|invalid api key|api key (?:is )?(?:invalid|missing)|\b401\b|\b403\b|forbidden/i.test(s)) {
    return { scope: "provider", ttlSec: PROVIDER_TTL_SEC, reason: "auth" };
  }
  if (/rate[\s-]?limit|too many requests|\b429\b|overloaded|capacity|resource exhausted|\b50[0234]\b|no reply from the model|model error/i.test(s)) {
    return { scope: "model", ttlSec: MODEL_TTL_SEC, reason: "unavailable" };
  }
  return null;
}

export function isCooling(model, state = loadCooldowns(), now = Date.now()) {
  const split = splitModel(model);
  const until = state.until || {};
  if (until[model] && until[model] > now) return true;
  if (split && until[`provider:${split.providerID}`] && until[`provider:${split.providerID}`] > now) return true;
  return false;
}

/** Cool down a model (or its provider) after a classified failure. Returns the key used. */
export function markModelFailed(model, cls, { root = ROOT, now = Date.now() } = {}) {
  if (!cls) return null;
  const split = splitModel(model);
  const key = cls.scope === "provider" && split ? `provider:${split.providerID}` : model;
  const state = loadCooldowns(root);
  state.until = state.until || {};
  state.reasons = state.reasons || {};
  state.until[key] = now + cls.ttlSec * 1000;
  state.reasons[key] = cls.reason;
  saveCooldowns(state, root);
  return key;
}

/** Models the Hub's OpenCode lists (from GET /config/providers). */
export function availableModels(providers) {
  const out = new Set();
  for (const p of providers || []) {
    for (const id of Object.keys(p?.models || {})) out.add(`${p.id}/${id}`);
  }
  return out;
}

/**
 * Ordered, available, not-cooling models for one Hub turn.
 * Falls back to the free model even when everything else is cooling.
 */
export function hubModelChain({ configModel, providers, prefer, state = loadCooldowns(), now = Date.now() } = {}) {
  const avail = availableModels(providers);
  const list = [];
  const push = (m) => {
    const id = String(m || "").trim();
    if (!id || list.includes(id)) return;
    if (avail.size && !avail.has(id)) return;
    if (isCooling(id, state, now)) return;
    list.push(id);
  };
  push(configModel);
  for (const m of prefer || DEFAULT_HUB_PREFER) push(m);
  if (!list.length && (!avail.size || avail.has(FREE_LAST_RESORT))) list.push(FREE_LAST_RESORT);
  return list;
}

/** The hubPrefer list from config/models.auto.json (or the default). */
export function hubPrefer(root = ROOT) {
  const cfg = readJson(join(root, "config", "models.auto.json"), {}) || {};
  return Array.isArray(cfg.hubPrefer) && cfg.hubPrefer.length ? cfg.hubPrefer : DEFAULT_HUB_PREFER;
}

async function main(argv) {
  const [cmd, arg] = argv;
  if (cmd === "clear") {
    const state = loadCooldowns();
    if (arg) {
      delete state.until?.[arg];
      delete state.until?.[`provider:${arg}`];
    } else {
      state.until = {};
      state.reasons = {};
    }
    saveCooldowns(state);
    console.log(arg ? `cleared ${arg}` : "cleared all cooldowns");
    return;
  }
  if (cmd === "status") {
    const base = process.env.GOTCHIBOT_HUB_OPENCODE_URL || "http://127.0.0.1:4096";
    let providers = [];
    let configModel = null;
    try {
      providers = (await (await fetch(`${base}/config/providers`, { signal: AbortSignal.timeout(5000) })).json()).providers || [];
      configModel = (await (await fetch(`${base}/config`, { signal: AbortSignal.timeout(5000) })).json()).model || null;
    } catch {
      /* OpenCode down: chain from config only */
    }
    const state = loadCooldowns();
    const chain = hubModelChain({ configModel, providers, prefer: hubPrefer(), state });
    const now = Date.now();
    const cooling = Object.entries(state.until || {})
      .filter(([, t]) => t > now)
      .map(([k, t]) => ({ key: k, reason: state.reasons?.[k] || "", until: new Date(t).toISOString() }));
    if (argv.includes("--json")) {
      console.log(JSON.stringify({ configModel, chain, cooling }, null, 2));
      return;
    }
    console.log(`configured  ${configModel || "(unknown — OpenCode not reachable)"}`);
    console.log(`chain       ${chain.join(" → ") || "(empty)"}`);
    for (const c of cooling) console.log(`cooling     ${c.key}  ${c.reason}  until ${c.until}`);
    return;
  }
  console.error("usage: hub-model-chain.mjs status [--json] | clear [<model|provider>]");
  process.exit(2);
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
