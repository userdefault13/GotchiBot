/** Curated models for GotchiBot when gateway models.list is empty or unreachable. */
export type GotchiModelPickerItem = {
  value: string;
  label: string;
  description: string;
};

/**
 * OpenClaw gateway free default (Cloudflare Workers AI). OpenCode Zen ids (opencode/*) are NOT
 * on the gateway; opencode-go/* and cloudflare-wai/* are. Override with GOTCHIBOT_FREE_MODEL.
 */
export const OPENCLAW_FREE_MODEL =
  (process.env.GOTCHIBOT_FREE_MODEL || "cloudflare-wai/@cf/zai-org/glm-4.7-flash").trim();

export const GOTCHI_MODEL_TIER_ALIASES: Record<string, string> = {
  auto: "opencode-go/glm-5.3-flash",
  free: OPENCLAW_FREE_MODEL,
  nim: OPENCLAW_FREE_MODEL,
  hy3: OPENCLAW_FREE_MODEL,
  ultra: "opencode-go/kimi-k3",
  glm: "cloudflare-wai/@cf/zai-org/glm-4.7-flash",
  flashcf: "cloudflare-wai/@cf/zai-org/glm-4.7-flash",
  fast: "opencode-go/glm-5.3-flash",
  lightning: "opencode-go/glm-5.3-flash",
  nimlightning: "nvidia-nim/nvidia/nemotron-3.5-lightning-30b-a3b",
  flash: "opencode-go/glm-5.3-flash",
  pro: "opencode-go/kimi-k3",
};

const GOTCHI_MODEL_CATALOG_ITEMS: GotchiModelPickerItem[] = [
  {
    value: OPENCLAW_FREE_MODEL,
    label: OPENCLAW_FREE_MODEL.replace("/@cf/zai-org/", "/"),
    description: "Free default · Cloudflare Workers AI (gateway)",
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
    value: "opencode-go/glm-5.3-flash",
    label: "opencode-go/glm-5.3-flash",
    description: "Fast · OpenCode Go · needs OPENCODE_API_KEY",
  },
  {
    value: "opencode-go/kimi-k3",
    label: "opencode-go/kimi-k3",
    description: "Hard reasoning · OpenCode Go · needs OPENCODE_API_KEY",
  },
];

/** First entry wins, so the free default never shows twice (e.g. when it is glm-4.7-flash). */
export const GOTCHI_MODEL_CATALOG: GotchiModelPickerItem[] = GOTCHI_MODEL_CATALOG_ITEMS.filter(
  (item, i, all) => all.findIndex((x) => x.value === item.value) === i,
);

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
