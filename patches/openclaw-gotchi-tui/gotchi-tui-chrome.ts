// GotchiBot OpenClaw TUI chrome — OpenCode-like minimal header/footer.
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import { modelKey } from "../agents/model-ref-shared.js";
import { formatTokenCount } from "../utils/usage-format.js";
import type { SessionInfo } from "./tui-types.js";

export function isGotchiOpencodeChrome(): boolean {
  const style = process.env.GOTCHIBOT_TUI_STYLE?.trim().toLowerCase();
  const theme = process.env.OPENCLAW_THEME?.trim().toLowerCase();
  return style === "opencode" || theme === "opencode" || theme === "gotchi-opencode";
}

export function resolveGotchiTuiTitle(fallback = "Gotchi"): string {
  return process.env.GOTCHIBOT_TUI_TITLE?.trim() || fallback;
}

function formatModelLabel(sessionInfo: SessionInfo): string {
  const model = splitTrailingAuthProfile(sessionInfo.model ?? "").model;
  const provider = sessionInfo.modelProvider?.trim();
  if (!model && !provider) {
    return "…";
  }
  if (!model) {
    return provider || "…";
  }
  return provider ? modelKey(provider, model) : model;
}

/** Hide noisy system lines in Gotchi minimal chrome. */
export function shouldSuppressGotchiSystemLine(text: string): boolean {
  const line = text.trim();
  if (/^session agent:/i.test(line)) return true;
  if (/^session [a-z0-9:_-]+$/i.test(line)) return true;
  if (/^gateway (connected|reconnected)/i.test(line)) return true;
  if (/^local ready$/i.test(line)) return true;
  return false;
}

function formatTokenFooter(total?: number | null, context?: number | null): string | null {
  if (total == null && context == null) {
    return null;
  }
  const totalLabel = total == null ? "?" : formatTokenCount(total);
  if (context == null) {
    return `${totalLabel} tokens`;
  }
  return `${totalLabel} / ${formatTokenCount(context)} ctx`;
}

/** One-line header similar to OpenCode session bar. */
export function formatGotchiOpencodeHeader(params: {
  agentLabel: string;
  sessionInfo: SessionInfo;
}): string {
  const title = resolveGotchiTuiTitle();
  const model = formatModelLabel(params.sessionInfo);
  return `${title} · ${params.agentLabel} · ${model}`;
}

/** Compact footer: model + optional token usage only. */
export function formatGotchiOpencodeFooter(params: {
  sessionInfo: SessionInfo;
  thinkingLevel?: string | null;
}): string {
  const model = formatModelLabel(params.sessionInfo);
  const thinking = params.thinkingLevel?.trim();
  const thinkingLabel =
    thinking && thinking !== "off" ? ` · think ${thinking}` : "";
  const tokens = formatTokenFooter(
    params.sessionInfo.totalTokens ?? null,
    params.sessionInfo.contextTokens ?? null,
  );
  return [model + thinkingLabel, tokens].filter(Boolean).join(" · ");
}

/** Blank lines between user question and assistant answer (OpenCode-like). */
export function gotchiTurnGapLines(): number {
  const raw = process.env.GOTCHIBOT_TUI_TURN_GAP?.trim();
  if (raw && /^\d+$/.test(raw)) {
    return Math.min(4, Math.max(1, Number(raw)));
  }
  return 2;
}

/** Prefix user lines with a left accent bar inside the message block. */
export function formatGotchiUserMessageText(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.length ? `▎ ${line}` : "▎"))
    .join("\n");
}

/** Scrollable alt-screen layout (fixed header/footer + wheel history). */
export function isGotchiScrollLayout(): boolean {
  if (!isGotchiOpencodeChrome()) {
    return false;
  }
  const raw = process.env.GOTCHIBOT_TUI_SCROLL?.trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

export function resolveGotchiWheelScrollLines(): number {
  const raw = process.env.GOTCHIBOT_TUI_SCROLL_SPEED?.trim();
  if (raw && /^\d+$/.test(raw)) {
    return Math.min(12, Math.max(1, Number(raw)));
  }
  return 4;
}

export function isGotchiTuiMouseEnabled(): boolean {
  const raw = process.env.GOTCHIBOT_TUI_MOUSE?.trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

/** Collapse system notices + tool details (OpenCode /details behavior). */
export function isGotchiCollapsingSystemEnabled(): boolean {
  if (!isGotchiOpencodeChrome()) {
    return false;
  }
  const raw = process.env.GOTCHIBOT_TUI_COLLAPSE_SYSTEM?.trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

/** Hover + right-click TTS on speakable prose (not code blocks). */
export function isGotchiProseTtsEnabled(): boolean {
  if (!isGotchiOpencodeChrome()) {
    return false;
  }
  const raw = process.env.GOTCHIBOT_TUI_PROSE_TTS?.trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

/** Startup progress bar while connecting and loading history. */
export function isGotchiLoadProgressEnabled(): boolean {
  if (!isGotchiOpencodeChrome()) {
    return false;
  }
  const raw = process.env.GOTCHIBOT_TUI_LOAD_PROGRESS?.trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

/** Minimum visible prompt editor rows in Gotchi chrome (default 5). */
export function resolveGotchiPromptLines(): number {
  const raw = process.env.GOTCHIBOT_TUI_PROMPT_LINES?.trim();
  if (raw && /^\d+$/.test(raw)) {
    return Math.min(12, Math.max(2, Number(raw)));
  }
  return 5;
}
