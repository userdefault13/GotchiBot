import { existsSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { createEffect, createRoot, on } from "solid-js"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"

const ID = "gotchi.desk-sync"
const RETRY_MIN_MS = 1_000
const RETRY_MAX_MS = 30_000

/**
 * Keeps a terminal attached to a project desk (`gotchibot hub desk open --follow`)
 * and the Hub on the same OpenCode session, both ways, event-driven:
 *   - terminal `/new` or session switch (route change) → Hub adopts it (phone shows the divider)
 *   - New session on the phone / another desk → Hub SSE `/desk/events` → this terminal navigates
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

/** Yields each `data:` payload of `event: desk` frames from an SSE body. */
async function* deskEvents(body: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder()
  let buf = ""
  for await (const chunk of body as any) {
    buf += decoder.decode(chunk, { stream: true })
    let cut: number
    while ((cut = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, cut)
      buf = buf.slice(cut + 2)
      const lines = frame.split("\n")
      if (!lines.includes("event: desk")) continue
      const data = lines.filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n")
      try {
        yield JSON.parse(data)
      } catch {
        /* malformed frame */
      }
    }
  }
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

  let known: string | null = null
  let connected = false
  let disposed = false
  const refused = new Set<string>()
  const adopting = new Set<string>()
  let warned = false
  const warnOnce = (msg: string) => {
    if (warned) return
    warned = true
    toast(api, `Session sync paused: ${msg}`, "warning")
  }

  /** Terminal → Hub: the route moved to a session the Hub isn't on. Idempotent. */
  const checkRoute = async () => {
    const here = routeSessionId(api)
    if (!connected || !here || here === known || refused.has(here) || adopting.has(here)) return
    if ((api.state.session.get(here) as any)?.parentID) {
      refused.add(here)
      return
    }
    adopting.add(here)
    try {
      const res = await fetch(`${deskUrl()}/session`, {
        method: "POST",
        headers: { ...infra.deskAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: here, device }),
      })
      const json: any = await res.json().catch(() => ({}))
      if (res.ok) {
        known = here
        toast(api, "Session synced to your other devices", "success")
      } else if (res.status >= 400 && res.status < 500 && res.status !== 401) {
        refused.add(here)
        if (res.status === 409) toast(api, `Not synced: ${json?.error || "another project's session"}`, "warning")
      } else {
        warnOnce(json?.error || `HTTP ${res.status}`)
      }
    } catch (err: any) {
      warnOnce(String(err?.message || err).split("\n")[0])
    } finally {
      adopting.delete(here)
    }
  }

  /** Hub → terminal: the project's current session moved. */
  const onDesk = (ev: { sessionId?: string | null }) => {
    const hubId = ev?.sessionId || null
    if (!hubId || hubId === known) return
    known = hubId
    if (routeSessionId(api) !== hubId) {
      api.route.navigate("session", { sessionID: hubId })
      toast(api, "Switched to the project's current session", "info")
    }
  }

  const abort = new AbortController()
  const listen = async () => {
    let wait = RETRY_MIN_MS
    while (!disposed) {
      try {
        const res = await fetch(`${deskUrl()}/events`, {
          headers: { ...infra.deskAuthHeaders(), Accept: "text/event-stream" },
          signal: abort.signal,
        })
        if (!res.ok || !res.body) {
          const json: any = await res.json().catch(() => ({}))
          throw new Error(json?.error || `HTTP ${res.status}`)
        }
        for await (const ev of deskEvents(res.body)) {
          onDesk(ev)
          if (!connected) {
            connected = true
            warned = false
            wait = RETRY_MIN_MS
          }
          void checkRoute()
        }
      } catch (err: any) {
        if (disposed) return
        warnOnce(String(err?.message || err).split("\n")[0])
      }
      connected = false
      await new Promise((r) => setTimeout(r, wait))
      wait = Math.min(wait * 2, RETRY_MAX_MS)
    }
  }
  void listen()

  // Route changes are a Solid store; the server events cover a host that doesn't share our Solid.
  const disposeRoot = createRoot((dispose) => {
    createEffect(on(() => routeSessionId(api), () => void checkRoute()))
    return dispose
  })
  const offs: Array<() => void> = []
  for (const type of ["session.created", "message.updated", "session.status"]) {
    try {
      const off = (api.event as any).on(type, () => void checkRoute())
      if (typeof off === "function") offs.push(off)
    } catch {
      /* event optional */
    }
  }

  api.lifecycle?.onDispose?.(() => {
    disposed = true
    abort.abort()
    disposeRoot()
    for (const off of offs) off()
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: ID,
  tui,
}

export default plugin
