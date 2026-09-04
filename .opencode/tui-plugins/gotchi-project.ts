import { spawnSync } from "node:child_process"
import { readFileSync, mkdirSync, appendFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

const ID = "gotchi.project"

/**
 * /project — Sandbox (and desk) modal for unsupervised project intake questions.
 * Not an OpenCode primary agent. Policy: config/project-policy.json
 */

type FieldOption = { value: string; title?: string; description?: string }

type Field = {
  id: string
  prompt: string
  required?: boolean
  default?: string
  hint?: string
  options?: FieldOption[]
}

type Policy = { fields: Field[]; rules?: Record<string, unknown> }

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
      join(dir, "gotchi-project-ui.log"),
      `${JSON.stringify({ t: new Date().toISOString(), event, ...extra })}\n`,
    )
  } catch {
    /* ignore */
  }
}

function runIntake(root: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [join(root, "scripts", "project-intake.mjs"), ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 25_000,
    env: { ...process.env, GOTCHIBOT_ROOT: root },
  })
  return {
    status: r.status ?? 1,
    stdout: String(r.stdout || ""),
    stderr: String(r.stderr || ""),
  }
}

function loadPolicy(root: string): Policy {
  const path = join(root, "config", "project-policy.json")
  return JSON.parse(readFileSync(path, "utf8"))
}

function loadCurrent(root: string): { id?: string; fields?: Record<string, string> } | null {
  try {
    const cur = join(root, "sessions", ".project-current")
    if (!existsSync(cur)) return null
    const id = readFileSync(cur, "utf8").trim()
    if (!id) return null
    const file = join(root, "sessions", "projects", `${id}.json`)
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

function ensureDraft(root: string) {
  if (loadCurrent(root)) return
  runIntake(root, ["new"])
}

const tui: TuiPlugin = async (api) => {
  const root = rootDirOf(api)

  const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") => {
    try {
      api.ui.toast({ message, variant, duration: 4000 })
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

  const askField = (field: Field, current: string, onDone: () => void) => {
    let proceeded = false
    const finish = (value: string) => {
      if (proceeded) return
      proceeded = true
      clearDialog()
      const v = String(value ?? "").trim()
      if (v) {
        const r = runIntake(root, ["set", field.id, v])
        if (r.status === 0) {
          const note =
            field.id === "model" && /claude/i.test(v)
              ? " · Claude CLI owns project; subagent big-pickle/Zen"
              : ""
          toast(`${field.id} → ${v.slice(0, 40)}${note}`, "success")
        } else toast(`set ${field.id} failed`, "error")
        log(root, "set", { field: field.id, ok: r.status === 0, value: v.slice(0, 80) })
      }
      onDone()
    }

    // Fields with options (e.g. model) → pick list, not free text.
    if (Array.isArray(field.options) && field.options.length) {
      api.ui.dialog.replace(
        () =>
          api.ui.DialogSelect({
            title: field.required ? `Project · ${field.id} *` : `Project · ${field.id}`,
            placeholder: field.prompt,
            current: current || field.default,
            options: field.options!.map((o) => ({
              title: o.title || o.value,
              value: o.value,
              description: o.description,
            })),
            onSelect: (option: any) => finish(String(option?.value ?? "")),
          }),
        () => {
          if (!proceeded) {
            proceeded = true
            onDone()
          }
        },
      )
      return
    }

    api.ui.dialog.replace(
      () =>
        api.ui.DialogPrompt({
          title: field.required ? `Project · ${field.id} *` : `Project · ${field.id}`,
          placeholder: field.prompt,
          value: current || field.default || "",
          onConfirm: (value: string) => finish(value),
          onCancel: () => {
            if (proceeded) return
            proceeded = true
            clearDialog()
            onDone()
          },
        }),
      () => {
        if (!proceeded) {
          proceeded = true
          onDone()
        }
      },
    )
  }

  const walkMissing = (fields: Field[], onDone: () => void) => {
    ensureDraft(root)
    const project = loadCurrent(root)
    const next = fields.find((f) => {
      if (!f.required) return false
      return !String(project?.fields?.[f.id] ?? "").trim()
    })
    if (!next) {
      toast("Required fields filled — /project → Check ready", "success")
      onDone()
      return
    }
    const cur = String(project?.fields?.[next.id] ?? "")
    askField(next, cur, () => walkMissing(fields, onDone))
  }

  const openMenu = () => {
    ensureDraft(root)
    let policy: Policy
    try {
      policy = loadPolicy(root)
    } catch (err) {
      toast(`project policy missing: ${String(err).slice(0, 80)}`, "error")
      return
    }
    const project = loadCurrent(root)
    const fields = policy.fields || []
    const options = [
      {
        title: "Fill missing (walk questions)",
        value: "__walk__",
        description: "Prompt each required ○ field",
      },
      {
        title: "New intake",
        value: "__new__",
        description: "Fresh draft — previous stays on disk",
      },
      {
        title: "Check ready",
        value: "__ready__",
        description: "Wallet gate + required fields (never auto-spawn)",
      },
      ...fields.map((f) => {
        const v = String(project?.fields?.[f.id] ?? "").trim()
        const mark = v ? "✓" : f.required ? "○" : "·"
        return {
          title: `${mark} ${f.id}`,
          value: f.id,
          description: v ? v.slice(0, 80) : f.prompt,
        }
      }),
    ]

    let proceeded = false
    const finish = (value: string) => {
      if (proceeded) return
      proceeded = true
      clearDialog()
      if (!value || value === "__cancel__") return
      if (value === "__new__") {
        runIntake(root, ["new"])
        toast("New project draft", "success")
        openMenu()
        return
      }
      if (value === "__ready__") {
        const r = runIntake(root, ["ready"])
        const msg = (r.stdout || r.stderr || "").trim().split("\n").slice(0, 3).join(" · ")
        toast(r.status === 0 ? `Ready — confirm before spawn` : msg.slice(0, 160) || "Not ready", r.status === 0 ? "success" : "warning")
        log(root, "ready", { status: r.status })
        if (r.status !== 0) openMenu()
        return
      }
      if (value === "__walk__") {
        walkMissing(fields, () => openMenu())
        return
      }
      const field = fields.find((f) => f.id === value)
      if (!field) return
      const cur = String(project?.fields?.[field.id] ?? "")
      askField(field, cur, () => openMenu())
    }

    api.ui.dialog.replace(
      () =>
        api.ui.DialogSelect({
          title: `Project intake${project?.id ? ` · ${project.id}` : ""}`,
          placeholder: "Pick a question…",
          options,
          onSelect: (option: any) => finish(String(option?.value ?? "")),
        }),
      () => {
        if (!proceeded) proceeded = true
      },
    )
  }

  try {
    api.keymap.registerLayer({
      commands: [
        {
          name: "gotchi.project",
          title: "Project intake",
          category: "Gotchi",
          namespace: "palette",
          slashName: "project",
          run: () => {
            log(root, "open", {})
            openMenu()
          },
        },
      ],
    })
  } catch (err) {
    log(root, "keymap-failed", { err: String(err) })
  }

  // Keep CLI path warm (no UI).
  log(root, "loaded", {})
}

const plugin: TuiPluginModule & { id: string } = {
  id: ID,
  tui,
}

export default plugin
