import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const { jkScroll, parseWheel, wheelPolicy, PROMPT_ROWS } = require(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/chat-scroll.mjs"),
) as {
  jkScroll: (key: string, input: string) => "up" | "down" | null
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

function promptText(): string {
  const ref = (globalThis as { __gotchiPromptRef?: { current?: { input?: string } } }).__gotchiPromptRef
  return String(ref?.current?.input ?? "")
}

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

function scroll(api: any, dir: "up" | "down") {
  const cmd = dir === "up" ? "session.line.up" : "session.line.down"
  try {
    api.keymap?.dispatchCommand?.(cmd)
  } catch {
    /* host keymap owns the scrollbox */
  }
}

const tui: TuiPlugin = async (api) => {
  const r = api.renderer as any
  if (typeof r?.prependInputHandler !== "function") return
  const onSeq = (chunk: unknown) => {
    const str = typeof chunk === "string" ? chunk : Buffer.from((chunk as Uint8Array) || []).toString("binary")
    const wheel = parseWheel(str)
    if (wheel) {
      const decision = wheelPolicy({
        button: wheel.button,
        row: wheel.row,
        rows: termRows(api),
        promptLines: PROMPT_ROWS,
        sessionEmpty: sessionEmpty(api),
      })
      if (decision === "ignore") return true
      return
    }
    if (str !== "j" && str !== "J" && str !== "k" && str !== "K") return
    if (uiBusy(api)) return
    const dir = jkScroll(str, promptText())
    if (!dir) return
    scroll(api, dir)
    return true
  }
  r.prependInputHandler(onSeq)
  api.lifecycle.onDispose(() => {
    try {
      r.removeInputHandler?.(onSeq)
    } catch {
      /* ignore */
    }
  })
}

const plugin: TuiPluginModule & { id: string } = { id: ID, tui }
export default plugin
