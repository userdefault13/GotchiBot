/**
 * Chat pane scroll policy.
 *
 * The wheel scrolls the transcript. A wheel event whose row is inside the
 * prompt band is ignored so it cannot walk prompt history or move the cursor.
 * j/k scroll one line only when the prompt is empty (same idea as the meet room).
 */

/** Prompt box height from gotchi-logo.tsx (border, input, model line). */
export const PROMPT_ROWS = 6

export function promptIsEmpty(input) {
  return !String(input ?? "").trim()
}

/** j down (newer), k up (older). Anything else is typed. */
export function jkScroll(key, input) {
  if (!promptIsEmpty(input)) return null
  if (key === "j" || key === "J") return "down"
  if (key === "k" || key === "K") return "up"
  return null
}

/** SGR 64/65 and X10 wheel buttons, including shift/meta/ctrl bits. */
export function wheelDirection(button) {
  const b = Number(button)
  if (!Number.isFinite(b)) return null
  const base = b & 127
  if (base === 4) return "up"
  if (base === 5) return "down"
  if (base >= 64 && base <= 95) return (base & 1) === 0 ? "up" : "down"
  return null
}

/**
 * @returns {"passthrough"|"ignore"}
 * passthrough: OpenCode scrolls the transcript.
 * ignore: swallow the event (prompt, or a session with no transcript).
 */
export function wheelPolicy({ button, row, rows, promptLines = PROMPT_ROWS, sessionEmpty = false }) {
  if (!wheelDirection(button)) return "passthrough"
  if (sessionEmpty) return "ignore"
  const height = Number(rows) || 0
  const band = Number(promptLines) || 0
  const y = Number(row) || 0
  if (height > 0 && band > 0 && y > height - band) return "ignore"
  return "passthrough"
}

/** First SGR or X10 wheel sequence in a raw input chunk. */
export function parseWheel(chunk) {
  const str = typeof chunk === "string" ? chunk : Buffer.from(chunk || "").toString("binary")
  const sgr = str.match(/\x1b\[<(\d+);(\d+);(\d+)[Mm]/)
  if (sgr) {
    return { button: Number(sgr[1]), col: Number(sgr[2]), row: Number(sgr[3]) }
  }
  const x10 = str.match(/\x1b\[M([\s\S])([\s\S])([\s\S])/)
  if (!x10) return null
  return {
    button: x10[1].charCodeAt(0) - 32,
    col: x10[2].charCodeAt(0) - 32,
    row: x10[3].charCodeAt(0) - 32,
  }
}
