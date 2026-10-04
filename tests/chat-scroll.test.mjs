/**
 * Arrows scroll the chat unless the prompt cursor can move. Ctrl+Up recalls history.
 * The wheel scrolls the transcript, not the prompt.
 *   node --test tests/chat-scroll.test.mjs
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { arrowPolicy, parseArrow, parseWheel, wheelPolicy, PROMPT_ROWS } from "../scripts/chat-scroll.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const at = (extra) => ({ cursorOffset: 0, visualRow: 0, lineCount: 1, textLength: 0, ...extra })

describe("chat arrows", () => {
  it("scrolls when the caret cannot move and leaves movement to the prompt", () => {
    assert.equal(arrowPolicy({ kind: "up", ...at({}) }), "scroll-up")
    assert.equal(arrowPolicy({ kind: "down", ...at({ textLength: 0 }) }), "scroll-down")
    assert.equal(arrowPolicy({ kind: "up", ...at({ cursorOffset: 4, textLength: 4 }) }), "passthrough")
    assert.equal(arrowPolicy({ kind: "down", ...at({ textLength: 4 }) }), "passthrough")
    assert.equal(
      arrowPolicy({ kind: "up", ...at({ visualRow: 1, lineCount: 3, cursorOffset: 8, textLength: 12 }) }),
      "passthrough",
    )
    assert.equal(
      arrowPolicy({ kind: "down", ...at({ visualRow: 0, lineCount: 3, textLength: 12 }) }),
      "passthrough",
    )
    assert.equal(
      arrowPolicy({ kind: "down", ...at({ visualRow: 2, lineCount: 3, cursorOffset: 12, textLength: 12 }) }),
      "scroll-down",
    )
    assert.equal(arrowPolicy({ kind: "up", busy: true, ...at({}) }), "passthrough")
    assert.equal(arrowPolicy({ kind: "ctrl-up", ...at({ textLength: 3, cursorOffset: 3 }) }), "history-previous")
    assert.equal(arrowPolicy({ kind: "ctrl-down", ...at({}) }), "history-next")
    assert.equal(arrowPolicy({ kind: "ctrl-up", busy: true }), "passthrough")
  })

  it("parses plain and ctrl arrows and ignores j/k", () => {
    assert.equal(parseArrow("\x1b[A"), "up")
    assert.equal(parseArrow("\x1b[B"), "down")
    assert.equal(parseArrow("\x1bOA"), "up")
    assert.equal(parseArrow("\x1b[1;5A"), "ctrl-up")
    assert.equal(parseArrow("\x1b[1;5B"), "ctrl-down")
    assert.equal(parseArrow("j"), null)
    assert.equal(parseArrow("k"), null)
  })
})

describe("chat wheel", () => {
  it("scrolls the transcript and ignores the prompt band", () => {
    const rows = 40
    assert.equal(wheelPolicy({ button: 64, row: 10, rows }), "passthrough")
    assert.equal(wheelPolicy({ button: 65, row: 10, rows }), "passthrough")
    assert.equal(wheelPolicy({ button: 64, row: rows - PROMPT_ROWS + 1, rows }), "ignore")
    assert.equal(wheelPolicy({ button: 65, row: rows, rows }), "ignore")
    assert.equal(wheelPolicy({ button: 0, row: rows, rows }), "passthrough")
    assert.equal(wheelPolicy({ button: 64, row: 2, rows, sessionEmpty: true }), "ignore")
  })

  it("parses SGR and X10 wheel sequences", () => {
    assert.deepEqual(parseWheel("\x1b[<64;3;12M"), { button: 64, col: 3, row: 12 })
    assert.deepEqual(parseWheel("\x1b[<65;8;39m"), { button: 65, col: 8, row: 39 })
    const x10 = `\x1b[M${String.fromCharCode(32 + 64)}${String.fromCharCode(32 + 4)}${String.fromCharCode(32 + 30)}`
    assert.deepEqual(parseWheel(x10), { button: 64, col: 4, row: 30 })
  })
})

describe("chat pane wires the policy", () => {
  it("shows the scrollbar, binds history to ctrl+arrows, and keeps mouse for the transcript", () => {
    const pane = readFileSync(path.join(root, "scripts/chat-pane.sh"), "utf8")
    assert.match(pane, /GOTCHIBOT_OPENCODE_MOUSE=1/)
    assert.doesNotMatch(pane, /OPENCODE_DISABLE_MOUSE=true/)
    const cfg = JSON.parse(readFileSync(path.join(root, "config/tui.json"), "utf8"))
    assert.equal(cfg.mouse, true)
    assert.equal(cfg.keybinds.history_previous, "ctrl+up")
    assert.equal(cfg.keybinds.history_next, "ctrl+down")
    assert.ok(!String(cfg.keybinds.messages_line_up || "").split(",").includes("up"))
    assert.ok(cfg.plugin.some((p) => p.includes("gotchi-chat-scroll")))
    const plugin = readFileSync(path.join(root, ".opencode/tui-plugins/gotchi-chat-scroll.ts"), "utf8")
    assert.match(plugin, /scrollbar_visible/)
    assert.doesNotMatch(plugin, /jkScroll/)
  })
})
