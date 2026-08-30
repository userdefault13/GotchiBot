import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

const ID = "gotchi.sidebar-hide"

/**
 * OpenCode shows the session-info sidebar whenever the chat pane is >120 cols
 * and KV `sidebar` is "auto" (the default). That steals chat width in tmux.
 * Force KV to "hide" on load/resume so it stays closed unless the user toggles
 * it (Ctrl+Shift+G or Ctrl+X then B).
 */
const tui: TuiPlugin = async (api) => {
  const hide = () => {
    try {
      api.kv?.set("sidebar", "hide")
      return true
    } catch {
      return false
    }
  }

  hide()
  if (!api.kv?.ready) {
    const started = Date.now()
    const timer = setInterval(() => {
      if (hide() || Date.now() - started > 4000) clearInterval(timer)
    }, 200)
  }
}

const plugin: TuiPluginModule & { id: string } = {
  id: ID,
  tui,
}

export default plugin
