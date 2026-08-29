/** Curated models for GotchiBot when gateway models.list is empty or unreachable. */
export type GotchiModelPickerItem = {
  value: string;
  label: string;
  description: string;
};

/** OpenClaw gateway free default (iMac primary). OpenCode Zen hy3-free is NOT on the gateway. */
export const OPENCLAW_FREE_MODEL =
  (process.env.GOTCHIBOT_FREE_MODEL || "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free").trim();

export const GOTCHI_MODEL_TIER_ALIASES: Record<string, string> = {
  auto: "openrouter/nvidia/nemotron-3.5-lightning:free",
  free: OPENCLAW_FREE_MODEL,
  nim: OPENCLAW_FREE_MODEL,
  hy3: OPENCLAW_FREE_MODEL,
  ultra: "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
  glm: "cloudflare-wai/@cf/zai-org/glm-4.7-flash",
  flashcf: "cloudflare-wai/@cf/zai-org/glm-4.7-flash",
  fast: "openrouter/nvidia/nemotron-3.5-lightning:free",
  lightning: "openrouter/nvidia/nemotron-3.5-lightning:free",
  nimlightning: "nvidia-nim/nvidia/nemotron-3.5-lightning-30b-a3b",
  flash: "deepseek/deepseek-v4-flash",
  pro: "deepseek/deepseek-v4-pro",
  local: "ollama/qwen2.5:3b",
};

export const GOTCHI_MODEL_CATALOG: GotchiModelPickerItem[] = [
  {
    value: OPENCLAW_FREE_MODEL,
    label: OPENCLAW_FREE_MODEL,
    description: "Free default · OpenRouter (gateway)",
  },
  {
    value: "cloudflare-wai/@cf/zai-org/glm-4.7-flash",
    label: "cloudflare-wai/glm-4.7-flash",
    description: "Free · Cloudflare Workers AI",
  },
  {
    value: "cloudflare-wai/@cf/nvidia/nemotron-3-120b-a12b",
    label: "cloudflare-wai/nemotron-3-120b",
    description: "Free · Cloudflare Nemotron",
  },
  {
    value: "cloudflare-wai/@cf/openai/gpt-oss-120b",
    label: "cloudflare-wai/gpt-oss-120b",
    description: "Free · Cloudflare GPT-OSS",
  },
  {
    value: "nvidia-nim/nvidia/nemotron-3.5-lightning-30b-a3b",
    label: "nvidia-nim/nemotron-3.5-lightning",
    description: "NIM lightning · needs NVIDIA_API_KEY",
  },
  {
    value: "deepseek/deepseek-v4-flash",
    label: "deepseek/deepseek-v4-flash",
    description: "Volume coding · needs DEEPSEEK_API_KEY",
  },
  {
    value: "deepseek/deepseek-v4-pro",
    label: "deepseek/deepseek-v4-pro",
    description: "Hard reasoning · needs DEEPSEEK_API_KEY",
  },
  {
    value: "ollama/qwen2.5:3b",
    label: "ollama/qwen2.5:3b",
    description: "Local offline fallback",
  },
];

/** Models OpenClaw gateway cannot resolve (OpenCode Zen ids, etc.). */
export function isOpenClawUnknownModel(modelRef: string): boolean {
  const m = String(modelRef || "").trim().toLowerCase();
  if (!m) return false;
  if (m.startsWith("opencode/")) return true;
  return false;
}

export function resolveGotchiModelArg(raw: string): string {
  const args = String(raw || "").trim();
  if (!args) return args;
  if (/^default$/i.test(args)) return args;
  if (/^(auto|free)$/i.test(args)) {
    const picked = String(process.env.GOTCHIBOT_OPENCODE_MODEL || "").trim();
    if (picked && !picked.startsWith("opencode/")) return picked;
  }
  const tier = GOTCHI_MODEL_TIER_ALIASES[args.toLowerCase()];
  return tier ?? args;
}

export function gotchiModelPickerItems(): GotchiModelPickerItem[] {
  return GOTCHI_MODEL_CATALOG;
}
