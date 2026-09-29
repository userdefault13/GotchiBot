import { existsSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"

const ID = "gotchi.desk-sync"
const TICK_MS = 2_000

/**
 * Keeps a terminal attached to a project desk (`gotchibot hub desk open --follow`)
 * and the Hub on the same OpenCode session, both ways:
 *   - terminal `/new` or session switch → Hub adopts it (phone shows the divider)
 *   - New session on the phone / another desk → this terminal navigates to it
 * Inert unless GOTCHIBOT_DESK_SLUG is set. Auth: the Hub pin in sessions/.hub.json.
 */

function toast(api: TuiPluginApi, message: string, variant: "info" | "success" | "warning" | "error" = "info") {
  try {
    api.ui.toast({ message, variant, duration: 4500 })
  } catch {
    // ignore
  }
}

function resolveRoot(api: TuiPluginApi): string {
  const fromApi =
    (api as any).directory ||
    (api as any).worktree ||
    (api as any).state?.path?.directory ||
    (api as any).state?.path?.worktree
  if (typeof fromApi === "string" && fromApi && existsSync(join(fromApi, "scripts"))) return fromApi
  const fromEnv = process.env.GOTCHIBOT_ROOT?.trim() || ""
  if (fromEnv && existsSync(join(fromEnv, "scripts"))) return fromEnv
  return process.cwd()
}

function routeSessionId(api: TuiPluginApi): string | null {
  const cur: any = api.route.current
  return cur?.name === "session" && typeof cur.params?.sessionID === "string" ? cur.params.sessionID : null
}

const tui: TuiPlugin = async (api) => {
  const slug = process.env.GOTCHIBOT_DESK_SLUG?.trim()
  if (!slug) return
  const device = process.env.GOTCHIBOT_DESK_DEVICE?.trim() || ""
  const root = resolveRoot(api)

  let infra: any
  try {
    infra = await import(pathToFileURL(join(root, "scripts", "infra-client.mjs")).href)
  } catch (err) {
    toast(api, `Session sync off: ${String(err)}`, "warning")
    return
  }

  const deskUrl = () => `${infra.assertChatDeskAllowed().base}/api/gotchibot/projects/${encodeURIComponent(slug)}/desk`
  const request = async (method: string, url: string, body?: unknown) => {
    const headers: Record<string, string> = { ...infra.deskAuthHeaders() }
    if (body != null) headers["Content-Type"] = "application/json"
    const res = await fetch(url, { method, headers, body: body != null ? JSON.stringify(body) : undefined })
    const json: any = await res.json().catch(() => ({}))
    if (!res.ok) throw Object.assign(new Error(json?.error || `HTTP ${res.status}`), { status: res.status })
    return json
  }

  let known: string | null = null
  const refused = new Set<string>()
  let busy = false
  let warned = false

  const tick = async () => {
    if (busy) return
    busy = true
    try {
      const hub = await request("GET", deskUrl())
      const hubId: string | null = hub?.sessionId || null
      const here = routeSessionId(api)
      if (hubId && hubId !== known) {
        known = hubId
        if (here !== hubId) {
          api.route.navigate("session", { sessionID: hubId })
          toast(api, "Switched to the project's current session", "info")
        }
      } else if (here && here !== known && !refused.has(here)) {
        const info: any = api.state.session.get(here)
        if (info?.parentID) {
          refused.add(here)
        } else {
          try {
            await request("POST", `${deskUrl()}/session`, { sessionId: here, device })
            known = here
            toast(api, "Session synced to your other devices", "success")
          } catch (err: any) {
            if (err?.status >= 400 && err.status < 500 && err.status !== 401) {
              refused.add(here)
              if (err.status === 409) toast(api, `Not synced: ${err.message}`, "warning")
            } else {
              throw err
            }
          }
        }
      }
      warned = false
    } catch (err: any) {
      if (!warned) {
        warned = true
        toast(api, `Session sync paused: ${String(err?.message || err).split("\n")[0]}`, "warning")
      }
    } finally {
      busy = false
    }
  }

  const iv = setInterval(tick, TICK_MS)
  void tick()
  api.lifecycle?.onDispose?.(() => clearInterval(iv))
}

const plugin: TuiPluginModule & { id: string } = {
  id: ID,
  tui,
}

export default plugin
