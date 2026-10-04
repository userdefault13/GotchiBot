import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const { arrowPolicy, parseArrow, parseWheel, wheelPolicy, PROMPT_ROWS } = require(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/chat-scroll.mjs"),
) as {
  arrowPolicy: (input: {
    kind: string | null
    busy?: boolean
    cursorOffset?: number
    visualRow?: number
    lineCount?: number
    textLength?: number
  }) => "scroll-up" | "scroll-down" | "history-previous" | "history-next" | "passthrough"
  parseArrow: (chunk: string) => "up" | "down" | "ctrl-up" | "ctrl-down" | null
  parseWheel: (chunk: string) => { button: number; col: number; row: number } | null
  wheelPolicy: (input: {
    button: number
    row: number
    rows: number
    promptLines?: number
    sessionEmpty?: boolean
  }) => "passthrough" | "ignore"
  PROMPT_ROWS: number
}

const ID = "gotchi.chat-scroll"

function termRows(api: any): number {
  const r = api?.renderer
  const n = Number(r?.height ?? r?.rows ?? process.stdout.rows ?? 0)
  return Number.isFinite(n) ? n : 0
}

function sessionEmpty(api: any): boolean {
  const cur = api?.route?.current
  if (!cur || cur.name !== "session") return true
  const id = cur.params?.sessionID
  if (!id) return true
  try {
    const msgs = api.state?.session?.messages?.(id)
    return !msgs || msgs.length === 0
  } catch {
    return false
  }
}

function uiBusy(api: any): boolean {
  try {
    if (api?.ui?.dialog?.open) return true
  } catch {
    /* ignore */
  }
  try {
    const mode = api?.mode?.current?.()
    if (mode && mode !== "base") return true
  } catch {
    /* ignore */
  }
  return false
}

function editorCaret(api: any) {
  const r = api?.renderer
  const ed = r?.currentFocusedEditor
  if (!ed || typeof ed.cursorOffset !== "number") return {}
  const row = Number(ed.scrollY ?? 0) + Number(ed.visualCursor?.visualRow ?? 0)
  let lineCount = 1
  try {
    const n = ed.editorView?.getTotalVirtualLineCount?.()
    if (Number.isFinite(n) && n > 0) lineCount = n
    else lineCount = String(ed.plainText ?? "").split("\n").length || 1
  } catch {
    lineCount = String(ed.plainText ?? "").split("\n").length || 1
  }
  return {
    cursorOffset: ed.cursorOffset,
    visualRow: row,
    lineCount,
    textLength: typeof ed.plainText === "string" ? ed.plainText.length : undefined,
  }
}

function scroll(api: any, dir: "up" | "down") {
  const cmd = dir === "up" ? "session.line.up" : "session.line.down"
  try {
    api.keymap?.dispatchCommand?.(cmd)
  } catch {
    /* host keymap owns the scrollbox */
  }
}

function showScrollbar(api: any) {
  try {
    api.kv?.set?.("scrollbar_visible", true)
    return true
  } catch {
    return false
  }
}

const tui: TuiPlugin = async (api) => {
  const reveal = () => showScrollbar(api)
  reveal()
  let timer: ReturnType<typeof setInterval> | undefined
  if (!api.kv?.ready) {
    const started = Date.now()
    timer = setInterval(() => {
      if (reveal() || Date.now() - started > 4000) {
        if (timer) clearInterval(timer)
      }
    }, 200)
  }

  const r = api.renderer as any
  if (typeof r?.prependInputHandler !== "function") return
  const onSeq = (chunk: unknown) => {
    const str = typeof chunk === "string" ? chunk : Buffer.from((chunk as Uint8Array) || []).toString("binary")
    const kind = parseArrow(str)
    if (kind) {
      const decision = arrowPolicy({ kind, busy: uiBusy(api), ...editorCaret(api) })
      if (decision === "scroll-up" || decision === "scroll-down") {
        scroll(api, decision === "scroll-up" ? "up" : "down")
        return true
      }
      // Ctrl+Up/Down stay on prompt.history.* (tui.json). Movement stays with the textarea.
      return
    }
    const wheel = parseWheel(str)
    if (!wheel) return
    const decision = wheelPolicy({
      button: wheel.button,
      row: wheel.row,
      rows: termRows(api),
      promptLines: PROMPT_ROWS,
      sessionEmpty: sessionEmpty(api),
    })
    if (decision === "ignore") return true
  }
  r.prependInputHandler(onSeq)
  api.lifecycle.onDispose(() => {
    if (timer) clearInterval(timer)
    try {
      r.removeInputHandler?.(onSeq)
    } catch {
      /* ignore */
    }
  })
}

const plugin: TuiPluginModule & { id: string } = { id: ID, tui }
export default plugin
