#!/usr/bin/env node
/**
 * Model selection policy — working models only.
 *
 *   node scripts/model-policy.mjs show [--json]
 *   node scripts/model-policy.mjs pick <scope> [--probe] [--json]
 *   node scripts/model-policy.mjs candidates <scope> [--json]
 *   node scripts/model-policy.mjs enforce <scope>   # exit 0 if policy ok
 *
 * Scopes: meet | colabo | spawn | orch | chat
 *
 * Callers should use completeWithPolicy() / candidatesFor() instead of
 * hard-coding model lists. Policy file: config/model-policy.json
 * Chain lists: config/models.auto.json (via model-auto.mjs)
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  workingModelCandidates,
  markModelCooldown,
  pickModel,
  pickSubagentModel,
} from "./model-auto.mjs";
import { isModelLimitError, FREE_MODEL } from "./model-fallback.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_POLICY = join(ROOT, "config/model-policy.json");

const SCOPES = new Set(["meet", "colabo", "spawn", "orch", "chat"]);

export function loadPolicy() {
  const path =
    process.env.GOTCHIBOT_MODEL_POLICY?.trim() || DEFAULT_POLICY;
  if (!existsSync(path)) {
    return {
      version: 0,
      name: "missing",
      rules: { workingOnly: true, probeOnPick: true, maxAttempts: 6 },
      scopes: {},
      path,
    };
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return { ...raw, path };
}

export function scopeConfig(scope, policy = loadPolicy()) {
  const s = String(scope || "meet").toLowerCase();
  if (!SCOPES.has(s)) {
    throw new Error(`unknown model-policy scope "${scope}" — use ${[...SCOPES].join("|")}`);
  }
  return {
    scope: s,
    ...(policy.scopes?.[s] || {}),
    rules: policy.rules || {},
  };
}

/**
 * Ordered working-model candidates for a scope (cooldowns + skip applied).
 */
export function candidatesFor(scope, policy = loadPolicy()) {
  const cfg = scopeConfig(scope, policy);
  const includeGo = policy.rules?.paidGoDefault === true;
  let list = workingModelCandidates({ includeGo });
  if (!list.includes(FREE_MODEL)) list = [...list, FREE_MODEL];
  const max = Number(cfg.maxAttempts || policy.rules?.maxAttempts || 6);
  return list.slice(0, Math.max(1, max));
}

/**
 * Pick one working model for a scope (probes when policy says so).
 */
export async function pickFor(scope, { probe, json = false } = {}) {
  const policy = loadPolicy();
  const cfg = scopeConfig(scope, policy);
  const doProbe = probe ?? Boolean(policy.rules?.probeOnPick);

  if (cfg.alias === "sub" || cfg.chain === "subagentPrefer") {
    const r = await pickSubagentModel({ json: true });
    if (r?.route === "cursor-cli") {
      return json ? r : "cursor-cli";
    }
    if (r?.model) {
      return json
        ? { ...r, scope: cfg.scope, policy: policy.name, probed: false }
        : r.model;
    }
  }

  const r = await pickModel({ probe: doProbe, json: true });
  const out = {
    model: r.model || FREE_MODEL,
    reason: r.reason || "policy-pick",
    scope: cfg.scope,
    policy: policy.name,
    probed: doProbe,
  };
  return json ? out : out.model;
}

/**
 * Walk working models until run(model) succeeds.
 * run(model) → { ok, text?, stdout?, reason?, status? }
 */
export async function completeWithPolicy(scope, run, { timeoutMs } = {}) {
  const policy = loadPolicy();
  const cfg = scopeConfig(scope, policy);

  if (policy.rules?.workingOnly === false) {
    throw new Error("model-policy workingOnly=false is not supported — edit config/model-policy.json");
  }
  if (process.env.GOTCHIBOT_MEET_SKIP_MODEL_AUTO === "1" && policy.rules?.workingOnly) {
    // Hard rule: workingOnly forbids skipping the picker.
  }

  const tried = [];
  const errors = [];
  let candidates = candidatesFor(scope, policy);
  try {
    const picked = await pickFor(scope, { json: true });
    const m = typeof picked === "string" ? picked : picked?.model;
    if (m && m !== "cursor-cli") {
      candidates = [m, ...candidates.filter((x) => x !== m)];
    }
  } catch {
    /* candidates only */
  }

  for (const model of candidates) {
    if (tried.includes(model)) continue;
    tried.push(model);
    let result;
    try {
      result = await run(model, { timeoutMs, scope: cfg.scope });
    } catch (e) {
      result = { ok: false, reason: "run-threw", stdout: String(e?.message || e) };
    }
    if (result?.ok) {
      return {
        ok: true,
        model,
        scope: cfg.scope,
        policy: policy.name,
        text: result.text || result.stdout || "",
        via: `policy:${cfg.scope}:${model}`,
        result,
      };
    }
    const blob = `${result?.stdout || ""} ${result?.reason || ""} ${result?.text || ""}`;
    errors.push(`${model}:${result?.reason || "fail"}`);
    if (
      policy.rules?.cooldownOnLimit !== false &&
      (result?.reason === "model-limit" ||
        isModelLimitError(blob) ||
        /gateway-http-402|\b402\b|\b429\b|payment required/i.test(blob))
    ) {
      markModelCooldown(model, {
        reason: `policy-${cfg.scope}`,
        ttlSec: policy.rules?.cooldownTtlSec,
      });
      continue;
    }
    if (/opencode not found|ENOENT|command not found/i.test(blob)) break;
  }

  return {
    ok: false,
    scope: cfg.scope,
    policy: policy.name,
    reason: "policy-models-exhausted",
    tried,
    errors,
    openclawAllowed: cfg.openclaw === "fallback" || cfg.openclaw === "primary",
  };
}

export function openclawAllowed(scope, policy = loadPolicy()) {
  const cfg = scopeConfig(scope, policy);
  if (process.env.GOTCHIBOT_MEET_OPENCLAW_FIRST === "1" && cfg.scope === "meet") {
    return "primary";
  }
  return cfg.openclaw || "never";
}

export function policySummary(policy = loadPolicy()) {
  return {
    name: policy.name,
    version: policy.version,
    path: policy.path,
    workingOnly: policy.rules?.workingOnly !== false,
    probeOnPick: Boolean(policy.rules?.probeOnPick),
    scopes: Object.keys(policy.scopes || {}),
    meetCandidates: candidatesFor("meet", policy).slice(0, 4),
  };
}

function usage() {
  console.error(`usage:
  model-policy.mjs show [--json]
  model-policy.mjs pick <meet|colabo|spawn|orch|chat> [--probe] [--json]
  model-policy.mjs candidates <scope> [--json]
  model-policy.mjs enforce <scope>`);
  process.exit(2);
}

async function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const probe = argv.includes("--probe");
  const args = argv.filter((a) => !a.startsWith("--"));
  const cmd = args[0] || "show";
  const scope = args[1] || "meet";

  if (cmd === "show") {
    const s = policySummary();
    if (json) console.log(JSON.stringify(s, null, 2));
    else {
      console.log(`policy  ${s.name} v${s.version}`);
      console.log(`file    ${s.path}`);
      console.log(`rules   workingOnly=${s.workingOnly} probe=${s.probeOnPick}`);
      console.log(`scopes  ${s.scopes.join(", ")}`);
      console.log(`meet →  ${s.meetCandidates.join(" → ")}`);
    }
    return;
  }
  if (cmd === "candidates") {
    const list = candidatesFor(scope);
    if (json) console.log(JSON.stringify({ scope, candidates: list }, null, 2));
    else list.forEach((m) => console.log(m));
    return;
  }
  if (cmd === "pick") {
    const r = await pickFor(scope, { probe, json: true });
    if (json) console.log(JSON.stringify(r, null, 2));
    else console.log(typeof r === "string" ? r : r.model);
    return;
  }
  if (cmd === "enforce") {
    const policy = loadPolicy();
    const cfg = scopeConfig(scope, policy);
    const list = candidatesFor(scope, policy);
    const ok = policy.rules?.workingOnly !== false && list.length > 0;
    if (json) {
      console.log(JSON.stringify({ ok, scope, cfg, candidates: list }, null, 2));
    } else {
      console.log(ok ? `enforce ok  ${scope}  (${list.length} candidates)` : `enforce FAIL ${scope}`);
    }
    process.exit(ok ? 0 : 1);
  }
  usage();
}

const isCli = process.argv[1]?.endsWith("model-policy.mjs");
if (isCli) {
  main().catch((e) => {
    console.error(e?.message || e);
    process.exit(1);
  });
}
