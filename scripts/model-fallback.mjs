#!/usr/bin/env node
/**
 * Detect provider rate/quota limits and fall back to a free model.
 */
import { readFileSync } from "node:fs";

export const FREE_MODEL = (process.env.GOTCHIBOT_FREE_MODEL || "opencode/hy3-free").trim();

const LIMIT_RE =
  /(?:rate[\s-]?limit|too many requests|quota exceeded|usage limit|token limit|credit balance|insufficient (?:quota|credits|balance)|billing|payment required|overloaded|capacity|resource exhausted|requests per (?:minute|day|hour)|\b429\b|\b402\b|\btpm\b|\brpm\b)/i;

const FREE_MODEL_RE =
  /(?:^opencode\/hy3-free$|^opencode\/nemotron-.*-free$|^openrouter\/.*:free$|^ollama\/)/i;

export function isModelLimitError(text) {
  const s = String(text || "").trim();
  if (!s) return false;
  return LIMIT_RE.test(s);
}

export function isFreeModel(model) {
  const m = String(model || "").trim();
  if (!m) return false;
  if (m === FREE_MODEL) return true;
  return FREE_MODEL_RE.test(m);
}

export function shouldFallbackModel(model, errorText) {
  return isModelLimitError(errorText) && !isFreeModel(model);
}

function readLogBlob(paths) {
  return paths
    .map((p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return "";
      }
    })
    .join("\n");
}

const isCli = process.argv[1]?.endsWith("model-fallback.mjs");

if (isCli) {
  const cmd = process.argv[2];
  switch (cmd) {
    case "check-log": {
      const paths = process.argv.slice(3);
      if (!paths.length) process.exit(1);
      process.exit(isModelLimitError(readLogBlob(paths)) ? 0 : 1);
    }
    case "free-model":
      console.log(FREE_MODEL);
      process.exit(0);
    case "is-limit":
      console.log(isModelLimitError(process.argv.slice(3).join(" ")) ? "yes" : "no");
      process.exit(0);
    default:
      console.error(`usage:
  model-fallback.mjs check-log <file> [file...]
  model-fallback.mjs free-model
  model-fallback.mjs is-limit <message>`);
      process.exit(2);
  }
}
