/** @jsxImportSource @opentui/solid */
import { Show, createSignal, onCleanup } from "solid-js"
import { mkdirSync, appendFileSync } from "node:fs"
import { join } from "node:path"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

const ID = "gotchi.steer"

/**
 * Interrupt-and-steer for the OpenCode chat pane.
 *
 * Plain Enter while the gotchi is working queues the line for *after* the turn
 * (OpenCode's own QUEUED behaviour). Steer is the other thing: stop the turn
 * that is running now and send the line straight away, in the same session, so
 * the gotchi keeps its context and changes direction instead of finishing the
 * wrong thing first.
 *
 *   ctrl+o / alt+return   interrupt the running turn, submit what is in the prompt
 *   /steer                same; with an empty prompt it asks for the steer text
 *   [⏹ steer] button      shown to the right of the prompt while the session is busy
 *
 * Idle session: steer is just a submit.
 * The prompt ref comes from gotchi-logo.tsx, which owns the session_prompt slot
 * and renders the session_prompt_right slot this plugin fills.
 */

type PromptRef = {
  focused: boolean
  current: { input: string; mode?: string; parts: unknown[] }
  set(p: { input: string; mode?: "normal" | "shell"; parts: unknown[] }): void
  reset(): void
  focus(): void
  submit(): void
}

const SETTLE_MS = 6000
const POLL_MS = 60
const KEYS = ["ctrl+o", "alt+return"]

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
      join(dir, "gotchi-steer.log"),
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

function promptRef(): PromptRef | null {
  const ref = (globalThis as any).__gotchiPromptRef
  return ref && typeof ref.submit === "function" ? (ref as PromptRef) : null
}

function statusOf(api: any, sid: string): string {
  try {
    return String(api.state?.session?.status?.(sid)?.type || "idle")
  } catch {
    return "idle"
  }
}

function toast(api: any, message: string, variant: "info" | "success" | "warning" | "error" = "info") {
  try {
    api.ui.toast({ message, variant, duration: 3500 })
  } catch {
    /* ignore */
  }
}

/** Abort the running turn and wait until the server reports the session idle. */
async function interruptTurn(api: any, rootDir: string, sid: string): Promise<boolean> {
  try {
    await api.client.session.abort({ path: { id: sid } })
  } catch (err) {
    log(rootDir, "abort-error", { sid, err: String(err) })
    return false
  }
  const until = Date.now() + SETTLE_MS
  while (Date.now() < until) {
    if (statusOf(api, sid) === "idle") return true
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
  log(rootDir, "abort-timeout", { sid, status: statusOf(api, sid) })
  return statusOf(api, sid) === "idle"
}

async function steer(api: any, rootDir: string, text: string) {
  const sid = currentSessionId(api)
  const ref = promptRef()
  if (!sid || !ref) {
    toast(api, "Steer needs an open chat session", "warning")
    log(rootDir, "no-session-or-ref", { sid, hasRef: Boolean(ref) })
    return
  }
  const line = String(text || "").trim()
  if (!line) {
    toast(api, "Nothing to steer with — type the new direction first", "warning")
    return
  }

  const wasBusy = statusOf(api, sid) !== "idle"
  if (wasBusy) {
    toast(api, "Interrupting… steering with your line")
    const idle = await interruptTurn(api, rootDir, sid)
    if (!idle) {
      toast(api, "Could not stop the running turn — line left in the prompt", "error")
      ref.set({ input: line, mode: "normal", parts: [] })
      return
    }
  }

  ref.set({ input: line, mode: "normal", parts: [] })
  ref.focus()
  ref.submit()
  log(rootDir, "steered", { sid, wasBusy, chars: line.length })
  toast(api, wasBusy ? "Steered — turn interrupted, new line sent" : "Sent", "success")
}

function askForSteer(api: any, rootDir: string) {
  try {
    api.ui.dialog.replace(() =>
      api.ui.DialogPrompt({
        title: "Steer the gotchi",
        placeholder: "Stop what you're doing and…",
        onConfirm: (value: string) => {
          api.ui.dialog.clear()
          void steer(api, rootDir, value)
        },
        onCancel: () => api.ui.dialog.clear(),
      }),
    )
  } catch (err) {
    log(rootDir, "dialog-failed", { err: String(err) })
    toast(api, `Type the new direction in the prompt, then ${KEYS[0]}`, "info")
  }
}

/** `[⏹ steer]` beside the prompt — only while the session is busy. Click runs steer. */
const SteerButton = (props: { api: any; sessionId?: string; theme: any; onRun: () => void }) => {
  const [busy, setBusy] = createSignal(
    props.sessionId ? statusOf(props.api, props.sessionId) !== "idle" : false,
  )
  const refresh = () => {
    if (!props.sessionId) return setBusy(false)
    setBusy(statusOf(props.api, props.sessionId) !== "idle")
  }
  try {
    const off = props.api.event.on("session.status", refresh)
    onCleanup(() => {
      try {
        off?.()
      } catch {
        /* ignore */
      }
    })
  } catch {
    /* events optional */
  }
  const timer = setInterval(refresh, 1000)
  onCleanup(() => clearInterval(timer))

  const accent = props.theme?.accent ?? props.theme?.primary
  return (
    <Show when={busy()}>
      <box flexDirection="row" paddingLeft={1} onMouseUp={() => props.onRun()}>
        <text fg={accent}>⏹ steer</text>
        <text fg={props.theme?.textMuted}> {KEYS[0]}</text>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  const rootDir = rootDirOf(api)

  const run = () => {
    const ref = promptRef()
    const text = ref?.current?.input?.trim() || ""
    if (!text) {
      askForSteer(api, rootDir)
      return
    }
    void steer(api, rootDir, text)
  }

  const cmd = {
    name: "gotchi.session.steer",
    title: "Interrupt & steer (send now)",
    description: "Stop the running turn and send the prompt into this session",
    category: "Gotchi",
    namespace: "palette" as const,
    slashName: "steer",
    slash: { name: "steer", aliases: ["interrupt"] },
    keybind: KEYS.join(","),
    run,
    onSelect: run,
  }

  try {
    api.keymap.registerLayer({
      commands: [cmd],
      bindings: KEYS.map((key) => ({ key, cmd: cmd.name })),
    } as any)
    log(rootDir, "keymap-ok", { keys: KEYS })
  } catch (err) {
    log(rootDir, "keymap-failed", { err: String(err) })
    try {
      api.keymap.registerLayer({ commands: [cmd] } as any)
    } catch (err2) {
      log(rootDir, "keymap-failed-nobind", { err: String(err2) })
    }
  }

  try {
    api.command?.register?.(() => [cmd as any])
  } catch (err) {
    log(rootDir, "command-failed", { err: String(err) })
  }

  try {
    api.slots.register({
      id: ID,
      order: 310,
      slots: {
        session_prompt_right(ctx: any, data: any) {
          const slot = data && typeof data === "object" ? data : {}
          return (
            <SteerButton
              api={api}
              sessionId={slot.session_id}
              theme={ctx?.theme?.current}
              onRun={run}
            />
          )
        },
      },
    } as any)
    log(rootDir, "slot-ok", {})
  } catch (err) {
    log(rootDir, "slot-failed", { err: String(err) })
  }

  log(rootDir, "loaded", {})
}

const plugin: TuiPluginModule & { id: string } = {
  id: ID,
  tui,
}

export default plugin
