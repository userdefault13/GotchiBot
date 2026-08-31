/**
 * OpenCode Go: strip unsupported chat-completions fields.
 *
 * OpenCode 1.18.x sends `order` on Console Go requests (Kimi, GLM, …).
 * Upstream rejects it:
 *   Extra inputs are not permitted, field: 'order'
 *   Unsupported request parameter(s): order
 *
 * Some models lock sampling server-side — omit temperature when
 * capabilities.temperature === false.
 */
export const OpenCodeGoKimiFix = async () => {
  return {
    "chat.params": async (input, output) => {
      const providerId =
        input.provider?.info?.id || input.model?.providerID || "";
      const modelId = String(input.model?.api?.id || input.model?.id || "");
      const isGo =
        providerId === "opencode-go" ||
        (!providerId && /^(kimi-|glm-|grok-|minimax-|deepseek-)/i.test(modelId));
      if (!isGo) return;

      const stripOrder = (obj) => {
        if (!obj || typeof obj !== "object") return;
        if ("order" in obj) delete obj.order;
      };

      stripOrder(output);
      stripOrder(output.options);
      if (output.options && typeof output.options === "object") {
        for (const v of Object.values(output.options)) stripOrder(v);
      }

      if (input.model?.capabilities?.temperature === false) {
        output.temperature = undefined;
        output.topP = undefined;
        output.topK = undefined;
      }
    },
  };
};
