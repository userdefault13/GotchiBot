/** @jsxImportSource @opentui/solid */
import { Show, createSignal, onCleanup } from "solid-js"
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { createConnection } from "node:net"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

const ID = "gotchi.local"

/**
 * /local — pick where this chat's prompts run: on this desk's CPU (Cursor, Codex,
 * Claude Code via scripts/desk-tools.mjs), on the Hub's VS Code Claude, or back on
 * the chat's own model. The prompt and reply stay in the chat session, so a Hub
 * chat stays synced. The choice is per chat session, in sessions/.local-mode.json;
 * plugins/gotchi-local-tools.js applies it to each message.
 *
 * While a chat has /local on, `local · <tool>` shows beside the prompt (left of
 * steer); yellow when the desk runner is not reachable (prompts then stay on the
 * chat's own model).
 *
 * When this TUI was opened by a desk's Hub attach, GOTCHIBOT_DESK_TOOLS_TOKEN is the
 * desk runner's token: it is saved (0600) so the Hub can call the desk's tools
 * through the attach's reverse tunnel.
 */

const ROOT = process.env.GOTCHIBOT_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
const STATE = join(ROOT, "sessions", ".local-mode.json")
const ORIGINS = join(ROOT, "sessions", ".local-origins.json")

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}
const PORT = Number(process.env.GOTCHIBOT_DESK_TOOLS_PORT) || 45690

const CHOICES = [
  { value: "off", title: "Off — the chat's own model", description: "Prompts go back to the chat's normal model" },
  { value: "claude", title: "Claude Code — this desk", description: "claude -p in the project, edits allowed" },
  { value: "codex", title: "Codex — this desk", description: "codex exec in the project, workspace-write" },
  { value: "cursor", title: "Cursor — this desk", description: "cursor-agent in the project, edits allowed" },
  { value: "hub-claude", title: "Claude — Hub VS Code (@claudemode)", description: "The Hub's VS Code Claude bridge" },
] as const

type State = { sessions?: Record<string, { tool: string; at: string }>; deskToken?: string }

function readState(): State {
  try {
    return JSON.parse(readFileSync(STATE, "utf8")) || {}
  } catch {
    return {}
  }
}

function writeState(st: State) {
  mkdirSync(dirname(STATE), { recursive: true })
  const tmp = `${STATE}.tmp`
  writeFileSync(tmp, JSON.stringify(st, null, 2), { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, STATE)
}

function deskUp(timeoutMs = 600): Promise<boolean> {
  return new Promise((ok) => {
    const s = createConnection({ host: "127.0.0.1", port: PORT })
    const t = setTimeout(() => {
      s.destroy()
      ok(false)
    }, timeoutMs)
    s.on("connect", () => {
      clearTimeout(t)
      s.end()
      ok(true)
    })
    s.on("error", () => {
      clearTimeout(t)
      ok(false)
    })
  })
}

const SHORT: Record<string, string> = { claude: "claude", codex: "codex", cursor: "cursor", "hub-claude": "hub claude" }

/** `local · codex` beside the prompt while this chat has /local on. */
const LocalBadge = (props: { sessionId?: string; theme: any }) => {
  const read = () => (props.sessionId ? readState().sessions?.[props.sessionId]?.tool || "" : "")
  const [tool, setTool] = createSignal(read())
  const [reachable, setReachable] = createSignal(true)
  const refresh = async () => {
    const t = read()
    setTool(t)
    setReachable(!t || t === "hub-claude" ? true : await deskUp(400))
  }
  void refresh()
  const timer = setInterval(() => void refresh(), 1500)
  onCleanup(() => clearInterval(timer))
  const color = () => (reachable() ? props.theme?.accent ?? props.theme?.primary : props.theme?.warning)
  return (
    <Show when={tool()}>
      <box flexDirection="row" paddingLeft={1}>
        <text fg={color()}>● local</text>
        <text fg={props.theme?.textMuted}> · {SHORT[tool()] || tool()}{reachable() ? "" : " (desk offline)"}</text>
      </box>
    </Show>
  )
}

function currentSession(api: any): string | null {
  const cur = api?.route?.current
  return cur?.name === "session" ? cur.params?.sessionID || null : null
}

const tui: TuiPlugin = async (api: any) => {
  // A desk attaching to the Hub hands over its runner token for the reverse tunnel.
  const handed = String(process.env.GOTCHIBOT_DESK_TOOLS_TOKEN || "").trim()
  if (handed) {
    try {
      const st = readState()
      if (st.deskToken !== handed) writeState({ ...st, deskToken: handed })
    } catch {
      /* /local still works for hub-claude */
    }
  }

  const toast = (variant: "info" | "success" | "warning" | "error", message: string) => {
    try {
      api.ui?.toast?.({ variant, title: "/local", message, duration: 5000 })
    } catch {
      /* ignore */
    }
  }

  /**
   * Off. The plugin already sends prompts to the chat's own model, but the footer
   * shows the window's model, which OpenCode copied from the chat's last message
   * (a /local one) and which no plugin API can set. So when that is likely, open
   * OpenCode's model picker and name the model to pick: one Enter and it is right.
   */
  const offToFooter = (sid: string) => {
    const msgs: any[] = (() => {
      try {
        return [...(api.state?.session?.messages?.(sid) || [])]
      } catch {
        return []
      }
    })()
    const users = msgs.map((m) => m?.info || m).filter((i) => i?.role === "user" && i?.model)
    const isLocal = (m: any) => m?.providerID === "desk" || m?.providerID === "claudemode"
    const stuck = users.length ? isLocal(users[users.length - 1].model) : false
    const origin = readJson(ORIGINS)?.[sid] || [...users].reverse().find((u) => !isLocal(u.model))?.model || configModel()
    const name = modelName(origin)
    if (!stuck) return toast("info", `Off — prompts go back to ${name}`)
    toast("info", `Off — pick ${name} so the footer matches (prompts already go there)`)
    // After the /local dialog has closed, or the picker opens underneath it.
    setTimeout(() => {
      try {
        api.keymap?.dispatchCommand?.("model.list")
      } catch {
        try {
          api.command?.trigger?.("model.list")
        } catch {
          /* the toast still says what to pick */
        }
      }
    }, 120)
  }

  const modelName = (m: any) => {
    if (!m?.providerID || !m?.modelID) return "the chat's own model"
    try {
      const p = (api.state?.provider || []).find((x: any) => x.id === m.providerID)
      const model = p?.models?.[m.modelID]
      if (model?.name) return `${model.name} · ${p.name || p.id}`
    } catch {
      /* fall through */
    }
    return `${m.providerID}/${m.modelID}`
  }

  const configModel = () => {
    const ref = String(api.state?.config?.model || "")
    const i = ref.indexOf("/")
    return i > 0 ? { providerID: ref.slice(0, i), modelID: ref.slice(i + 1) } : null
  }

  const apply = async (sid: string, value: string) => {
    const st = readState()
    const sessions = { ...(st.sessions || {}) }
    if (value === "off") delete sessions[sid]
    else sessions[sid] = { tool: value, at: new Date().toISOString() }
    writeState({ ...st, sessions })
    if (value === "off") return offToFooter(sid)
    const choice = CHOICES.find((c) => c.value === value)
    if (value === "hub-claude") return toast("success", `${choice?.title} — replies stay in this chat`)
    if (await deskUp()) toast("success", `${choice?.title} — runs on the desk's CPU, replies stay in this chat`)
    else toast("warning", `${choice?.title} is set, but the desk runner is not reachable here — prompts stay on the chat's model until the desk attaches (gotchibot desk-tools ensure)`)
  }

  const open = () => {
    const sid = currentSession(api)
    if (!sid) return toast("warning", "Open a chat first — /local is per chat")
    const current = readState().sessions?.[sid]?.tool || "off"
    api.ui.dialog.replace(() =>
      api.ui.DialogSelect({
        title: "/local — where should this chat's prompts run?",
        current,
        options: CHOICES.map((c) => ({ title: c.title, value: c.value, description: c.description })),
        onSelect: (option: any) => {
          api.ui.dialog.clear()
          void apply(sid, String(option?.value || "off"))
        },
      }),
    )
  }

  try {
    api.slots.register({
      id: ID,
      order: 300,
      slots: {
        session_prompt_right(ctx: any, data: any) {
          const slot = data && typeof data === "object" ? data : {}
          return <LocalBadge sessionId={slot.session_id} theme={ctx?.theme?.current} />
        },
      },
    } as any)
  } catch {
    /* the picker still works without the badge */
  }

  const cmd = {
    title: "Local tools (/local)",
    value: "gotchi.local",
    description: "Run this chat's prompts with Cursor, Codex or Claude on this desk",
    category: "Gotchi",
    namespace: "palette" as const,
    slashName: "local",
    slash: { name: "local" },
    run: () => open(),
    onSelect: () => open(),
  }
  try {
    api.keymap?.registerLayer?.({ commands: [cmd] })
  } catch {
    /* fall through to the legacy API */
  }
  try {
    api.command?.register?.(() => [cmd])
  } catch {
    /* ignore */
  }
}

const plugin: TuiPluginModule & { id: string } = { id: ID, tui }
export default plugin
