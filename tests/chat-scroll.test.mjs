/**
 * Chat wheel scrolls the transcript, not the prompt. j/k scroll only when empty.
 *   node --test tests/chat-scroll.test.mjs
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { jkScroll, parseWheel, wheelPolicy, PROMPT_ROWS } from "../scripts/chat-scroll.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

describe("chat j/k", () => {
  it("scrolls when the prompt is empty and types when it has text", () => {
    assert.equal(jkScroll("j", ""), "down")
    assert.equal(jkScroll("k", "   "), "up")
    assert.equal(jkScroll("J", ""), "down")
    assert.equal(jkScroll("K", ""), "up")
    assert.equal(jkScroll("j", "hello"), null)
    assert.equal(jkScroll("k", "k"), null)
  })
})

describe("chat wheel", () => {
  it("scrolls the transcript and ignores the prompt band", () => {
    const rows = 40
    assert.equal(wheelPolicy({ button: 64, row: 10, rows }), "passthrough")
    assert.equal(wheelPolicy({ button: 65, row: 10, rows }), "passthrough")
    assert.equal(wheelPolicy({ button: 64, row: rows - PROMPT_ROWS + 1, rows }), "ignore")
    assert.equal(wheelPolicy({ button: 65, row: rows, rows }), "ignore")
    // A click is not a wheel.
    assert.equal(wheelPolicy({ button: 0, row: rows, rows }), "passthrough")
    // Nothing to scroll yet: do not move the prompt.
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
  it("enables OpenCode mouse and loads the scroll plugin", () => {
    const pane = readFileSync(path.join(root, "scripts/chat-pane.sh"), "utf8")
    assert.match(pane, /GOTCHIBOT_OPENCODE_MOUSE=1/)
    assert.doesNotMatch(pane, /OPENCODE_DISABLE_MOUSE=true/)
    const cfg = JSON.parse(readFileSync(path.join(root, "config/tui.json"), "utf8"))
    assert.equal(cfg.mouse, true)
    assert.ok(cfg.plugin.some((p) => p.includes("gotchi-chat-scroll")))
  })
})
