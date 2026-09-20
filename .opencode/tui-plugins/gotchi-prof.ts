import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"

const ID = "gotchi.prof"

function toast(
  api: TuiPluginApi,
  message: string,
  variant: "info" | "success" | "warning" | "error" = "info",
) {
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
    (api as any).path?.directory ||
    (api as any).path?.worktree
  if (typeof fromApi === "string" && fromApi && existsSync(join(fromApi, "scripts"))) return fromApi
  const fromEnv = process.env.GOTCHIBOT_ROOT?.trim() || ""
  if (fromEnv && existsSync(join(fromEnv, "scripts"))) return fromEnv
  if (existsSync(join(process.cwd(), "scripts"))) return process.cwd()
  return process.cwd()
}

type TocEntry = {
  id: string
  title: string
  summary?: string
  source?: string
  tags?: string[]
  version?: string
}

function readJson(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

function loadToc(rootDir: string): TocEntry[] {
  const byId = new Map<string, TocEntry>()
  const market = join(rootDir, "templates", "marketplace")
  const packsDir = join(market, "packs")
  const catalogPath = join(market, "catalog.json")
  const playbooksPath = join(rootDir, "config", "agent-role-playbooks.json")

  const catalog = readJson(catalogPath)
  if (catalog?.packs && Array.isArray(catalog.packs)) {
    for (const p of catalog.packs) {
      const id = String(p.id || p.roleId || "").trim()
      if (!id) continue
      byId.set(id, {
        id,
        title: String(p.title || id),
        summary: String(p.summary || ""),
        version: p.version ? String(p.version) : undefined,
        tags: Array.isArray(p.tags) ? p.tags.map(String) : undefined,
        source: "catalog",
      })
    }
  }

  if (existsSync(packsDir)) {
    for (const ent of readdirSync(packsDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      const pack = readJson(join(packsDir, ent.name, "pack.json")) || {}
      const playbook = readJson(join(packsDir, ent.name, "playbook.json")) || {}
      const id = String(pack.id || pack.roleId || ent.name).trim()
      if (!id) continue
      const prev = byId.get(id)
      byId.set(id, {
        id,
        title: String(pack.title || playbook.title || prev?.title || id),
        summary: String(pack.summary || playbook.summary || prev?.summary || ""),
        version: pack.version ? String(pack.version) : prev?.version,
        tags: Array.isArray(pack.tags) ? pack.tags.map(String) : prev?.tags,
        source: prev ? `${prev.source}+pack` : "pack",
      })
    }
  }

  const pb = readJson(playbooksPath)
  if (pb && typeof pb === "object") {
    for (const [key, val] of Object.entries(pb as Record<string, any>)) {
      if (!val || typeof val !== "object") continue
      const id = String(key).trim()
      if (!id) continue
      if (byId.has(id)) {
        const cur = byId.get(id)!
        if (!cur.summary && val.summary) cur.summary = String(val.summary)
        if (cur.title === id && val.title) cur.title = String(val.title)
        cur.source = `${cur.source}+playbook`
        continue
      }
      byId.set(id, {
        id,
        title: String(val.title || id),
        summary: String(val.summary || ""),
        source: "playbook",
      })
    }
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

function isScrollMouse(evt: any): boolean {
  const btn = evt?.button ?? evt?.mouseButton ?? evt?.event?.button
  const type = String(evt?.type || evt?.kind || "").toLowerCase()
  if (type.includes("wheel") || type.includes("scroll")) return true
  const n = Number(btn)
  return n === 4 || n === 5 || n === 64 || n === 65
}

function scrollDir(evt: any): -1 | 1 {
  const btn = Number(evt?.button ?? evt?.mouseButton ?? evt?.event?.button)
  const type = String(evt?.type || "").toLowerCase()
  if (btn === 4 || btn === 64 || type.includes("up")) return -1
  if (btn === 5 || btn === 65 || type.includes("down")) return 1
  const dy = Number(evt?.dy ?? evt?.deltaY ?? evt?.scrollY)
  if (Number.isFinite(dy) && dy !== 0) return dy < 0 ? -1 : 1
  return 1
}

/**
 * /prof modal — keep focus in DialogSelect.
 * Bug: mouse-wheel (and some page-scroll keybinds) leaked into chat history.
 * Fix: push mode, xlarge dialog, consume wheel + page-scroll keys; map wheel to list move.
 */
function openProfModal(api: TuiPluginApi, rootDir: string) {
  const packs = loadToc(rootDir)
  if (!packs.length) {
    toast(api, `No marketplace packs under ${rootDir}`, "warning")
    return
  }

  let proceeded = false
  let selectedIdx = 0
  const cleanups: Array<() => void> = []

  const cleanup = () => {
    for (const c of cleanups.splice(0)) {
      try {
        c()
      } catch {
        /* ignore */
      }
    }
  }

  try {
    const pop = api.mode.push("gotchi.prof")
    cleanups.push(() => {
      try {
        pop()
      } catch {
        /* ignore */
      }
    })
  } catch {
    /* ignore */
  }

  try {
    api.ui.dialog.setSize("xlarge")
  } catch {
    /* ignore */
  }

  const finish = (value: string) => {
    if (proceeded) return
    proceeded = true
    cleanup()
    try {
      api.ui.dialog.clear()
    } catch {
      /* ignore */
    }
    if (!value) return
    toast(
      api,
      `Pack ${value} — apply: ./scripts/gotchibot templates apply ${value} --hero <available> --yes`,
      "info",
    )
  }

  const show = () => {
    selectedIdx = Math.max(0, Math.min(selectedIdx, packs.length - 1))
    const current = packs[selectedIdx]?.id
    api.ui.dialog.replace(
      () =>
        api.ui.DialogSelect({
          title: `Prof. Link-Cube · ${packs.length} template(s)`,
          placeholder: "Filter packs… (wheel stays in list)",
          current,
          options: packs.map((p) => ({
            title: p.title || p.id,
            value: p.id,
            description: [p.summary, p.source ? `(${p.source})` : ""]
              .filter(Boolean)
              .join(" ")
              .slice(0, 160),
          })),
          onMove: (option: { value?: string }) => {
            const id = String(option?.value ?? "")
            const i = packs.findIndex((p) => p.id === id)
            if (i >= 0) selectedIdx = i
          },
          onSelect: (option: { value?: string }) => {
            finish(String(option?.value ?? ""))
          },
        }),
      () => {
        if (!proceeded) finish("")
      },
    )
  }

  const move = (delta: number) => {
    if (proceeded || !packs.length) return
    selectedIdx = Math.max(0, Math.min(packs.length - 1, selectedIdx + delta))
    show()
  }

  // Page-scroll only (not ↑↓ — DialogSelect owns those).
  try {
    const steal = api.keymap.registerLayer({
      commands: [
        {
          name: "gotchi.prof.pageup",
          title: "Prof page up",
          category: "Gotchi",
          namespace: "palette",
          hidden: true,
          run: () => move(-8),
        },
        {
          name: "gotchi.prof.pagedown",
          title: "Prof page down",
          category: "Gotchi",
          namespace: "palette",
          hidden: true,
          run: () => move(8),
        },
      ],
      bindings: [
        { key: "pageup", cmd: "gotchi.prof.pageup" },
        { key: "pagedown", cmd: "gotchi.prof.pagedown" },
        { key: "ctrl+b", cmd: "gotchi.prof.pageup" },
        { key: "ctrl+f", cmd: "gotchi.prof.pagedown" },
      ],
    } as any)
    if (typeof steal === "function") cleanups.push(steal)
  } catch {
    /* optional */
  }

  const r = api.renderer as any
  const onMouse = (evt: any) => {
    if (proceeded) return
    if (!isScrollMouse(evt)) return
    evt?.preventDefault?.()
    evt?.stopPropagation?.()
    evt?.stopImmediatePropagation?.()
    move(scrollDir(evt))
    return true
  }
  const rootNode = r?.root || r?.rootNode || r?.document
  if (rootNode && typeof rootNode.on === "function") {
    for (const ev of ["mouse", "mouse:down", "mousedown", "wheel", "scroll", "mouse:scroll", "mouse:wheel"]) {
      try {
        rootNode.on(ev, onMouse)
        cleanups.push(() => rootNode.off?.(ev, onMouse))
      } catch {
        /* ignore */
      }
    }
  }
  if (typeof r?.prependInputHandler === "function") {
    const onSeq = (s: any) => {
      if (proceeded) return
      const str = typeof s === "string" ? s : Buffer.from(s || "").toString("binary")
      // SGR wheel: ESC [ < 64|65 ; col ; row M/m
      if (/\x1b\[<64;/.test(str)) {
        move(-1)
        return true
      }
      if (/\x1b\[<65;/.test(str)) {
        move(1)
        return true
      }
      // X10 wheel: ESC [ M + button byte 0x60/0x61
      if (/\x1b\[M[\x60\x61]/.test(str)) {
        move(str.includes("\x60") ? -1 : 1)
        return true
      }
    }
    r.prependInputHandler(onSeq)
    cleanups.push(() => r.removeInputHandler?.(onSeq))
  }

  show()
}

const tui: TuiPlugin = async (api) => {
  const rootDir = resolveRoot(api)
  try {
    api.keymap.registerLayer({
      commands: [
        {
          name: "gotchi.prof",
          title: "Prof templates TOC",
          category: "Gotchi",
          namespace: "palette",
          slashName: "prof",
          run: () => openProfModal(api, rootDir),
        },
      ],
    })
  } catch (err) {
    toast(api, `Prof plugin keymap failed: ${String(err)}`, "error")
  }
}

const plugin: TuiPluginModule & { id: string } = {
  id: ID,
  tui,
}

export default plugin
