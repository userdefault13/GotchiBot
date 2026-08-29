import { spawn } from "node:child_process"
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

const ID = "gotchi.thought-tts"
const SGR = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g

function log(rootDir: string, msg: string, extra?: unknown) {
  try {
    const dir = join(rootDir, "sessions")
    mkdirSync(dir, { recursive: true })
    const line = `${new Date().toISOString()} ${msg}${extra ? " " + JSON.stringify(extra) : ""}\n`
    appendFileSync(join(dir, ".thought-tts.log"), line)
  } catch {
    // ignore
  }
}

function markLoaded(rootDir: string) {
  try {
    const dir = join(rootDir, "sessions")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, ".thought-tts-loaded.json"),
      JSON.stringify(
        {
          id: ID,
          loadedAt: new Date().toISOString(),
          pid: process.pid,
          execPath: process.execPath,
        },
        null,
        2,
      ) + "\n",
    )
  } catch {
    // ignore
  }
}

function speak(rootDir: string, text: string) {
  const phrase = String(text || "")
    .replace(/\[REDACTED\]/g, "")
    .trim()
    .slice(0, 4000)
  if (!phrase) return null
  const child = spawn("node", [join(rootDir, "scripts", "tts.mjs"), "speak", phrase, "--persona", "gotchi", "--force"], {
    detached: true,
    stdio: "ignore",
    cwd: rootDir,
  })
  child.unref()
  return child
}

function stopPlayback(rootDir: string, child?: { pid?: number; kill?: (sig?: string) => void } | null) {
  if (child?.pid) {
    try {
      process.kill(-child.pid, "SIGTERM")
    } catch {}
    try {
      child.kill?.("SIGTERM")
    } catch {}
  }
  spawn("node", [join(rootDir, "scripts", "tts.mjs"), "stop"], {
    detached: true,
    stdio: "ignore",
    cwd: rootDir,
  }).unref()
}

function sessionId(api: any): string | null {
  const cur = api.route?.current
  if (cur?.name === "session" && cur.params?.sessionID) return String(cur.params.sessionID)
  return null
}

function messageId(m: any): string | null {
  const id = m?.id || m?.info?.id
  return id ? String(id) : null
}

function messageRole(m: any): string | null {
  const role = m?.role || m?.info?.role
  return role ? String(role) : null
}

type Turn = {
  mid: string
  reasoning: Array<{ id: string; text: string }>
  texts: Array<{ id: string; text: string }>
  text: string
}

function clean(s: unknown) {
  return String(s || "").replace(/\[REDACTED\]/g, "").trim()
}

function assistantTurns(api: any): Turn[] {
  const sid = sessionId(api)
  if (!sid) return []
  const out: Turn[] = []
  for (const m of api.state?.session?.messages?.(sid) || []) {
    if (messageRole(m) && messageRole(m) !== "assistant") continue
    const mid = messageId(m)
    if (!mid) continue
    const reasoning: Turn["reasoning"] = []
    const texts: Turn["texts"] = []
    for (const p of api.state.part(mid) || []) {
      if (p?.type === "reasoning" && p.id) {
        const text = clean(p.text)
        if (text) reasoning.push({ id: String(p.id), text })
      }
      if (p?.type === "text" && p.text) {
        const text = clean(p.text)
        if (text) texts.push({ id: String(p.id || ""), text })
      }
    }
    const text = texts.map((t) => t.text).filter(Boolean).join("\n").trim()
    if (reasoning.length || text) out.push({ mid, reasoning, texts, text })
  }
  return out
}

function responseForPart(api: any, partId?: string): string {
  const turns = assistantTurns(api)
  if (partId) {
    const hit = turns.find(
      (t) => t.reasoning.some((r) => r.id === partId) || t.texts.some((x) => x.id === partId),
    )
    if (hit?.text) return hit.text
  }
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].text) return turns[i].text
  }
  return ""
}

function knownPartIds(api: any): Set<string> {
  const ids = new Set<string>()
  for (const t of assistantTurns(api)) {
    for (const r of t.reasoning) if (r.id) ids.add(r.id)
    for (const x of t.texts) if (x.id) ids.add(x.id)
  }
  return ids
}

function walk(node: any, fn: (n: any) => void) {
  if (!node) return
  fn(node)
  let kids: any[] = []
  try {
    kids = node.children || node.getChildren?.() || []
  } catch {
    kids = []
  }
  for (const child of kids) walk(child, fn)
}

function nodeId(node: any): string {
  return node?.id != null ? String(node.id) : ""
}

function nodeBounds(node: any): { x: number; y: number; w: number; h: number } | null {
  const x = Number(node?.x ?? node?.left ?? node?.bounds?.x)
  const y = Number(node?.y ?? node?.top ?? node?.bounds?.y)
  const w = Number(node?.width ?? node?.bounds?.width)
  const h = Number(node?.height ?? node?.bounds?.height)
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null
  return { x, y, w, h }
}

function contains(b: { x: number; y: number; w: number; h: number }, x: number, y: number) {
  return x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h
}

function partIdFromNode(node: any, known: Set<string>): string | null {
  const id = nodeId(node)
  if (id.startsWith("text-")) {
    const partId = id.slice("text-".length)
    if (!known.size || known.has(partId)) return partId
  }
  return null
}

function findResponseAt(api: any, x: number, y: number): string {
  const known = knownPartIds(api)
  const root = api.renderer?.root || api.renderer?.rootNode || api.renderer?.document
  let best: { partId: string; area: number } | null = null

  walk(root, (node) => {
    const partId = partIdFromNode(node, known)
    if (!partId) return
    const b = nodeBounds(node)
    if (b && contains(b, x, y)) {
      const area = b.w * b.h
      if (!best || area < best.area) best = { partId, area }
    }
  })

  if (best) {
    const text = responseForPart(api, best.partId)
    if (text) return text
  }

  try {
    const num = api.renderer?.hitTest?.(x, y)
    const visit = (start: any) => {
      let cur = start
      while (cur) {
        const partId = partIdFromNode(cur, known)
        if (partId) {
          const text = responseForPart(api, partId)
          if (text) return text
        }
        cur = cur.parent || cur.getParent?.()
      }
      return ""
    }
    if (typeof num === "number") {
      let found: any = null
      walk(root, (node) => {
        if (node?.num === num || node?.id === num) found = node
      })
      const hit = visit(found)
      if (hit) return hit
    } else if (num && typeof num === "object") {
      const hit = visit(num)
      if (hit) return hit
    }
  } catch {
    // ignore
  }

  return responseForPart(api)
}

type MouseEvt = { button: number; x: number; y: number; release: boolean }

function parseSgrAll(data: string): MouseEvt[] {
  const out: MouseEvt[] = []
  SGR.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SGR.exec(data))) {
    out.push({
      button: Number.parseInt(m[1] ?? "0", 10),
      x: Number.parseInt(m[2] ?? "1", 10) - 1,
      y: Number.parseInt(m[3] ?? "1", 10) - 1,
      release: m[4] === "m",
    })
  }
  return out
}

function isRightClickRelease(ev: MouseEvt) {
  return ev.release && (ev.button & 64) === 0 && (ev.button & 32) === 0 && (ev.button & 3) === 2
}

function isRightButton(btn: unknown) {
  return btn === 2 || btn === "right" || btn === "RIGHT"
}

const tui: TuiPlugin = async (api) => {
  const rootDir = api.state?.path?.directory || api.state?.path?.worktree || process.cwd()
  markLoaded(rootDir)
  log(rootDir, "plugin-init", { version: api.app?.version, cwd: rootDir, speak: "response" })

  let lastAction = 0
  let speakingChild: ReturnType<typeof spawn> | null = null

  const alive = () => !!(speakingChild && speakingChild.exitCode == null && !speakingChild.killed)

  const interrupt = (why: string) => {
    const now = Date.now()
    if (now - lastAction < 400) return false
    lastAction = now
    stopPlayback(rootDir, speakingChild)
    speakingChild = null
    log(rootDir, "stop", { why })
    try {
      api.ui.toast({ message: "Stopped", variant: "info" })
    } catch {}
    return true
  }

  const speakText = (text: string, why: string) => {
    const now = Date.now()
    if (now - lastAction < 400) return false
    if (alive()) return interrupt(why)
    if (text) {
      const child = speak(rootDir, text)
      if (child) {
        lastAction = now
        speakingChild = child
        child.on("exit", () => {
          if (speakingChild === child) speakingChild = null
        })
        log(rootDir, "speak", { why, chars: text.length, kind: "response" })
        try {
          api.ui.toast({ message: "Reading reply…", variant: "info" })
        } catch {}
        return true
      }
    }
    try {
      api.ui.toast({ message: "No reply yet.", variant: "warning" })
    } catch {}
    log(rootDir, "speak-empty", { why })
    return false
  }

  const speakLatest = () => {
    speakText(responseForPart(api), "command")
  }

  const speakAt = (x: number, y: number, why: string) => {
    speakText(findResponseAt(api, x, y), why)
  }

  try {
    api.keymap.registerLayer({
      commands: [
        {
          name: "gotchi.reply.speak",
          title: "Read reply",
          category: "Gotchi",
          namespace: "palette",
          slashName: "read-reply",
          run: () => (alive() ? interrupt("command") : speakLatest()),
        },
        {
          name: "gotchi.thought.speak",
          title: "Read reply",
          category: "Gotchi",
          namespace: "palette",
          slashName: "read-thought",
          run: () => (alive() ? interrupt("command") : speakLatest()),
        },
      ],
    })
  } catch (err) {
    log(rootDir, "keymap-failed", { err: String(err) })
  }

  const onSequence = (sequence: string) => {
    try {
      for (const ev of parseSgrAll(String(sequence))) {
        if (!isRightClickRelease(ev)) continue
        speakAt(ev.x, ev.y, "sgr")
        return assistantTurns(api).length > 0
      }
    } catch (err) {
      log(rootDir, "sgr-error", { err: String(err) })
    }
    return false
  }

  const r = api.renderer as any
  const unsubs: Array<() => void> = []

  if (typeof r?.prependInputHandler === "function") {
    r.prependInputHandler(onSequence)
    unsubs.push(() => r.removeInputHandler?.(onSequence))
    log(rootDir, "hook", { kind: "prependInputHandler" })
  } else if (typeof r?.addInputHandler === "function") {
    r.addInputHandler(onSequence)
    unsubs.push(() => r.removeInputHandler?.(onSequence))
    log(rootDir, "hook", { kind: "addInputHandler" })
  }

  const onStdin = (chunk: any) => {
    const s = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("binary")
    onSequence(s)
  }
  try {
    process.stdin.on("data", onStdin)
    unsubs.push(() => process.stdin.off("data", onStdin))
    log(rootDir, "hook", { kind: "stdin" })
  } catch (err) {
    log(rootDir, "stdin-failed", { err: String(err) })
  }

  const onRootMouse = (evt: any) => {
    const btn = evt?.button ?? evt?.mouseButton
    const type = String(evt?.type || "")
    const release = type === "up" || type === "mouseup" || type === "mouse:up" || !type
    if (type && !release) return
    if (!isRightButton(btn)) return
    const x = Number(evt?.x)
    const y = Number(evt?.y)
    speakAt(Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : 0, "root-mouse")
    evt?.preventDefault?.()
    evt?.stopPropagation?.()
  }

  const rootNode = r?.root
  if (rootNode && typeof rootNode.on === "function") {
    try {
      rootNode.on("mouse:up", onRootMouse)
      unsubs.push(() => rootNode.off?.("mouse:up", onRootMouse))
      log(rootDir, "hook", { kind: "root.mouse:up" })
    } catch {}
    try {
      rootNode.on("mouseup", onRootMouse)
      unsubs.push(() => rootNode.off?.("mouseup", onRootMouse))
    } catch {}
  }

  const hookThoughtNodes = () => {
    const known = knownPartIds(api)
    if (!known.size) return
    const tree = r?.root || r?.rootNode || r?.document
    walk(tree, (node) => {
      const partId = partIdFromNode(node, known)
      if (!partId) return
      const existing = node.__gotchiThoughtSpeak
      if (existing && node.onMouseUp === existing) return

      const wrap = (evt: any) => {
        const btn = evt?.button ?? evt?.mouseButton ?? evt?.event?.button
        if (isRightButton(btn) || evt?.right || evt?.type === "contextmenu") {
          speakText(responseForPart(api, partId), "node")
          evt?.preventDefault?.()
          evt?.stopPropagation?.()
          return
        }
        const prev = node.__gotchiThoughtPrevUp
        if (typeof prev === "function") return prev.call(node, evt)
      }
      node.__gotchiThoughtPrevUp = node.onMouseUp !== wrap ? node.onMouseUp : node.__gotchiThoughtPrevUp
      node.__gotchiThoughtSpeak = wrap
      node.onMouseUp = wrap
      if (node.handler && typeof node.handler === "object" && node.handler.onMouseUp !== wrap) {
        if (!node.__gotchiThoughtPrevHandlerUp) node.__gotchiThoughtPrevHandlerUp = node.handler.onMouseUp
        node.handler.onMouseUp = (evt: any) => {
          const btn = evt?.button ?? evt?.mouseButton
          if (isRightButton(btn)) {
            speakText(responseForPart(api, partId), "node-handler")
            evt?.preventDefault?.()
            evt?.stopPropagation?.()
            return
          }
          const prev = node.__gotchiThoughtPrevHandlerUp
          if (typeof prev === "function") return prev.call(node.handler, evt)
        }
      }
      if (typeof node.on === "function" && !node.__gotchiThoughtOn) {
        node.__gotchiThoughtOn = true
        node.on("mouse:up", (evt: any) => {
          if (isRightButton(evt?.button)) {
            speakText(responseForPart(api, partId), "node-on")
            evt?.preventDefault?.()
            evt?.stopPropagation?.()
          }
        })
      }
    })
  }

  hookThoughtNodes()
  const timer = setInterval(() => {
    try {
      hookThoughtNodes()
    } catch {}
  }, 1500)
  unsubs.push(() => clearInterval(timer))

  try {
    api.event?.on?.("message.part.updated", () => {
      try {
        hookThoughtNodes()
      } catch {}
    })
  } catch {}

  setTimeout(() => {
    try {
      api.ui.toast({ message: "Reply TTS ready — right-click Thought to hear the reply", variant: "info", duration: 4000 })
    } catch {}
  }, 800)

  api.lifecycle?.onDispose?.(() => {
    for (const u of unsubs) {
      try {
        u()
      } catch {}
    }
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: ID,
  tui,
}

export default plugin
