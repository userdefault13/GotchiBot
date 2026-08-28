import { describe, expect, it } from "vitest";
import {
  extractSpeakableProse,
  hasSpeakableProse,
  isSyntaxLikeLine,
  segmentMarkdownContent,
} from "./gotchi-prose-segments.js";

describe("gotchi-prose-segments", () => {
  it("segments fenced code from prose", () => {
    const source = "Hello there.\n\n```js\nconst x = 1;\n```\n\nMore words.";
    const segments = segmentMarkdownContent(source);
    expect(segments.some((s) => s.kind === "code")).toBe(true);
    expect(segments.some((s) => s.kind === "prose" && s.text.includes("Hello"))).toBe(true);
  });

  it("extracts speakable prose without code", () => {
    const source = "Yes, SOUL.md exists.\n\n```bash\nls SOUL.md\n```\n\nIt lives in the repo root.";
    const prose = extractSpeakableProse(source);
    expect(prose).toContain("SOUL.md exists");
    expect(prose).toContain("repo root");
    expect(prose).not.toContain("```");
    expect(prose).not.toContain("ls SOUL.md");
  });

  it("flags syntax-heavy lines", () => {
    expect(isSyntaxLikeLine("import fs from 'node:fs';")).toBe(true);
    expect(isSyntaxLikeLine("Yes, SOUL.md exists in the repo.")).toBe(false);
  });

  it("reports when prose is speakable", () => {
    expect(hasSpeakableProse("```\ncode only\n```")).toBe(false);
    expect(hasSpeakableProse("Natural language answer.")).toBe(true);
  });
});
