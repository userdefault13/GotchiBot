import { spawn } from "node:child_process"
import { join } from "node:path"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

function speak(root: string, text: string) {
  const phrase = String(text || "")
    .replace(/\[REDACTED\]/g, "")
    .trim()
    .slice(0, 4000)
  if (!phrase) return false
  spawn("node", [join(root, "scripts", "tts.mjs"), "speak", phrase, "--persona", "gotchi", "--force"], {
    detached: true,
    stdio: "ignore",
  }).unref()
  return true
}

function sessionId(api: any): string | null {
  const cur = api.route?.current
  if (cur?.name === "session" && cur.params?.sessionID) return String(cur.params.sessionID)
  return null
}

function thoughtForPart(api: any, partId?: string): string {
  const sid = sessionId(api)
  if (!sid) return ""
  const msgs = api.state?.session?.messages?.(sid) || []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    const role = m.role || m.info?.role
    if (role && role !== "assistant") continue
    const mid = m.id || m.info?.id
    if (!mid) continue
    const parts = api.state.part(mid) || []
    if (partId) {
      const hit = parts.find((p: any) => p.type === "reasoning" && p.id === partId)
      if (hit?.text) return String(hit.text)
    }
    const reasoning = parts
      .filter((p: any) => p.type === "reasoning")
      .map((p: any) => p.text)
      .join("\n")
      .trim()
    if (reasoning) return reasoning
  }
  return ""
}

function walk(node: any, fn: (n: any) => void) {
  if (!node) return
  fn(node)
  const kids = node.children || node.getChildren?.() || []
  for (const child of kids) walk(child, fn)
}

function hookThoughtNodes(api: any, rootDir: string) {
  const sid = sessionId(api)
  if (!sid) return
  const ids = new Set<string>()
  for (const m of api.state?.session?.messages?.(sid) || []) {
    const mid = m.id || m.info?.id
    if (!mid) continue
    for (const p of api.state.part(mid) || []) {
      if (p.type === "reasoning" && p.id) ids.add("text-" + p.id)
    }
  }
  const root = api.renderer?.root || api.renderer?.rootNode || api.renderer?.document
  walk(root, (node) => {
    if (!node?.id || !ids.has(node.id)) return
    if (node.__gotchiThoughtSpeak) return
    node.__gotchiThoughtSpeak = true
    const partId = String(node.id).slice("text-".length)
    const wrap = (evt: any) => {
      const btn = evt?.button ?? evt?.mouseButton ?? evt?.event?.button
      const right = btn === 2 || btn === "right" || evt?.right || evt?.type === "contextmenu"
      if (right) {
        const text = thoughtForPart(api, partId)
        if (text && speak(rootDir, text)) {
          api.ui?.toast?.({ message: "Reading thought…", variant: "info" })
        } else {
          api.ui?.toast?.({ message: "No thought to read.", variant: "warning" })
        }
        evt?.preventDefault?.()
        evt?.stopPropagation?.()
        return
      }
    }
    const prevUp = node.onMouseUp
    node.onMouseUp = (evt: any) => {
      wrap(evt)
      if (typeof prevUp === "function") return prevUp.call(node, evt)
    }
    if (node.handler && typeof node.handler === "object") {
      const prev = node.handler.onMouseUp
      node.handler.onMouseUp = (evt: any) => {
        wrap(evt)
        if (typeof prev === "function") return prev.call(node.handler, evt)
      }
    }
    if (typeof node.on === "function") node.on("mouseup", wrap)
  })
}

const tui: TuiPlugin = async (api) => {
  const rootDir = api.state?.path?.directory || api.state?.path?.worktree || process.cwd()

  const speakLatest = () => {
    const text = thoughtForPart(api)
    if (text && speak(rootDir, text)) {
      api.ui.toast({ message: "Reading thought…", variant: "info" })
    } else {
      api.ui.toast({ message: "No thought to read.", variant: "warning" })
    }
  }

  api.keymap?.registerLayer?.({
    commands: [
      {
        name: "gotchi.thought.speak",
        title: "Read thought",
        category: "Gotchi",
        namespace: "palette",
        slashName: "read-thought",
        run: speakLatest,
      },
    ],
  })

  const pulse = () => {
    try {
      hookThoughtNodes(api, rootDir)
    } catch {}
  }
  pulse()
  const timer = setInterval(pulse, 1500)
  api.event?.on?.("message.part.updated", pulse)
  api.lifecycle?.onDispose?.(() => clearInterval(timer))
}

const plugin: TuiPluginModule & { id: string } = {
  id: "gotchi.thought-tts",
  tui,
}

export default plugin
