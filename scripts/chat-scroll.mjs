/**
 * Chat pane scroll policy.
 *
 * Up/Down scroll the transcript when the cursor cannot move that way inside
 * the prompt. Ctrl+Up / Ctrl+Down recall prompt history. The wheel scrolls
 * the transcript and is ignored over the prompt.
 */

/** Prompt box height from gotchi-logo.tsx (border, input, model line). */
export const PROMPT_ROWS = 6

export function parseArrow(chunk) {
  const str = typeof chunk === "string" ? chunk : Buffer.from(chunk || "").toString("binary")
  let m = str.match(/\x1b\[1;5([AB])/) || str.match(/\x1b\[5([AB])/)
  if (m) return m[1] === "A" ? "ctrl-up" : "ctrl-down"
  m = str.match(/\x1b\[([AB])/) || str.match(/\x1bO([AB])/)
  if (m) return m[1] === "A" ? "up" : "down"
  return null
}

/**
 * @returns {"scroll-up"|"scroll-down"|"history-previous"|"history-next"|"passthrough"}
 * passthrough: the prompt (or a dialog) should keep the key.
 */
export function arrowPolicy({
  kind,
  busy = false,
  cursorOffset,
  visualRow,
  lineCount,
  textLength,
} = {}) {
  if (kind !== "up" && kind !== "down" && kind !== "ctrl-up" && kind !== "ctrl-down") return "passthrough"
  if (busy) return "passthrough"
  if (kind === "ctrl-up") return "history-previous"
  if (kind === "ctrl-down") return "history-next"
  const offset = Number(cursorOffset)
  const row = Number(visualRow)
  const lines = Number(lineCount)
  const known = Number.isFinite(offset) && Number.isFinite(row) && Number.isFinite(lines) && lines > 0
  if (!known) return kind === "up" ? "scroll-up" : "scroll-down"
  if (kind === "up") {
    if (row > 0 || offset > 0) return "passthrough"
    return "scroll-up"
  }
  const len = Number(textLength)
  if (row < lines - 1) return "passthrough"
  if (Number.isFinite(len) && offset < len) return "passthrough"
  return "scroll-down"
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
