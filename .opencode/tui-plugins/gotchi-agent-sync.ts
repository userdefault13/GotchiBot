import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

const ID = "gotchi.agent-sync"
const MODES = new Set(["gotchi", "sandbox", "verse", "plan", "build", "ask", "project"])

/**
 * Persist OpenCode in-TUI agent cycle (Tab) to sessions/.agent-mode.json.
 * Do not respawn the pane — Julius wants Tab to cycle in the UI.
 */

function rootDirOf(api: any): string {
  return (
    api?.state?.path?.directory ||
    api?.state?.path?.worktree ||
    process.env.GOTCHIBOT_ROOT ||
    process.cwd()
  )
}

function bootAgent(root: string): string {
  const env = String(process.env.GOTCHIBOT_OPENCODE_AGENT || "").trim()
  if (MODES.has(env)) return env
  try {
    const raw = JSON.parse(readFileSync(join(root, "sessions", ".agent-mode.json"), "utf8"))
    const a = String(raw?.agent || "")
    if (MODES.has(a)) return a
  } catch {
    /* ignore */
  }
  return "gotchi"
}

function latestTurnAgent(api: any): { agent: string; at: number } | null {
  try {
    const cur = api?.route?.current
    const sid = cur?.name === "session" ? cur.params?.sessionID : null
    const msgs = (sid && api?.state?.session?.messages?.(sid)) || []
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      const info = m?.info || m
      const role = String(info?.role || m?.role || "")
      if (role && role !== "assistant") continue
      const a = String(info?.agent || info?.agentName || "").trim()
      if (!MODES.has(a)) continue
      const t = Date.parse(String(info?.time?.created || info?.createdAt || info?.time || "")) || 0
      return { agent: a, at: t }
    }
  } catch {
    /* ignore */
  }
  return null
}

function persistMode(root: string, agent: string) {
  spawn(process.execPath, [join(root, "scripts", "agent-mode.mjs"), "set", agent], {
    cwd: root,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, GOTCHIBOT_ROOT: root },
  }).unref()
}

function liveUiAgent(api: any): string | null {
  const cands = [
    api?.state?.agent,
    api?.state?.session?.agent,
    api?.agent,
  ]
  for (const a of cands) {
    const s = String(a || "").trim()
    if (MODES.has(s)) return s
  }
  return null
}

export const plugin: TuiPlugin = async (api) => {
  const root = rootDirOf(api)
  let lastSeen = bootAgent(root)

  const tick = () => {
    const live = liveUiAgent(api) || latestTurnAgent(api)?.agent
    if (!live || live === lastSeen) return
    lastSeen = live
    persistMode(root, live)
  }

  const iv = setInterval(tick, 1000)
  try {
    api.event?.on?.("message.part.updated", () => tick())
  } catch {
    /* ignore */
  }
  api.lifecycle?.onDispose?.(() => clearInterval(iv))
}

export default plugin

export const meta: TuiPluginModule["meta"] = {
  id: ID,
  name: "Gotchi agent sync",
  description: "Persist Tab agent cycle to .agent-mode.json without restarting the pane",
}
