// Split assistant markdown into speakable prose vs code/syntax regions.
export type ContentSegmentKind = "prose" | "code";

export type ContentSegment = {
  kind: ContentSegmentKind;
  text: string;
};

const FENCE_RE = /```[\s\S]*?```/g;

/** Heuristic: line looks like code/syntax rather than natural language. */
export function isSyntaxLikeLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  if (/^```/.test(trimmed)) {
    return true;
  }
  if (/^(\$|>|#)\s/.test(trimmed)) {
    return true;
  }
  if (/^(import|export|const|let|var|function|class|def|async|await|return|if|else|for|while|switch|case)\b/.test(trimmed)) {
    return true;
  }
  if (/^\s*[{}[\]/\\|]/.test(trimmed)) {
    return true;
  }
  if (/^\s*[\w.-]+\s*=\s*[\[{<"'`\d]/.test(trimmed)) {
    return true;
  }
  const symbols = (trimmed.match(/[{}[\]();=<>/\\|`#]/g) ?? []).length;
  const letters = (trimmed.match(/[a-zA-Z]/g) ?? []).length;
  if (trimmed.length >= 24 && symbols >= 4 && symbols / Math.max(letters, 1) > 0.45) {
    return true;
  }
  return false;
}

function stripInlineCode(text: string): string {
  return text.replace(/`[^`\n]+`/g, " ").replace(/\*\*|__|\*|_/g, "");
}

/** Split markdown into fenced-code blocks and remaining prose chunks. */
export function segmentMarkdownContent(source: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  let lastIndex = 0;
  for (const match of source.matchAll(FENCE_RE)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      const prose = source.slice(lastIndex, index);
      if (prose.trim()) {
        segments.push({ kind: "prose", text: prose });
      }
    }
    segments.push({ kind: "code", text: match[0] ?? "" });
    lastIndex = index + (match[0]?.length ?? 0);
  }
  if (lastIndex < source.length) {
    const prose = source.slice(lastIndex);
    if (prose.trim()) {
      segments.push({ kind: "prose", text: prose });
    }
  }
  if (segments.length === 0 && source.trim()) {
    segments.push({ kind: "prose", text: source });
  }
  return segments;
}

/** Prose-only lines suitable for TTS (no fenced/inline code, no syntax-heavy lines). */
export function extractSpeakableProse(source: string): string {
  const parts: string[] = [];
  for (const segment of segmentMarkdownContent(source)) {
    if (segment.kind === "code") {
      continue;
    }
    const lines = stripInlineCode(segment.text)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !isSyntaxLikeLine(line));
    if (lines.length > 0) {
      parts.push(lines.join("\n"));
    }
  }
  return parts.join("\n\n").replace(/\s+/g, " ").trim();
}

export function hasSpeakableProse(source: string): boolean {
  return extractSpeakableProse(source).length > 0;
}
