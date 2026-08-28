import { afterEach, describe, expect, it } from "vitest";
import {
  formatGotchiOpencodeFooter,
  formatGotchiOpencodeHeader,
  isGotchiOpencodeChrome,
  isGotchiScrollLayout,
  resolveGotchiWheelScrollLines,
} from "./gotchi-tui-chrome.js";

describe("gotchi-tui-chrome", () => {
  const priorStyle = process.env.GOTCHIBOT_TUI_STYLE;
  const priorTheme = process.env.OPENCLAW_THEME;

  afterEach(() => {
    if (priorStyle === undefined) {
      delete process.env.GOTCHIBOT_TUI_STYLE;
    } else {
      process.env.GOTCHIBOT_TUI_STYLE = priorStyle;
    }
    if (priorTheme === undefined) {
      delete process.env.OPENCLAW_THEME;
    } else {
      process.env.OPENCLAW_THEME = priorTheme;
    }
  });

  it("detects opencode chrome mode from env", () => {
    process.env.GOTCHIBOT_TUI_STYLE = "opencode";
    expect(isGotchiOpencodeChrome()).toBe(true);
    expect(isGotchiScrollLayout()).toBe(true);
  });

  it("respects scroll disable and speed env", () => {
    process.env.GOTCHIBOT_TUI_STYLE = "opencode";
    process.env.GOTCHIBOT_TUI_SCROLL = "0";
    expect(isGotchiScrollLayout()).toBe(false);
    process.env.GOTCHIBOT_TUI_SCROLL_SPEED = "8";
    expect(resolveGotchiWheelScrollLines()).toBe(8);
  });

  it("formats compact header and footer", () => {
    process.env.GOTCHIBOT_TUI_TITLE = "Gotchi";
    const sessionInfo = {
      model: "nemotron",
      modelProvider: "openrouter",
      totalTokens: 1200,
      contextTokens: 128000,
    };
    expect(
      formatGotchiOpencodeHeader({ agentLabel: "owned-954", sessionInfo: sessionInfo as never }),
    ).toBe("Gotchi · owned-954 · openrouter/nemotron");
    expect(formatGotchiOpencodeFooter({ sessionInfo: sessionInfo as never })).toContain(
      "openrouter/nemotron",
    );
    expect(formatGotchiOpencodeFooter({ sessionInfo: sessionInfo as never })).toContain("1.2K");
  });
});
