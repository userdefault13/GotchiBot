import { spawn } from "node:child_process"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"

const ID = "gotchi.spawn"
const ORCH_ID = "owned-954"
const REQUEST_NAME = ".spawn-request.json"
const LOG_NAME = ".spawn-ui.log"
const LOADED_NAME = ".spawn-ui-loaded.json"
const DEFAULT_TASK = "ready for next task"
const POLL_MS = 1000
const CMD_TIMEOUT_MS = 90_000

const STARTERS: Array<{ label: string; spirit: string; haunt: "H1" | "H2" }> = [
  { label: "maDAI (H1)", spirit: "dai", haunt: "H1" },
  { label: "maWETH (H1)", spirit: "weth", haunt: "H1" },
  { label: "maAAVE (H1)", spirit: "aave", haunt: "H1" },
  { label: "maLINK (H1)", spirit: "link", haunt: "H1" },
  { label: "maUSDT (H1)", spirit: "usdt", haunt: "H1" },
  { label: "maUSDC (H1)", spirit: "usdc", haunt: "H1" },
  { label: "maTUSD (H1)", spirit: "tusd", haunt: "H1" },
  { label: "maUNI (H1)", spirit: "uni", haunt: "H1" },
  { label: "maYFI (H1)", spirit: "yfi", haunt: "H1" },
  { label: "amDAI (H2)", spirit: "dai", haunt: "H2" },
  { label: "amWETH (H2)", spirit: "weth", haunt: "H2" },
  { label: "amAAVE (H2)", spirit: "aave", haunt: "H2" },
  { label: "amUSDT (H2)", spirit: "usdt", haunt: "H2" },
  { label: "amUSDC (H2)", spirit: "usdc", haunt: "H2" },
  { label: "amWBTC (H2)", spirit: "wbtc", haunt: "H2" },
  { label: "amWMATIC (H2)", spirit: "matic", haunt: "H2" },
]

type Hero = {
  id: string
  status: string
  agentTask?: string | null
  agentSessionId?: string | null
  name?: string | null
  bindType?: string | null
  sourceTokenId?: string | null
  desk?: string | null
  collateral?: string | null
}

type WalletGotchi = {
  tokenId: string
  name: string
  haunt?: string
  collateral?: string
}

type SpawnReq = {
  task: string
  heroId?: string
  collateral?: string
  at?: string
}

type CmdResult = { status: number; stdout: string; stderr: string }

function sessionsDir(rootDir: string) {
  return join(rootDir, "sessions")
}

function log(rootDir: string, msg: string, extra?: unknown) {
  try {
    const dir = sessionsDir(rootDir)
    mkdirSync(dir, { recursive: true })
    const line = `${new Date().toISOString()} ${msg}${extra ? " " + JSON.stringify(extra) : ""}\n`
    appendFileSync(join(dir, LOG_NAME), line)
  } catch {
    // ignore
  }
}

function markLoaded(rootDir: string) {
  try {
    const dir = sessionsDir(rootDir)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, LOADED_NAME),
      JSON.stringify(
        {
          id: ID,
          loadedAt: new Date().toISOString(),
          pid: process.pid,
          execPath: process.execPath,
        },
        null,
        2,
      ) + "\n",
    )
  } catch {
    // ignore
  }
}

function safeErr(stdout: string, stderr: string) {
  const raw = `${stderr || ""}\n${stdout || ""}`
    .split("\n")
    .filter((l) => !/token|secret|password|authorization|api[_-]?key|bearer|private[_-]?key/i.test(l))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim()
  return (raw || "command failed").slice(0, 240)
}

function toast(api: TuiPluginApi, message: string, variant: "info" | "success" | "warning" | "error" = "info") {
  try {
    api.ui.toast({ message, variant })
  } catch {
    // ignore
  }
}

function abraEnv(extra: Record<string, string> = {}) {
  const home = process.env.HOME || ""
  const pathParts = [
    process.env.NVM_BIN,
    join(home, ".nvm/versions/node/v22.9.0/bin"),
    join(home, ".local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    process.env.PATH || "",
  ].filter(Boolean)
  return { ...process.env, PATH: pathParts.join(":"), ...extra }
}

function runAbra(
  rootDir: string,
  args: string[],
  extraEnv: Record<string, string> = {},
  timeoutMs = CMD_TIMEOUT_MS,
): Promise<CmdResult> {
  return new Promise((resolve) => {
    const child = spawn("abra", ["run", "gotchibot", "--", ...args], {
      cwd: rootDir,
      env: abraEnv(extraEnv),
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    const done = (status: number) => {
      if (settled) return
      settled = true
      resolve({ status, stdout, stderr })
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM")
      } catch {}
      done(124)
    }, timeoutMs)
    child.stdout?.on("data", (b) => {
      stdout += String(b)
    })
    child.stderr?.on("data", (b) => {
      stderr += String(b)
    })
    child.on("error", (err) => {
      stderr += String((err as any)?.message || err)
      clearTimeout(timer)
      done(127)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      done(code ?? 1)
    })
  })
}

function parseJsonFromOutput(text: string): unknown {
  const s = String(text || "")
  const obj = s.indexOf("{")
  const arr = s.indexOf("[")
  let start = -1
  if (obj >= 0 && arr >= 0) start = Math.min(obj, arr)
  else start = Math.max(obj, arr)
  if (start < 0) throw new Error("no JSON in output")
  return JSON.parse(s.slice(start))
}

function lastLineId(stdout: string): string {
  const lines = String(stdout || "")
    .trim()
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const last = lines[lines.length - 1] || ""
  if (last && !last.startsWith("{") && !last.startsWith("[") && /^[a-zA-Z0-9._:-]+$/.test(last) && last.length < 80) {
    return last
  }
  try {
    const j = parseJsonFromOutput(stdout) as any
    const id = j?.heroId || j?.id || j?.cAavegotchi?.id
    if (id) return String(id)
  } catch {
    // ignore
  }
  return ""
}

function isOrch(id: string) {
  return String(id || "") === ORCH_ID
}

function heroStatus(row: any): string {
  return String(row?.status || row?.agentStatus || "").trim()
}

function asHero(row: any): Hero | null {
  const id = String(row?.id || row?.heroId || row?.hero || "").trim()
  if (!id) return null
  const owned = id.match(/^owned-(\d+)$/)
  return {
    id,
    status: heroStatus(row) || "?",
    agentTask: row?.agentTask || row?.task || null,
    agentSessionId: row?.agentSessionId || row?.sessionId || row?.session || null,
    name: row?.name || null,
    bindType: row?.bindType || null,
    sourceTokenId: row?.sourceTokenId != null ? String(row.sourceTokenId) : owned ? owned[1] : null,
    desk: row?.desk || row?.agentDesk || null,
    collateral:
      row?.collateral ||
      row?.collateralName ||
      row?.collateralAddress ||
      row?.collateralType ||
      null,
  }
}

function heroesFromRoster(data: unknown): Hero[] {
  const out: Hero[] = []
  const seen = new Set<string>()
  const push = (row: any) => {
    const h = asHero(row)
    if (!h || seen.has(h.id)) return
    seen.add(h.id)
    out.push(h)
  }
  if (Array.isArray(data)) {
    for (const row of data) {
      if (row && (row.kind === "hero" || row.agentStatus || row.heroId || !row.kind)) push(row)
    }
    return out
  }
  if (data && typeof data === "object") {
    const obj = data as any
    const lists = [obj.numbered, obj.heroes, obj.entries, obj.agents, obj.cAavegotchis]
    for (const list of lists) {
      if (!Array.isArray(list)) continue
      for (const row of list) {
        if (row?.kind && row.kind !== "hero") continue
        push(row)
      }
    }
  }
  return out
}

function assignmentDesc(h: Hero) {
  const bits = [
    h.status,
    h.agentTask,
    h.agentSessionId,
    h.desk,
    h.bindType && h.bindType !== "sub" ? h.bindType : "",
  ]
    .map((x) => String(x || "").trim())
    .filter(Boolean)
  return bits.join(" · ") || "no assignment"
}

function parseWalletGotchis(text: string): WalletGotchi[] {
  try {
    const data = parseJsonFromOutput(text) as any
    const list = Array.isArray(data) ? data : data?.gotchis || data?.aavegotchis || data?.wallet
    if (Array.isArray(list) && list.length) {
      return list
        .map((g: any) => ({
          tokenId: String(g.gotchiId ?? g.tokenId ?? g.id ?? "").replace(/^#/, ""),
          name: String(g.name || "").trim() || `#${g.gotchiId ?? g.tokenId ?? g.id}`,
          haunt: g.haunt ? String(g.haunt) : g.hauntId != null ? `haunt${g.hauntId}` : undefined,
          collateral: g.collateralName
            ? String(g.collateralName)
            : g.collateral && !String(g.collateral).startsWith("0x")
              ? String(g.collateral)
              : g.collateral
                ? String(g.collateral)
                : undefined,
        }))
        .filter((g: WalletGotchi) => g.tokenId)
    }
  } catch {
    // text format
  }
  const out: WalletGotchi[] = []
  for (const line of String(text || "").split("\n")) {
    const m = line.match(/^\s+#(\d+)\s+(.*?)\s+(haunt\S+)\s+(\S+)/i)
    if (m) {
      out.push({
        tokenId: m[1],
        name: m[2].trim() || `#${m[1]}`,
        haunt: m[3],
        collateral: m[4] === "—" ? undefined : m[4],
      })
      continue
    }
    const loose = line.match(/^\s+#(\d+)\s+(\S.*)$/)
    if (loose) {
      out.push({ tokenId: loose[1], name: loose[2].trim() || `#${loose[1]}` })
    }
  }
  return out
}

function cartridgeTokenIds(heroes: Hero[]) {
  const ids = new Set<string>()
  for (const h of heroes) {
    if (h.sourceTokenId) ids.add(String(h.sourceTokenId))
    const m = h.id.match(/^owned-(\d+)$/)
    if (m) ids.add(m[1])
  }
  return ids
}

function normCollateral(s: string | undefined) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
}

// Spirit ids for the 16 starters + common typos / haunt labels.
// yifi / yearn / maYFI → yfi; btc → wbtc.
const SPIRIT_ALIASES: Record<string, string> = {
  dai: "dai",
  madai: "dai",
  amdai: "dai",
  weth: "weth",
  maweth: "weth",
  amweth: "weth",
  eth: "weth",
  aave: "aave",
  maaave: "aave",
  amaave: "aave",
  link: "link",
  malink: "link",
  amlink: "link",
  usdt: "usdt",
  mausdt: "usdt",
  amusdt: "usdt",
  usdc: "usdc",
  mausdc: "usdc",
  amusdc: "usdc",
  tusd: "tusd",
  matusd: "tusd",
  amtusd: "tusd",
  uni: "uni",
  mauni: "uni",
  amuni: "uni",
  yfi: "yfi",
  mayfi: "yfi",
  amyfi: "yfi",
  yifi: "yfi",
  yearn: "yfi",
  wbtc: "wbtc",
  btc: "wbtc",
  amwbtc: "wbtc",
  mawbtc: "wbtc",
  bitcoin: "wbtc",
  matic: "matic",
  wmatic: "matic",
  amwmatic: "matic",
  mawmatic: "matic",
  polygon: "matic",
}

function canonicalSpirit(raw: string | undefined) {
  const n = normCollateral(raw)
  if (!n) return ""
  if (SPIRIT_ALIASES[n]) return SPIRIT_ALIASES[n]
  const stripped = n.replace(/^(ma|am)/, "")
  if (SPIRIT_ALIASES[stripped]) return SPIRIT_ALIASES[stripped]
  return n
}

function displaySpirit(filter: string) {
  return (canonicalSpirit(filter) || filter).toUpperCase()
}

function starterMatches(s: { label: string; spirit: string }, filter: string) {
  const spirit = canonicalSpirit(filter)
  if (!spirit) return false
  const label = normCollateral(s.label)
  return canonicalSpirit(s.spirit) === spirit || label.includes(spirit) || label.includes(normCollateral(filter))
}

function collateralMatches(gotchiCollateral: string | undefined, filter: string) {
  const spirit = canonicalSpirit(filter)
  if (!spirit) return false
  const c = normCollateral(gotchiCollateral)
  if (!c) return false
  if (canonicalSpirit(gotchiCollateral) === spirit) return true
  return c.includes(spirit) || c.includes(normCollateral(filter))
}

function heroCollateralMatches(h: Hero, filter: string) {
  if (!filter) return false
  if (collateralMatches(h.collateral || undefined, filter)) return true
  const spirit = canonicalSpirit(filter)
  const blob = normCollateral([h.id, h.name, h.desk, h.collateral].filter(Boolean).join(" "))
  if (!spirit || !blob) return false
  return blob.includes(spirit) || blob.includes(normCollateral(filter))
}

function walletTitle(g: WalletGotchi) {
  const name = String(g.name || "").trim()
  if (name && name !== `#${g.tokenId}`) return `${name} (#${g.tokenId})`
  return `#${g.tokenId}`
}

function heroTitle(h: Hero) {
  const name = String(h.name || "").trim()
  if (name && name !== h.id) return `${name} (${h.id})`
  return h.id
}

const tui: TuiPlugin = async (api) => {
  const rootDir = api.state?.path?.directory || api.state?.path?.worktree || process.cwd()
  markLoaded(rootDir)
  log(rootDir, "plugin-init", { version: (api as any).app?.version, cwd: rootDir })

  let flowBusy = false
  const unsubs: Array<() => void> = []

  const dismissStop = (why: string) => {
    log(rootDir, "dismiss", { why })
    flowBusy = false
  }

  const showSelect = (
    props: {
      title: string
      placeholder?: string
      skipFilter?: boolean
      options: Array<{ title: string; value: string; description?: string; disabled?: boolean }>
    },
    onPick: (value: string) => void,
    onDismiss?: () => void,
  ) => {
    let proceeded = false
    const finish = (value: string) => {
      if (proceeded) return
      proceeded = true
      try {
        api.ui.dialog.clear()
      } catch {}
      onPick(value)
    }
    api.ui.dialog.replace(
      () =>
        api.ui.DialogSelect({
          title: props.title,
          placeholder: props.placeholder,
          skipFilter: props.skipFilter === true,
          options: props.options.map((o) => ({
            title: o.title,
            value: o.value,
            description: o.description,
            disabled: o.disabled,
          })),
          onSelect: (option) => {
            finish(String((option as any)?.value ?? ""))
          },
        }),
      () => {
        if (!proceeded) {
          proceeded = true
          ;(onDismiss || (() => dismissStop(props.title)))()
        }
      },
    )
  }

  const showConfirm = (title: string, message: string, onYes: () => void, onNo?: () => void) => {
    let proceeded = false
    const yes = () => {
      if (proceeded) return
      proceeded = true
      try {
        api.ui.dialog.clear()
      } catch {}
      onYes()
    }
    const no = () => {
      if (proceeded) return
      proceeded = true
      try {
        api.ui.dialog.clear()
      } catch {}
      ;(onNo || (() => dismissStop(title)))()
    }
    const viaSelect = () => {
      showSelect(
        {
          title,
          skipFilter: true,
          options: [
            { title: "Confirm", value: "yes", description: message },
            { title: "Cancel", value: "no", description: "Do not proceed" },
          ],
        },
        (value) => {
          if (value === "yes") yes()
          else no()
        },
        no,
      )
    }
    try {
      if (typeof api.ui.DialogConfirm === "function") {
        api.ui.dialog.replace(
          () =>
            api.ui.DialogConfirm({
              title,
              message,
              onConfirm: yes,
              onCancel: no,
            }),
          no,
        )
        return
      }
    } catch {
      // fall through
    }
    viaSelect()
  }

  const loadHeroes = async (): Promise<Hero[] | null> => {
    const attempts: string[][] = [
      ["./scripts/agent-focus.mjs", "list", "--json"],
      ["node", "scripts/hero-agent-state.mjs", "get"],
      ["./scripts/gotchibot", "agents", "--json"],
    ]
    const errors: string[] = []
    for (const args of attempts) {
      const r = await runAbra(rootDir, args)
      if (r.status !== 0) {
        errors.push(`${args.join(" ")}: ${safeErr(r.stdout, r.stderr)}`)
        log(rootDir, "roster-fail", { cmd: args[0], status: r.status })
        continue
      }
      try {
        const data = parseJsonFromOutput(r.stdout)
        const heroes = heroesFromRoster(data)
        log(rootDir, "roster", { cmd: args[0], count: heroes.length })
        return heroes
      } catch (err) {
        errors.push(`${args.join(" ")}: bad JSON`)
        log(rootDir, "roster-parse-fail", { cmd: args[0], err: String(err) })
      }
    }
    toast(api, errors[0] || "Could not load cAavegotchi roster", "error")
    return null
  }

  const fleetSync = async () => {
    const r = await runAbra(rootDir, ["node", "scripts/openclaw-fleet.mjs", "sync"])
    if (r.status !== 0) {
      log(rootDir, "fleet-sync-fail", { status: r.status })
      toast(api, `Fleet sync failed: ${safeErr(r.stdout, r.stderr)}`, "warning")
      return false
    }
    return true
  }

  const spawnHero = async (heroId: string, task: string) => {
    if (isOrch(heroId)) {
      toast(api, "owned-954 is the orchestrator — pick another gotchi", "error")
      flowBusy = false
      return
    }
    const prompt = (task || "").trim() || DEFAULT_TASK
    toast(api, `Spawning ${heroId}…`, "info")
    log(rootDir, "spawn", { heroId })
    const r = await runAbra(rootDir, ["./scripts/gotchi-orchestrate.mjs", "spawn", "--host", "auto", "--model", "auto", prompt], {
      GOTCHIBOT_HERO_ID: heroId,
    })
    if (r.status !== 0) {
      toast(api, `Spawn failed: ${safeErr(r.stdout, r.stderr)}`, "error")
      log(rootDir, "spawn-fail", { heroId, status: r.status })
      flowBusy = false
      return
    }
    const sid = lastLineId(r.stdout)
    toast(api, sid ? `Spawned ${heroId} (${sid})` : `Spawned ${heroId}`, "success")
    log(rootDir, "spawn-ok", { heroId, session: sid || undefined })
    flowBusy = false
  }

  const pickAvailable = (heroes: Hero[], task: string, preferred?: string) => {
    const available = heroes.filter((h) => h.status === "available" && !isOrch(h.id))
    const ordered = preferred
      ? [...available].sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred))
      : available
    // Always DialogSelect — never auto-spawn / auto-bind, even for a single match.
    showSelect(
      {
        title: "Spawn agent",
        placeholder: "Pick by name — never type an id",
        options: ordered.map((h) => ({
          title: heroTitle(h),
          value: h.id,
          description: [assignmentDesc(h), preferred && h.id === preferred ? "named · current" : ""]
            .filter(Boolean)
            .join(" · "),
        })),
      },
      (id) => {
        if (!id) {
          dismissStop("empty-pick")
          return
        }
        void spawnHero(id, task)
      },
    )
  }

  const runMintSub = (task: string, starter: (typeof STARTERS)[number], beforeIds: Set<string>) => {
    showConfirm(`$5 sim — mint ${starter.label}?`, "Posts mint-sub with simPay. Not a wallet bind.", () => {
      void (async () => {
        toast(api, `Minting ${starter.label}…`, "info")
        log(rootDir, "mint-sub", { spirit: starter.spirit, label: starter.label })
        const r = await runAbra(rootDir, ["node", "scripts/onboarding-api.mjs", "mint-sub", starter.spirit])
        if (r.status !== 0) {
          toast(api, `Mint failed: ${safeErr(r.stdout, r.stderr)}`, "error")
          log(rootDir, "mint-sub-fail", { status: r.status })
          flowBusy = false
          return
        }
        let heroId = lastLineId(r.stdout)
        await fleetSync()
        if (!heroId || isOrch(heroId)) {
          const again = await loadHeroes()
          const created = (again || []).find((h) => !beforeIds.has(h.id) && !isOrch(h.id))
          heroId = created?.id || heroId
        }
        if (!heroId || isOrch(heroId)) {
          toast(api, "Minted, but could not read new hero id", "error")
          flowBusy = false
          return
        }
        await spawnHero(heroId, task)
      })()
    })
  }

  const runBindOwned = (task: string, tokenId: string) => {
    void (async () => {
      toast(api, `Binding #${tokenId}…`, "info")
      log(rootDir, "bind-owned", { tokenId })
      const r = await runAbra(rootDir, ["node", "scripts/onboarding-api.mjs", "bind-owned", tokenId])
      if (r.status !== 0) {
        toast(api, `Bind failed: ${safeErr(r.stdout, r.stderr)}`, "error")
        log(rootDir, "bind-owned-fail", { status: r.status })
        flowBusy = false
        return
      }
      let heroId = lastLineId(r.stdout)
      await fleetSync()
      if (!heroId || isOrch(heroId)) {
        const again = await loadHeroes()
        const created = (again || []).find((h) => h.id === `owned-${tokenId}` || h.sourceTokenId === tokenId)
        heroId = created?.id || heroId
      }
      if (!heroId || isOrch(heroId)) {
        toast(api, "Bound, but could not read new hero id", "error")
        flowBusy = false
        return
      }
      await spawnHero(heroId, task)
    })()
  }

  const mintCollateral = (task: string, beforeIds: Set<string>, title = "Mint new collateral") => {
    showSelect(
      {
        title,
        placeholder: "16 starter collaterals ($5 sim)",
        options: STARTERS.map((s) => ({
          title: s.label,
          value: `${s.spirit}::${s.label}`,
          description: "mint new cAavegotchi · $5 sim",
        })),
      },
      (value) => {
        const starter = STARTERS.find((s) => `${s.spirit}::${s.label}` === value)
        if (!starter) {
          dismissStop("no-spirit")
          return
        }
        runMintSub(task, starter, beforeIds)
      },
    )
  }

  const mintFromWallet = (task: string, heroes: Hero[], collateralFilter?: string) => {
    void (async () => {
      toast(api, "Loading wallet roster…", "info")
      // Same cockpit path: gotchibot roster --wallet → wallet-roster.mjs → fetchWalletGotchis
      // Never Blockscout / never model-scraped subgraph.
      const attempts: string[][] = [
        ["./scripts/gotchibot", "roster", "--wallet", "--json"],
        ["node", "scripts/wallet-roster.mjs", "--json"],
        ["./scripts/gotchibot", "roster", "--wallet"],
        ["node", "scripts/wallet-roster.mjs"],
      ]
      let gotchis: WalletGotchi[] | null = null
      for (const args of attempts) {
        const r = await runAbra(rootDir, args)
        if (r.status !== 0) {
          log(rootDir, "wallet-fail", { cmd: args[0], status: r.status })
          if (args === attempts[attempts.length - 1]) {
            toast(api, `Wallet roster failed: ${safeErr(r.stdout, r.stderr)}`, "error")
            flowBusy = false
            return
          }
          continue
        }
        gotchis = parseWalletGotchis(r.stdout)
        log(rootDir, "wallet-roster", { cmd: args[0], count: gotchis.length })
        break
      }
      if (!gotchis) {
        flowBusy = false
        return
      }
      const bound = cartridgeTokenIds(heroes)
      const unbound = gotchis.filter((g) => !bound.has(g.tokenId))
      if (!unbound.length) {
        toast(api, "No wallet gotchis left to bind", "warning")
        showSelect(
          {
            title: "Wallet empty",
            skipFilter: true,
            options: [
              {
                title: "Mint new collateral",
                value: "collateral",
                description: "Mint a new cAavegotchi from the 16 starter collaterals ($5 sim)",
              },
              { title: "Cancel", value: "cancel", description: "Do not mint" },
            ],
          },
          (value) => {
            if (value === "collateral") mintCollateral(task, new Set(heroes.map((h) => h.id)))
            else dismissStop("wallet-empty-cancel")
          },
        )
        return
      }
      const filter = String(collateralFilter || "").trim()
      const matches = filter ? unbound.filter((g) => collateralMatches(g.collateral, filter)) : []
      if (filter && !matches.length) {
        toast(api, `No ${filter.toUpperCase()} gotchis in wallet — showing all unbound`, "warning")
      }
      // Always show the full unbound wallet list. Never auto-bind, even for one match.
      // Named collateral (BTC) is sorted first and marked current — still a picker.
      const ordered = filter
        ? [...unbound].sort((a, b) => {
            const am = collateralMatches(a.collateral, filter) ? 0 : 1
            const bm = collateralMatches(b.collateral, filter) ? 0 : 1
            return am - bm
          })
        : unbound
      const label = filter ? filter.toUpperCase() : ""
      showSelect(
        {
          title: filter ? `Mint from wallet — ${label} first` : "Mint from wallet",
          placeholder: "Pick by name — never type an id",
          options: ordered.map((g) => {
            const hit = Boolean(filter && collateralMatches(g.collateral, filter))
            return {
              title: walletTitle(g),
              value: g.tokenId,
              description:
                [g.haunt, g.collateral, hit ? `${label} · current` : ""]
                  .filter(Boolean)
                  .join(" / ") || "on-chain",
            }
          }),
        },
        (tokenId) => {
          if (!tokenId) {
            dismissStop("no-token")
            return
          }
          const g = ordered.find((x) => x.tokenId === tokenId)
          showConfirm(
            `Bind ${g ? walletTitle(g) : "#" + tokenId} from wallet?`,
            "bind-owned after confirm. Not portal / VRF / identity bind.",
            () => runBindOwned(task, tokenId),
          )
        },
      )
    })()
  }

  const loadWalletGotchis = async (): Promise<WalletGotchi[] | null> => {
    toast(api, "Loading wallet roster…", "info")
    const attempts: string[][] = [
      ["./scripts/gotchibot", "roster", "--wallet", "--json"],
      ["node", "scripts/wallet-roster.mjs", "--json"],
      ["./scripts/gotchibot", "roster", "--wallet"],
      ["node", "scripts/wallet-roster.mjs"],
    ]
    for (const args of attempts) {
      const r = await runAbra(rootDir, args)
      if (r.status !== 0) {
        log(rootDir, "wallet-fail", { cmd: args[0], status: r.status })
        if (args === attempts[attempts.length - 1]) {
          toast(api, `Wallet roster failed: ${safeErr(r.stdout, r.stderr)}`, "warning")
          return []
        }
        continue
      }
      const gotchis = parseWalletGotchis(r.stdout)
      log(rootDir, "wallet-roster", { cmd: args[0], count: gotchis.length })
      return gotchis
    }
    return []
  }

  // Named collateral (YFI / BTC / LINK / …): skip 3-choice AND skip portal / VRF.
  // DialogSelect = matching 16 starters + matching unbound wallet gotchis.
  // Always a list — never auto-mint. Zero matches → full 16 + toast.
  const pickNamedCollateral = (task: string, heroes: Hero[], filter: string) => {
    void (async () => {
      const label = displaySpirit(filter)
      const beforeIds = new Set(heroes.map((h) => h.id))
      const starters = STARTERS.filter((s) => starterMatches(s, filter))
      const gotchis = await loadWalletGotchis()
      const bound = cartridgeTokenIds(heroes)
      const walletHits = (gotchis || []).filter(
        (g) => !bound.has(g.tokenId) && collateralMatches(g.collateral, filter),
      )
      log(rootDir, "flow-collateral-matches", {
        filter,
        spirit: canonicalSpirit(filter),
        starters: starters.length,
        wallet: walletHits.length,
      })
      if (!starters.length && !walletHits.length) {
        toast(api, `no ${label} match — pick from the 16`, "warning")
        mintCollateral(task, beforeIds, `No ${label} match — pick from the 16`)
        return
      }
      const options: Array<{ title: string; value: string; description?: string }> = []
      for (const s of starters) {
        options.push({
          title: s.label,
          value: `mint::${s.spirit}::${s.label}`,
          description: "mint new cAavegotchi · $5 sim",
        })
      }
      for (const g of walletHits) {
        options.push({
          title: walletTitle(g),
          value: `bind::${g.tokenId}`,
          description: "bind from wallet",
        })
      }
      options.push({
        title: "Cancel",
        value: "cancel",
        description: "Do not mint or bind",
      })
      log(rootDir, "flow-collateral-dialog", { title: `${label} matches`, options: options.length })
      showSelect(
        {
          title: `${label} matches`,
          placeholder: "Always a list — confirm before mint / bind",
          skipFilter: true,
          options,
        },
        (value) => {
          if (!value || value === "cancel") {
            dismissStop(value === "cancel" ? "collateral-cancel" : "empty-collateral-pick")
            return
          }
          if (value.startsWith("mint::")) {
            const rest = value.slice("mint::".length)
            const starter = STARTERS.find((s) => `${s.spirit}::${s.label}` === rest)
            if (!starter) {
              dismissStop("no-spirit")
              return
            }
            runMintSub(task, starter, beforeIds)
            return
          }
          if (value.startsWith("bind::")) {
            const tokenId = value.slice("bind::".length)
            const g = walletHits.find((x) => x.tokenId === tokenId)
            showConfirm(
              `Bind ${g ? walletTitle(g) : "#" + tokenId} from wallet?`,
              "bind-owned after confirm. Not portal / VRF / identity bind.",
              () => runBindOwned(task, tokenId),
            )
            return
          }
          dismissStop("bad-collateral-pick")
        },
      )
    })()
  }

  const makeAvailable = (task: string, heroes: Hero[]) => {

    const rows = heroes.filter((h) => !isOrch(h.id))
    if (!rows.length) {
      toast(api, "No agents to unassign (owned-954 is the orchestrator)", "warning")
      flowBusy = false
      return
    }
    showSelect(
      {
        title: "Make an agent available",
        placeholder: "Unassign, then spawn",
        options: rows.map((h) => ({
          title: h.id,
          value: h.id,
          description: assignmentDesc(h),
        })),
      },
      (heroId) => {
        if (!heroId || isOrch(heroId)) {
          dismissStop("no-unassign")
          return
        }
        void (async () => {
          toast(api, `Setting ${heroId} available…`, "info")
          log(rootDir, "set-available", { heroId })
          const r = await runAbra(rootDir, ["node", "scripts/hero-agent-state.mjs", "set", heroId, "available"])
          if (r.status !== 0) {
            toast(api, `Unassign failed: ${safeErr(r.stdout, r.stderr)}`, "error")
            log(rootDir, "set-available-fail", { status: r.status })
            flowBusy = false
            return
          }
          await spawnHero(heroId, task)
        })()
      },
    )
  }

  const noneAvailable = (task: string, heroes: Hero[]) => {
    try {
      void api.attention.notify({
        message: "A question needs your input",
        sound: { name: "question" },
      })
    } catch {
      // ignore
    }
    showSelect(
      {
        title: "No available gotchis",
        skipFilter: true,
        options: [
          {
            title: "Make an agent available",
            value: "unassign",
            description: "Unassign a currently assigned cAavegotchi, then continue",
          },
          {
            title: "Mint from wallet",
            value: "wallet",
            description: "Bind an on-chain Aavegotchi you already own",
          },
          {
            title: "Mint new collateral",
            value: "collateral",
            description: "Mint a new cAavegotchi from the 16 starter collaterals ($5 sim)",
          },
        ],
      },
      (value) => {
        if (value === "unassign") makeAvailable(task, heroes)
        else if (value === "wallet") mintFromWallet(task, heroes)
        else if (value === "collateral") mintCollateral(task, new Set(heroes.map((h) => h.id)))
        else dismissStop("none-pick")
      },
    )
  }

  const startFlow = async (req: SpawnReq, source: string) => {
    if (flowBusy) {
      toast(api, "Spawn UI already open", "info")
      return
    }
    flowBusy = true
    const task = (req.task || "").trim() || DEFAULT_TASK
    log(rootDir, "flow-start", { source, heroId: req.heroId, collateral: req.collateral, taskChars: task.length })
    toast(api, "Checking roster…", "info")
    const heroes = await loadHeroes()
    if (!heroes) {
      flowBusy = false
      return
    }
    // Named collateral (YFI / BTC / LINK / …): cartridge FIRST.
    // Available matching cAavegotchi (never owned-954, never assigned) → spawn.
    // No match → skip 3-choice AND skip portal / VRF; mint/bind overlay.
    if (req.collateral) {
      const matchingAvailable = heroes.filter(
        (h) => h.status === "available" && !isOrch(h.id) && heroCollateralMatches(h, req.collateral || ""),
      )
      log(rootDir, "flow-collateral", {
        collateral: req.collateral,
        spirit: canonicalSpirit(req.collateral),
        availableMatches: matchingAvailable.map((h) => h.id),
      })
      if (matchingAvailable.length === 1) {
        toast(api, `Spawning available ${displaySpirit(req.collateral)} ${heroTitle(matchingAvailable[0])}`, "info")
        await spawnHero(matchingAvailable[0].id, task)
        return
      }
      if (matchingAvailable.length > 1) {
        pickAvailable(matchingAvailable, task)
        return
      }
      pickNamedCollateral(task, heroes, req.collateral)
      return
    }
    const available = heroes.filter((h) => h.status === "available" && !isOrch(h.id))
    if (available.length >= 1) {
      pickAvailable(heroes, task, req.heroId)
      return
    }
    noneAvailable(task, heroes)
  }

  const requestPath = join(sessionsDir(rootDir), REQUEST_NAME)

  const pickupRequest = () => {
    if (flowBusy) return
    if (!existsSync(requestPath)) return
    let raw = ""
    try {
      raw = readFileSync(requestPath, "utf8")
    } catch {
      return
    }
    const picked = `${requestPath}.picked`
    try {
      try {
        unlinkSync(picked)
      } catch {}
      renameSync(requestPath, picked)
    } catch {
      try {
        unlinkSync(requestPath)
      } catch {
        return
      }
    }
    let req: SpawnReq = { task: DEFAULT_TASK }
    try {
      const data = JSON.parse(raw) as any
      req = {
        task: String(data?.task || data?.prompt || "").trim() || DEFAULT_TASK,
        heroId: data?.heroId ? String(data.heroId) : undefined,
        collateral: data?.collateral ? String(data.collateral).trim() : undefined,
        at: data?.at ? String(data.at) : undefined,
      }
    } catch (err) {
      log(rootDir, "request-parse-fail", { err: String(err) })
      toast(api, "Invalid .spawn-request.json", "error")
      return
    }
    log(rootDir, "request-pickup", { heroId: req.heroId, collateral: req.collateral, at: req.at })
    void startFlow(req, "file")
  }

  try {
    api.keymap.registerLayer({
      commands: [
        {
          name: "gotchi.spawn",
          title: "Spawn agent",
          category: "Gotchi",
          namespace: "palette",
          slashName: "spawn",
          run: () => {
            void startFlow({ task: DEFAULT_TASK }, "slash")
          },
        },
      ],
    })
  } catch (err) {
    log(rootDir, "keymap-failed", { err: String(err) })
  }

  const timer = setInterval(() => {
    try {
      pickupRequest()
    } catch (err) {
      log(rootDir, "poll-error", { err: String(err) })
    }
  }, POLL_MS)
  unsubs.push(() => clearInterval(timer))

  setTimeout(() => {
    toast(api, "Spawn UI ready — /spawn", "info")
  }, 900)

  api.lifecycle?.onDispose?.(() => {
    for (const u of unsubs) {
      try {
        u()
      } catch {}
    }
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: ID,
  tui,
}

export default plugin
