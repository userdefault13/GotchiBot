/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { Show, createMemo, createSignal, onCleanup } from "solid-js"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

const ID = "gotchi.logo"
const COMPACT = "GotchiCode"
const MIN_WIDTH = 48

const DEFAULT_ART = [
  " ▄▄▄  ▄▄   ▄▄▄   ▄▄▄ ▄  ▄  ▄  ▄███▄   ▄▄▄  ▄▄   ▄▄█  ▄▄ ",
  "█▒▄▄ █▒▒█  ▒█▒  █▒▒▒ █▄▄█  █▒ █▄█▄█  █▒▒▒ █▒▒█ █▒▒█ █▄▄█",
  "▀▄▄█ ▀▄▄▀   █   ▀▄▄▄ █▒▒█  █▒ █▀█▀█  ▀▄▄▄ ▀▄▄▀ ▀▄▄▀ ▀▄▄▄",
]

function loadArt(root: string): string[] {
  const path = resolve(root, "assets/gotchi-logo.ascii")
  try {
    if (!existsSync(path)) return DEFAULT_ART
    const lines = readFileSync(path, "utf8")
      .replace(/\r\n/g, "\n")
      .replace(/\s+$/g, "")
      .split("\n")
      .filter((line, i, arr) => !(i === arr.length - 1 && line === ""))
    return lines.length ? lines : DEFAULT_ART
  } catch {
    return DEFAULT_ART
  }
}

function sessionEmpty(api: any, sessionId?: string): boolean {
  if (!sessionId) return false
  try {
    const msgs = api?.state?.session?.messages?.(sessionId)
    if (msgs == null) return true
    return !Array.isArray(msgs) || msgs.length === 0
  } catch {
    return true
  }
}

const Logo = (props: { theme: TuiThemeCurrent; art: string[] }) => {
  const dim = useTerminalDimensions()
  const lines = createMemo(() => {
    let term: { width?: number; height?: number } = { width: 80, height: 24 }
    try {
      term = dim?.() || term
    } catch {
      /* keep defaults */
    }
    const width = Number(term.width) || 0
    const height = Number(term.height) || 0
    if (width >= MIN_WIDTH && height >= props.art.length + 6) return props.art
    return [COMPACT]
  })
  const fg = props.theme.primary ?? props.theme.accent

  return (
    <box width="100%" flexDirection="column" alignItems="center" justifyContent="center">
      {lines().map((line) => (
        <text fg={fg}>{line}</text>
      ))}
    </box>
  )
}

const SessionPromptWithLogo = (props: {
  api: any
  theme: TuiThemeCurrent
  art: string[]
  sessionId?: string
  visible?: boolean
  disabled?: boolean
  onSubmit?: () => void
  promptRef?: (ref: unknown) => void
}) => {
  const [rev, setRev] = createSignal(0)
  const bump = () => setRev((n) => n + 1)
  try {
    const offUpdated = props.api.event.on("message.updated", bump)
    const offStatus = props.api.event.on("session.status", bump)
    onCleanup(() => {
      try {
        offUpdated?.()
      } catch {
        /* ignore */
      }
      try {
        offStatus?.()
      } catch {
        /* ignore */
      }
    })
  } catch {
    /* events optional */
  }

  const empty = createMemo(() => {
    rev()
    return sessionEmpty(props.api, props.sessionId)
  })

  const Prompt = props.api.ui.Prompt

  // session_prompt is mode:replace — host drops the default prompt unless we paint it.
  return (
    <box flexDirection="column" width="100%">
      <Show when={empty()}>
        <box
          width="100%"
          paddingBottom={1}
          paddingTop={1}
          alignItems="center"
          justifyContent="center"
        >
          <Logo theme={props.theme} art={props.art} />
        </box>
      </Show>
      <Prompt
        sessionID={props.sessionId}
        visible={props.visible}
        disabled={props.disabled}
        onSubmit={props.onSubmit}
        ref={props.promptRef}
      />
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  const root =
    api.state?.path?.directory ||
    api.state?.path?.worktree ||
    process.env.GOTCHIBOT_ROOT ||
    process.cwd()
  const art = loadArt(root)

  api.slots.register({
    id: ID,
    order: 300,
    slots: {
      home_logo(ctx) {
        return <Logo theme={ctx.theme.current} art={art} />
      },
      // /new lands on session, not home. Replace must re-render Prompt or input dies.
      session_prompt(ctx: any, data: any) {
        const slot = data && typeof data === "object" ? data : {}
        return (
          <SessionPromptWithLogo
            api={api}
            theme={ctx.theme.current}
            art={art}
            sessionId={slot.session_id}
            visible={slot.visible}
            disabled={slot.disabled}
            onSubmit={slot.on_submit}
            promptRef={slot.ref}
          />
        )
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: ID,
  tui,
}

export default plugin
