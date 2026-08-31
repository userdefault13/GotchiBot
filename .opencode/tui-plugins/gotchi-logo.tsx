/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo } from "solid-js"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

const ID = "gotchi.logo"
const COMPACT = "GotchiBot"
const MIN_WIDTH = 56

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

const Logo = (props: { theme: TuiThemeCurrent; art: string[] }) => {
  const dim = useTerminalDimensions()
  const lines = createMemo(() => {
    const term = dim()
    if (term.width >= MIN_WIDTH && term.height >= props.art.length + 6) return props.art
    return [COMPACT]
  })
  const fg = props.theme.primary ?? props.theme.accent

  return (
    <box flexDirection="column" alignItems="center">
      {lines().map((line) => (
        <text fg={fg}>{line}</text>
      ))}
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
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: ID,
  tui,
}

export default plugin
