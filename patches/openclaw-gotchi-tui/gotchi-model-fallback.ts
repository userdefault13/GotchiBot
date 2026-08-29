import { modelKey } from "../agents/model-ref-shared.js";
import { isOpenClawUnknownModel, OPENCLAW_FREE_MODEL } from "./gotchi-model-catalog.js";

export const FREE_MODEL = OPENCLAW_FREE_MODEL;

const LIMIT_RE =
  /(?:rate[\s-]?limit|too many requests|quota exceeded|usage limit|token limit|credit balance|insufficient (?:quota|credits|balance)|billing|payment required|overloaded|capacity|resource exhausted|requests per (?:minute|day|hour)|\b429\b|\b402\b|\btpm\b|\brpm\b)/i;

const UNKNOWN_MODEL_RE = /unknown model|model not found|invalid model|failed before reply/i;

const FREE_MODEL_RE =
  /(?:^openrouter\/.*:free$|^cloudflare-wai\/|^ollama\/)/i;

export function isModelLimitError(text: string): boolean {
  const s = String(text || "").trim();
  if (!s) return false;
  return LIMIT_RE.test(s);
}

export function isUnknownModelError(text: string): boolean {
  return UNKNOWN_MODEL_RE.test(String(text || ""));
}

export function isFreeModel(modelRef: string): boolean {
  const m = String(modelRef || "").trim();
  if (!m) return false;
  if (m === FREE_MODEL) return true;
  if (isOpenClawUnknownModel(m)) return false;
  return FREE_MODEL_RE.test(m);
}

export function currentSessionModelRef(sessionInfo: {
  modelProvider?: string | null;
  model?: string | null;
}): string {
  const provider = sessionInfo.modelProvider?.trim();
  const model = sessionInfo.model?.trim();
  if (provider && model) return modelKey(provider, model);
  if (model?.includes("/")) return model;
  return model || FREE_MODEL;
}

export function shouldFallbackModel(modelRef: string, errorText: string): boolean {
  if (modelRef === FREE_MODEL) return false;
  if (isUnknownModelError(errorText) || isOpenClawUnknownModel(modelRef)) return true;
  return isModelLimitError(errorText) && !isFreeModel(modelRef);
}
