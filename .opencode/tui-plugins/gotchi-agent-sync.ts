import { spawn } from "node:child_process"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

const ID = "gotchi.agent-sync"
const MODES = new Set(["gotchi", "sub", "verse", "plan", "build", "ask"])

/**
 * OpenCode can flip the primary agent in-process (Ctrl+P) while chat-pane still
 * has gotchi/OpenClaw env + an old transcript. When a new turn lands on a different
 * agent than this process was booted for — especially crossing gotchi ↔ local —
 * persist mode and respawn via agent-mode --restart.
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

function shouldRestart(boot: string, live: string): boolean {
  return boot !== live
}

function restartMode(root: string, agent: string) {
  spawn(process.execPath, [join(root, "scripts", "agent-mode.mjs"), "set", agent, "--restart"], {
    cwd: root,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, GOTCHIBOT_ROOT: root },
  }).unref()
}

function toast(api: any, message: string) {
  try {
    api?.showToast?.({ message, variant: "info" })
  } catch {
    /* optional */
  }
}

export const plugin: TuiPlugin = async (api) => {
  const root = rootDirOf(api)
  const startedAs = bootAgent(root)
  let restarting = false
  let lastSeen = ""
  const startedAt = Date.now()

  const tick = () => {
    if (restarting) return
    const turn = latestTurnAgent(api)
    if (!turn) return
    // Ignore stale history from --continue (only react to turns after boot).
    if (turn.at && turn.at < startedAt - 2000) return
    if (turn.agent === lastSeen) return
    lastSeen = turn.agent
    if (turn.agent === startedAs) return
    if (!shouldRestart(startedAs, turn.agent)) return
    restarting = true
    try {
      mkdirSync(join(root, "sessions"), { recursive: true })
      writeFileSync(
        join(root, "sessions", ".agent-sync.json"),
        `${JSON.stringify({
          id: ID,
          from: startedAs,
          to: turn.agent,
          at: new Date().toISOString(),
        }, null, 2)}\n`,
      )
    } catch {
      /* ignore */
    }
    toast(api, `${turn.agent} needs a fresh pane — restarting…`)
    restartMode(root, turn.agent)
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
  description: "Respawn chat-pane when OpenCode flips gotchi ↔ build/ask/plan in-process",
}
