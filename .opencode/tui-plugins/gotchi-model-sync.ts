import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

const ID = "gotchi.model-sync"

/**
 * Persist OpenCode /model (and any in-TUI model change) to sessions/.chat-model
 * (+ pin .gotchi-model.env) so chat-pane.sh respawns relaunch with that model.
 * Never respawn the pane — typing must not flip back to default.
 *
 * OpenCode does NOT expose api.state.model. Live selection lives in:
 *   - Global.Path.state/model.json → recent[0]  (written by local.model.set)
 *   - latest assistant message providerID/modelID
 *   - api.state.config.model
 */

function rootDirOf(api: any): string {
  return (
    api?.state?.path?.directory ||
    api?.state?.path?.worktree ||
    process.env.GOTCHIBOT_ROOT ||
    process.cwd()
  )
}

function stateDirOf(api: any): string {
  return String(api?.state?.path?.state || "").trim()
}

function normalizeModel(raw: unknown): string {
  const s = String(raw || "").trim()
  if (!s || s.startsWith("openclaw/")) return ""
  return s
}

function fromPair(providerID: unknown, modelID: unknown): string {
  const p = String(providerID || "").trim()
  const m = String(modelID || "").trim()
  if (!p || !m) return ""
  return normalizeModel(`${p}/${m}`)
}

function fromObj(c: any): string {
  if (!c || typeof c !== "object") return normalizeModel(c)
  const joined = fromPair(c.providerID ?? c.provider, c.modelID ?? c.modelId ?? c.id)
  if (joined) return joined
  return normalizeModel(c.id || c.model || c.modelID)
}

function fromModelJson(api: any): string {
  const dir = stateDirOf(api)
  if (!dir) return ""
  try {
    const raw = JSON.parse(readFileSync(join(dir, "model.json"), "utf8"))
    const recent = Array.isArray(raw?.recent) ? raw.recent : []
    for (const item of recent) {
      const id = fromObj(item)
      if (id) return id
    }
  } catch {
    /* ignore */
  }
  return ""
}

function fromLatestAssistant(api: any): string {
  try {
    const cur = api?.route?.current
    const sid = cur?.name === "session" ? cur.params?.sessionID : null
    if (!sid) return ""
    const msgs = api?.state?.session?.messages?.(sid) || []
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      const info = m?.info || m
      const role = String(info?.role || m?.role || "")
      if (role && role !== "assistant") continue
      const id = fromPair(info?.providerID, info?.modelID) || fromObj(info?.model)
      if (id) return id
    }
  } catch {
    /* ignore */
  }
  return ""
}

function liveModel(api: any): string {
  const cands = [
    fromModelJson(api),
    fromLatestAssistant(api),
    normalizeModel(api?.state?.config?.model),
    fromObj(api?.kv?.get?.("model")),
  ]
  for (const id of cands) {
    if (id) return id
  }
  return ""
}

function log(root: string, msg: string, extra?: unknown) {
  try {
    const dir = join(root, "sessions")
    mkdirSync(dir, { recursive: true })
    const line = `${new Date().toISOString()} ${msg}${extra ? " " + JSON.stringify(extra) : ""}\n`
    appendFileSync(join(dir, ".model-sync.log"), line)
  } catch {
    /* ignore */
  }
}

function persistModel(root: string, model: string) {
  const sessions = join(root, "sessions")
  mkdirSync(sessions, { recursive: true })
  writeFileSync(join(sessions, ".chat-model"), `${model}\n`)
  // Keep gateway-env pin in sync so openclaw-gateway-env.sh does not override.
  writeFileSync(join(sessions, ".gotchi-model.env"), `export GOTCHIBOT_OPENCODE_MODEL=${JSON.stringify(model)}\n`)
}

const tui: TuiPlugin = async (api) => {
  const root = rootDirOf(api)
  let lastSeen = normalizeModel(process.env.GOTCHIBOT_OPENCODE_MODEL) || ""
  log(root, "plugin-init", { cwd: root, state: stateDirOf(api), lastSeen })

  const tick = () => {
    const live = liveModel(api)
    if (!live || live === lastSeen) return
    lastSeen = live
    try {
      persistModel(root, live)
      log(root, "persist", { model: live })
    } catch (err) {
      log(root, "persist-failed", { err: String(err) })
    }
  }

  const iv = setInterval(tick, 750)
  try {
    api.event?.on?.("session.updated", () => tick())
  } catch {
    /* ignore */
  }
  try {
    api.event?.on?.("message.part.updated", () => tick())
  } catch {
    /* ignore */
  }
  // Immediate sample; /model UI closes often lands on next tick via model.json.
  tick()
  api.lifecycle?.onDispose?.(() => clearInterval(iv))
}

const plugin: TuiPluginModule & { id: string } = {
  id: ID,
  tui,
}

export default plugin
