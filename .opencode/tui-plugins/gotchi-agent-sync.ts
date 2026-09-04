import { spawn, spawnSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

const ID = "gotchi.agent-sync"
const MODES = new Set(["gotchi", "sandbox", "verse", "plan", "build", "ask"])

/**
 * Persist Tab agent cycle to sessions/.agent-mode.json.
 * /switch → cAavegotchi roster modal (@LINK, @WBTC, …) — not OpenCode Tab agents.
 * Tab agents stay on /agents.
 */

type RosterEntry = {
  index?: number
  kind?: string
  id?: string
  hero?: string
  status?: string
  collateral?: string
  bindType?: string
  hauntId?: number
  name?: string | null
}

function rootDirOf(api: any): string {
  return (
    api?.state?.path?.directory ||
    api?.state?.path?.worktree ||
    process.env.GOTCHIBOT_ROOT ||
    process.cwd()
  )
}

function log(root: string, event: string, extra: Record<string, unknown> = {}) {
  try {
    const dir = join(root, "sessions")
    mkdirSync(dir, { recursive: true })
    appendFileSync(
      join(dir, "gotchi-agent-sync.log"),
      `${JSON.stringify({ t: new Date().toISOString(), event, ...extra })}\n`,
    )
  } catch {
    /* ignore */
  }
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
  spawn(nodeBin(), [join(root, "scripts", "agent-mode.mjs"), "set", agent], {
    cwd: root,
    detached: true,
    stdio: "ignore",
    env: { ...pathEnv(), GOTCHIBOT_ROOT: root },
  }).unref()
}

function liveUiAgent(api: any): string | null {
  const cands = [api?.state?.agent, api?.state?.session?.agent, api?.agent]
  for (const a of cands) {
    const s = String(a || "").trim()
    if (MODES.has(s)) return s
  }
  return null
}

function atTag(entry: RosterEntry): string {
  const coll = String(entry.collateral || "").trim().toUpperCase()
  if (coll) {
    if (coll === "WBTC" || coll === "BTC") return "@WBTC"
    if (coll === "WETH" || coll === "ETH") return "@WETH"
    if (coll === "MATIC" || coll === "WMATIC") return "@MATIC"
    return `@${coll}`
  }
  const id = String(entry.id || entry.hero || "")
  if (id === "owned-954") return "@GOTCHI"
  const m = id.match(/starter-([a-z0-9]+)-/i)
  if (m) return `@${m[1].toUpperCase()}`
  return `@${id.slice(0, 12) || "HERO"}`
}

function nodeBin(): string {
  const home = process.env.HOME || ""
  const cands = [
    process.env.GOTCHIBOT_NODE,
    process.env.NVM_BIN ? join(process.env.NVM_BIN, "node") : "",
    join(home, ".nvm/versions/node/v22.9.0/bin/node"),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "node",
  ].filter(Boolean)
  for (const c of cands) {
    if (c === "node") return c
    try {
      if (existsSync(c)) return c
    } catch {
      /* ignore */
    }
  }
  return "node"
}

function pathEnv(): NodeJS.ProcessEnv {
  const home = process.env.HOME || ""
  const pathParts = [
    process.env.NVM_BIN,
    join(home, ".nvm/versions/node/v22.9.0/bin"),
    join(home, ".local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    process.env.PATH || "",
  ].filter(Boolean)
  return { ...process.env, PATH: pathParts.join(":") }
}

function parseJson(text: string): any {
  const s = String(text || "")
  const start = s.indexOf("{")
  if (start < 0) throw new Error("no JSON")
  return JSON.parse(s.slice(start))
}

function loadHeroes(root: string): RosterEntry[] {
  const bin = nodeBin()
  const r = spawnSync(bin, [join(root, "scripts", "agent-focus.mjs"), "list", "--json"], {
    cwd: root,
    encoding: "utf8",
    timeout: 45_000,
    env: { ...pathEnv(), GOTCHIBOT_ROOT: root },
  })
  try {
    const j = parseJson(r.stdout || "")
    const heroes = (j.numbered || []).filter((e: RosterEntry) => e.kind === "hero" && (e.id || e.hero))
    if (!heroes.length) {
      log(root, "roster-empty-raw", {
        status: r.status,
        bin,
        out: String(r.stdout || "").slice(0, 200),
        err: String(r.stderr || "").slice(0, 200),
      })
    }
    return heroes
  } catch (err) {
    log(root, "roster-parse-fail", {
      status: r.status,
      bin,
      err: String(err),
      out: String(r.stdout || "").slice(0, 200),
      stderr: String(r.stderr || "").slice(0, 200),
    })
    return []
  }
}

function runSwitch(root: string, id: string): { ok: boolean; message: string } {
  const bin = nodeBin()
  const r = spawnSync(bin, [join(root, "scripts", "agent-focus.mjs"), "switch", id], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...pathEnv(), GOTCHIBOT_ROOT: root },
  })
  const out = `${r.stdout || ""}\n${r.stderr || ""}`.trim()
  const line =
    out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-2)
      .join(" · ") || (r.status === 0 ? `switched → ${id}` : `switch failed`)
  return { ok: r.status === 0, message: line.slice(0, 180) }
}

const tui: TuiPlugin = async (api) => {
  const root = rootDirOf(api)
  let lastSeen = bootAgent(root)

  const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") => {
    try {
      api.ui.toast({ message, variant, duration: 4500 })
    } catch {
      /* ignore */
    }
  }

  const clearDialog = () => {
    try {
      api.ui.dialog.clear()
    } catch {
      /* ignore */
    }
  }

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

  const openRosterModal = () => {
    toast("Loading roster…", "info")
    const heroes = loadHeroes(root)
    if (!heroes.length) {
      toast("No cAavegotchis — connect / identity bind", "error")
      log(root, "roster-empty", {})
      return
    }

    // Count tags so duplicate @DAI rows stay distinguishable.
    const tagCount = new Map<string, number>()
    for (const h of heroes) {
      const t = atTag(h)
      tagCount.set(t, (tagCount.get(t) || 0) + 1)
    }
    const tagSeen = new Map<string, number>()

    const options = heroes.map((h) => {
      const id = String(h.id || h.hero)
      const tag = atTag(h)
      const n = (tagSeen.get(tag) || 0) + 1
      tagSeen.set(tag, n)
      const multi = (tagCount.get(tag) || 0) > 1
      const title = multi ? `${tag} · ${id}` : tag
      const bits = [
        h.status || "",
        h.bindType || "",
        h.hauntId != null ? `H${h.hauntId}` : "",
        id,
      ].filter(Boolean)
      return {
        title,
        value: id,
        description: bits.join(" · "),
      }
    })

    let proceeded = false
    const finish = (value: string) => {
      if (proceeded) return
      proceeded = true
      clearDialog()
      if (!value) return
      const r = runSwitch(root, value)
      toast(r.message, r.ok ? "success" : "error")
      log(root, "switched", { id: value, ok: r.ok })
      // Refresh avatar pane
      try {
        spawn(join(root, "scripts", "poke-avatar.sh"), [], {
          cwd: root,
          detached: true,
          stdio: "ignore",
        }).unref()
      } catch {
        /* ignore */
      }
    }

    api.ui.dialog.replace(
      () =>
        api.ui.DialogSelect({
          title: "Switch gotchi",
          placeholder: "Search @LINK @WBTC …",
          options,
          onSelect: (option: any) => finish(String(option?.value ?? "")),
        }),
      () => {
        if (!proceeded) proceeded = true
      },
    )
    log(root, "roster-open", { count: heroes.length })
  }

  const switchCmd = {
    name: "gotchi.agent.switch",
    value: "gotchi.agent.switch",
    title: "Switch gotchi",
    description: "Roster modal — @LINK @WBTC … (avatar + SUB chat)",
    category: "Gotchi",
    namespace: "palette" as const,
    slashName: "switch",
    slash: { name: "switch", aliases: ["sw"] },
    run: () => openRosterModal(),
    onSelect: () => openRosterModal(),
  }

  try {
    api.keymap.registerLayer({ commands: [switchCmd] })
    log(root, "switch-keymap-ok", {})
  } catch (err) {
    log(root, "switch-keymap-failed", { err: String(err) })
  }

  try {
    api.command?.register?.(() => [switchCmd])
    log(root, "switch-command-ok", {})
  } catch (err) {
    log(root, "switch-command-failed", { err: String(err) })
  }

  log(root, "loaded", {})
}

const plugin: TuiPluginModule & { id: string } = {
  id: ID,
  tui,
}

export default plugin
