import { mkdirSync, appendFileSync } from "node:fs"
import { join } from "node:path"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

const ID = "gotchi.queue-multitask"

/**
 * Codex-style multitask while OpenCode shows QUEUED/busy:
 * `/new` creates a fresh session and navigates to it — current session keeps running.
 * On busy, toast once per busy stretch so Julius knows the escape hatch.
 */

function rootDirOf(api: any): string {
  return (
    api?.state?.path?.directory ||
    api?.state?.path?.worktree ||
    process.env.GOTCHIBOT_ROOT ||
    process.cwd()
  )
}

function log(rootDir: string, event: string, extra: Record<string, unknown> = {}) {
  try {
    const dir = join(rootDir, "sessions")
    mkdirSync(dir, { recursive: true })
    appendFileSync(
      join(dir, "gotchi-queue-multitask.log"),
      `${JSON.stringify({ t: new Date().toISOString(), event, ...extra })}\n`,
    )
  } catch {
    /* ignore */
  }
}

function currentSessionId(api: any): string | null {
  const cur = api.route?.current
  if (cur?.name === "session" && cur.params?.sessionID) return String(cur.params.sessionID)
  return null
}

async function createAndOpenSession(api: any, rootDir: string, reason: string) {
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ")
  try {
    const res = await api.client.session.create({
      title: `multitask · ${stamp}`,
      agent: "gotchi",
    })
    const data = (res as any)?.data ?? res
    const id = data?.id || data?.sessionID || data?.session?.id
    if (!id) {
      api.ui.toast({
        message: "Could not create session — no id returned",
        variant: "error",
      })
      log(rootDir, "create-no-id", { res: String(res).slice(0, 200) })
      return
    }
    api.route.navigate("session", { sessionID: String(id) })
    api.ui.toast({
      message: `New session open — prior chat keeps running (${reason})`,
      variant: "success",
      duration: 4000,
    })
    log(rootDir, "opened", { id: String(id), reason })
  } catch (err) {
    api.ui.toast({
      message: `New session failed: ${String(err).slice(0, 120)}`,
      variant: "error",
    })
    log(rootDir, "create-error", { err: String(err) })
  }
}

function offerMultitaskDialog(api: any, rootDir: string) {
  try {
    api.ui.dialog.replace(
      () =>
        api.ui.DialogSelect({
          title: "Session busy (QUEUED)",
          options: [
            {
              title: "Open new session to multitask",
              value: "new",
              description: "Codex-style — keep this chat running, work in a fresh session",
            },
            {
              title: "Stay here (leave message queued)",
              value: "stay",
              description: "Current turn finishes, then queued prompts run",
            },
          ],
          onSelect: (opt: { value: string }) => {
            api.ui.dialog.clear()
            if (opt?.value === "new") void createAndOpenSession(api, rootDir, "dialog")
          },
        }),
    )
  } catch (err) {
    log(rootDir, "dialog-failed", { err: String(err) })
    try {
      api.ui.toast({
        message: "Busy — type /new to multitask in a fresh session",
        variant: "info",
        duration: 5000,
      })
    } catch {}
  }
}

const tui: TuiPlugin = async (api) => {
  const rootDir = rootDirOf(api)
  let lastBusyToastAt = 0
  let lastBusySession: string | null = null

  try {
    api.keymap.registerLayer({
      commands: [
        {
          name: "gotchi.session.new",
          title: "New session (multitask)",
          category: "Gotchi",
          namespace: "palette",
          slashName: "new",
          run: () => {
            void createAndOpenSession(api, rootDir, "slash")
          },
        },
        {
          name: "gotchi.session.multitask",
          title: "Multitask while busy",
          category: "Gotchi",
          namespace: "palette",
          slashName: "multitask-session",
          run: () => {
            const sid = currentSessionId(api)
            const st = sid ? api.state?.session?.status?.(sid) : null
            if (st?.type === "busy") {
              offerMultitaskDialog(api, rootDir)
            } else {
              void createAndOpenSession(api, rootDir, "multitask-session")
            }
          },
        },
      ],
    })
  } catch (err) {
    log(rootDir, "keymap-failed", { err: String(err) })
  }

  try {
    api.event.on("session.status", (ev: any) => {
      const status = ev?.properties?.status || ev?.status
      const sid = String(ev?.properties?.sessionID || ev?.sessionID || currentSessionId(api) || "")
      if (status?.type !== "busy") {
        if (sid && sid === lastBusySession) lastBusySession = null
        return
      }
      const now = Date.now()
      // One toast per busy stretch (debounce 8s)
      if (sid === lastBusySession && now - lastBusyToastAt < 8000) return
      lastBusySession = sid || lastBusySession
      lastBusyToastAt = now
      try {
        api.ui.toast({
          message: "QUEUED/busy — /new opens a parallel session (Codex-style)",
          variant: "info",
          duration: 5000,
        })
      } catch {}
      log(rootDir, "busy-toast", { sid })
    })
  } catch (err) {
    log(rootDir, "event-failed", { err: String(err) })
  }

  log(rootDir, "loaded", {})
}

const plugin: TuiPluginModule & { id: string } = {
  id: ID,
  tui,
}

export default plugin
