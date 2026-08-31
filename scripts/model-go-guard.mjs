#!/usr/bin/env node
/**
 * Route OpenCode TUI models through OpenCode Go (OPENCODE_API_KEY), not OpenCode Zen.
 *
 *   node scripts/model-go-guard.mjs resolve [model]
 *   node scripts/model-go-guard.mjs env [model]     # shell exports for chat-pane.sh
 *   node scripts/model-go-guard.mjs status [model]  # JSON
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_GO = "opencode-go/kimi-k3";

function loadGoPrefer() {
  try {
    const cfg = JSON.parse(readFileSync(`${ROOT}/config/models.auto.json`, "utf8"));
    return (cfg.goPrefer || []).map(String);
  } catch {
    return [
      "opencode-go/kimi-k3",
      "opencode-go/glm-5.3-flash",
      "opencode-go/glm-5.3",
      "opencode-go/grok-4.6",
    ];
  }
}

const GO_PREFER = loadGoPrefer();

export function hasGoApiKey() {
  return Boolean(process.env.OPENCODE_API_KEY?.trim());
}

export function hasZenApiKey() {
  return Boolean(process.env.OPENCODE_ZEN_API_KEY?.trim());
}

/** OpenCode Zen billed models use the `opencode/` provider prefix. */
export function isZenModel(model) {
  const m = String(model || "").trim();
  return m.startsWith("opencode/") && !m.startsWith("opencode-go/");
}

export function resolveGoModel(model) {
  const input = String(model || "").trim() || DEFAULT_GO;
  if (!hasGoApiKey()) {
    return { model: input, remapped: false, wasZen: false, reason: "no-go-key" };
  }
  if (input.startsWith("opencode-go/")) {
    return { model: input, remapped: false, wasZen: false, reason: "already-go" };
  }
  if (isZenModel(input)) {
    const tail = input.slice("opencode/".length);
    const candidate = `opencode-go/${tail}`;
    const mapped = GO_PREFER.includes(candidate) ? candidate : DEFAULT_GO;
    return {
      model: mapped,
      remapped: mapped !== input,
      wasZen: true,
      from: input,
      reason: mapped === candidate ? "zen-to-go" : "zen-to-go-default",
    };
  }
  return { model: input, remapped: false, wasZen: false, reason: "unchanged" };
}

function shellExport(name, value) {
  return `export ${name}=${JSON.stringify(String(value))}`;
}

function main() {
  const cmd = process.argv[2] || "resolve";
  const modelArg = process.argv[3] || process.env.GOTCHIBOT_OPENCODE_MODEL || DEFAULT_GO;
  const result = resolveGoModel(modelArg);

  if (cmd === "resolve") {
    process.stdout.write(result.model);
    return;
  }

  if (cmd === "status") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === "env") {
    const lines = [shellExport("GOTCHIBOT_OPENCODE_MODEL", result.model)];
    // --continue restores the session's last model (often OpenCode Zen) and ignores -m.
    if (result.remapped && result.wasZen && hasGoApiKey()) {
      lines.push("export GOTCHIBOT_OPENCODE_CONTINUE=0");
      lines.push("export GOTCHIBOT_MODEL_GO_REMAP=1");
    }
    console.log(lines.join("\n"));
    return;
  }

  console.error(`usage:
  model-go-guard.mjs resolve [model]
  model-go-guard.mjs env [model]
  model-go-guard.mjs status [model]`);
  process.exit(2);
}

if (process.argv[1]?.endsWith("model-go-guard.mjs")) {
  main();
}
