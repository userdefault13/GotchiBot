#!/usr/bin/env node
/**
 * OpenClaw fleet — one OpenClaw agent per cartridge cAavegotchi.
 *
 *   node scripts/openclaw-fleet.mjs sync [--json]
 *   node scripts/openclaw-fleet.mjs list [--json]
 *   node scripts/openclaw-fleet.mjs status [--json]
 *   node scripts/openclaw-fleet.mjs switch <heroId>
 *   node scripts/openclaw-fleet.mjs chat "<prompt>" [--agent <id>]
 *
 * Generates config/openclaw.fleet.generated.json5 for the gateway agents.entries
 * merge and keeps sessions/.openclaw-agent-map.json in sync with cartridge heroes.
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMeta } from "./identity.mjs";
import {
  fetchCartridgeHeroes,
  loadOnboarding,
  ROOT,
  SESSIONS,
} from "./onboarding-lib.mjs";

const __DIR = dirname(fileURLToPath(import.meta.url));
export { ROOT, SESSIONS };

export const FLEET_ENTRIES = `${ROOT}/config/openclaw.fleet.generated.json5`;
export const FLEET_LIST = `${ROOT}/config/openclaw.fleet.list.json5`;
export const AGENT_DIR_ROOT = `${ROOT}/config/openclaw/agents`;
export const INSTALL_SNIPPET = `${ROOT}/config/openclaw.install.json5`;
export const AGENT_MAP = `${SESSIONS}/.openclaw-agent-map.json`;
export const OPENCLAW_FOCUS = `${SESSIONS}/.openclaw-focus.json`;
export const GATEWAY_CONFIG = `${SESSIONS}/.openclaw-gateway.json`;

const ORCH_PROMPT = [
  "You are the MAIN GotchiBot. OpenClaw agent owned-954. Julius talks to you.",
  "You are not a worker. You are the boss. You delegate and manage other bots.",
  "Workers: LINK (starter-link-h1-1) and any other hero or dispatch session.",
  "When asked if you are orch or a sub: you are the orchestrator, the main bot.",
  "Job: hear Julius, assign the right bot, watch them, merge, report. Do not become LINK. Do not DIY the trader desk.",
  "Reply first. Real beats only. Lead with the result. Close the loop. On it is not the answer.",
  "Models: stay on big-pickle / gateway default for talk+execute. Do NOT /model @claudemode.",
  "## Claude Code tool (YOU HAVE THIS — MCP gotchibot-claude)",
  "When Julius asks about a Claude tool / @claudemode / Hub Claude pane: answer YES.",
  "UI HARD RULE (no thinking): bridge ALWAYS opens VS Code Claude pane first, then Terminal fallback if pane fails, AND headless claude -p for Desk text. Never say headless-only / no chat by design. anthropic.claude-code + gotchibot-bridge = one pipeline.",
  "Cold/new Claude pane: load claude-pane-proxy; MCP hub_claude_pane_init or `./scripts/gotchibot claude-pane-init` BEFORE first submit (sets CLAUDE.md + @gotchibot-proxy; reports_to assigned hero).",
  "Long work: MCP claude_submit {prompt} → get {id,status:pending} immediately; continue other work. Do NOT block/poll.",
  "When push-wake says job ready (or Julius nudges): MCP claude_collect {id} and continue with that reply.",
  "Short sync only: claude_ask. List jobs: claude_jobs.",
  "Fallback Bash (sub-agents: NEVER wrap in abra — Touch ID fails headless):",
  "  node ./scripts/claudemode-submit.mjs \"…\"",
  "  node ./scripts/claude-jobs.mjs collect <id>",
  "  interactive Desk: abra run gotchibot -- ./scripts/gotchibot claude-submit \"…\"",
  "That hits iMac VS Code Claude Code. Prefer submit over blocking ask.",
  "If Julius says pane empty but tool replied: UI paste may have failed — hub_bridge_ensure / Bridge Show Log. Do not invent architecture.",
  "If submit/ask fails (connection refused / bridge down): MCP hub_bridge_ensure or `./scripts/gotchibot hub bridge-ensure`, then retry once. Load hub-sop.",
  "Never say you lack a Claude tool. Never list only Bash/Edit/Write and claim Claude is missing.",
  "Never ask Julius to configure a relay first — it is already wired.",
  "Skills to load: delegate-first, browser-tool, gotchibot-bridge, claude-pane-proxy, hub-sop, synergy.",
  "If OpenClaw/Hub is down (OC✗, gateway-unreachable): load hub-sop and run gotchibot hub restart-gateway — do not invent SSH.",
  "Roster / who talks to whom / /list /switch /handoffs: load synergy (do not invent cooperation protocols).",
  "Trader: LINK owns the paper desk. Delegate monitor/improve/news. Stay paper. Open-mark is mark not PnL. News is a veto.",
  "Spawn: ./scripts/gotchi-orchestrate.mjs spawn --model auto \"prompt\" — every worker needs a cAavegotchi.",
  "Never install tools autonomously. Secrets via abracadabra only.",
  "Read workspace SOUL.md and USER.md every session.",
  "Home stack is allowed: ./scripts/*.mjs, abra run gotchibot -- *, wallet-roster, identity, localhost / *.aarcadeghst.com / cartridge sim / subgraph.aarcadeghst.com. Never Blockscout. Never arbitrary web curl. Named collateral (YFI): cartridge first for an available matching cAavegotchi; do not steal assigned desks. Never ask Julius for a token id.",
].join("\n");

function ensureSessions() {
  mkdirSync(SESSIONS, { recursive: true });
}

/** OpenClaw agent id === cartridge hero id (stable, unique). */
export function heroToAgentId(heroId) {
  return String(heroId || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "-");
}

export function orchestratorHeroId() {
  const ob = loadOnboarding();
  const meta = loadMeta();
  if (ob.orchestratorHeroId && String(ob.orchestratorHeroId).startsWith("owned-")) {
    return ob.orchestratorHeroId;
  }
  if (meta?.activeHeroId && String(meta.activeHeroId).startsWith("owned-")) {
    return meta.activeHeroId;
  }
  if (ob.orchestratorHeroId) return ob.orchestratorHeroId;
  return meta?.activeHeroId || "owned-954";
}

function collateralEmoji(collateral) {
  const c = String(collateral || "").toLowerCase();
  if (c.includes("link")) return "🔗";
  if (c.includes("aave")) return "👻";
  if (c.includes("eth")) return "💎";
  return "🤖";
}

function readJsonFile(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

/** Thin load of role id + playbook for a hero (duplicated in gotchi-meet — avoid circular imports). */
function loadRoleForHero(heroId) {
  const id = String(heroId || "").trim();
  if (!id) return { roleId: null, playbook: null };
  const roles = readJsonFile(`${ROOT}/config/agent-roles.json`, {}) || {};
  const playbooks = readJsonFile(`${ROOT}/config/agent-role-playbooks.json`, {}) || {};
  const roleId = roles[id] || null;
  if (!roleId) return { roleId: null, playbook: null };
  const playbook = playbooks[roleId] || null;
  return { roleId, playbook };
}

function roleJobBlock(heroId) {
  const { roleId, playbook } = loadRoleForHero(heroId);
  if (!roleId || !playbook) return "";
  const skills = Array.isArray(playbook.skills) ? playbook.skills.join(", ") : "";
  return [
    "",
    "## Your job",
    `Role: ${playbook.title || roleId} (\`${roleId}\`)`,
    playbook.summary || "",
    `Autonomy: ${playbook.autonomy || ""}`,
    skills ? `Skills to load: ${skills}` : "",
    playbook.reportCmd
      ? `Status report (verbatim): \`${playbook.reportCmd}\``
      : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function subSystemPrompt(hero, displayName) {
  const id = hero.id || hero.heroId;
  const name = displayName || hero.name || id;
  const lines = [
    `You are ${name} (${id}). You ARE this cAavegotchi — a first-class OpenClaw agent, not a narrator.`,
    "Speak in first person: I, me, my. Never \"the sub-agent\", \"LINK will\", or \"this worker\". You are not the orchestrator.",
    "Work in the GotchiBot workspace. Write deliverables to sessions/<id>/output.md when spawned as a dispatch session.",
    "Escalate orchestration, multi-agent fan-out, or wallet/cartridge tasks to the orchestrator hero.",
    "Never install tools autonomously. Secrets via abracadabra only. Read AGENTS.md.",
  ];
  const job = roleJobBlock(id);
  if (job) lines.push(job);
  else lines.push("\n## Your job\nSkills to load: browser-tool");
  return lines.join("\n");
}

/**
 * Normalise a lowercase `~/dev/` checkout to `~/Dev/`, so the workspace path
 * matches the Docker bind mount regardless of which spelling the repo sits
 * under. Home-relative rather than hardcoded to one machine's user.
 */
function normalizeDevCase(p) {
  const home = homedir();
  return p.startsWith(`${home}/dev/`) ? `${home}/Dev/${p.slice(home.length + 5)}` : p;
}

/** Canonical workspace path — must match Docker bind mount on iMac (capital Dev). */
export function fleetWorkspace() {
  const override = process.env.GOTCHIBOT_OPENCLAW_WORKSPACE?.trim();
  if (override) return override;
  try {
    return normalizeDevCase(realpathSync(ROOT));
  } catch {
    return normalizeDevCase(String(ROOT));
  }
}

function writeAgentPromptDir(id, systemPrompt, { isOrchestrator = false } = {}) {
  const ws = fleetWorkspace();
  const dir = `${ws}/config/openclaw/agents/${id}`;
  mkdirSync(dir, { recursive: true });
  const homeStack =
    "Home stack allowed: ./scripts/*.mjs, abra run gotchibot -- *, wallet-roster, identity, localhost / *.aarcadeghst.com / cartridge sim / subgraph.aarcadeghst.com. Never Blockscout. Never arbitrary web curl.";
  const footer = isOrchestrator
    ? "Follow `ORCHESTRATOR.md`. Ignore sub-agent / dispatch-session wording in workspace `AGENTS.md` — you are the orchestrator hero, not a spawned sub-agent.\n" + homeStack
    : "Follow the GotchiBot workspace `AGENTS.md` and `ORCHESTRATOR.md`.\n" + homeStack;
  writeFileSync(`${dir}/AGENTS.md`, `${systemPrompt}\n\n${footer}\n`);
  return dir;
}

function buildEntry(hero, { isOrchestrator }) {
  const id = heroToAgentId(hero.id);
  const name =
    hero.name ||
    (isOrchestrator ? "Gotchi" : String(hero.collateral || id).toUpperCase());
  const systemPrompt = isOrchestrator ? ORCH_PROMPT : subSystemPrompt(hero, name);
  const ws = fleetWorkspace();
  const agentDir = writeAgentPromptDir(id, systemPrompt, { isOrchestrator });
  const entry = {
    identity: {
      name,
      emoji: isOrchestrator ? "👻" : collateralEmoji(hero.collateral),
    },
    workspace: ws,
    agentDir: `${ws}/config/openclaw/agents/${id}`,
  };
  if (isOrchestrator) {
    entry.default = true;
    entry.groupChat = { mentionPatterns: ["@gotchi", "@Gotchi", "gotchi"] };
  }
  return { id, entry };
}

async function loadHeroes() {
  const meta = loadMeta();
  if (!meta?.cartridgeId) return [];
  try {
    return await fetchCartridgeHeroes(meta.cartridgeId);
  } catch {
    const orch = orchestratorHeroId();
    return orch ? [{ id: orch, name: "Gotchi", bindType: "owned" }] : [];
  }
}

function entriesToList(entries) {
  return Object.entries(entries).map(([id, entry]) => {
    const { systemPrompt: _drop, ...rest } = entry;
    if (rest.default === false) delete rest.default;
    return { id, ...rest };
  });
}

function entriesForConfig(entries) {
  const out = {};
  for (const [id, entry] of Object.entries(entries)) {
    const { systemPrompt: _drop, ...rest } = entry;
    if (rest.default === false) delete rest.default;
    out[id] = rest;
  }
  return out;
}

function writeFleetArtifacts({ entries, map, orchId }) {
  mkdirSync(`${ROOT}/config`, { recursive: true });
  ensureSessions();

  const list = entriesToList(entries);
  const configEntries = entriesForConfig(entries);
  const header = [
    "// AUTO-GENERATED by scripts/openclaw-fleet.mjs sync — do not edit by hand.",
    `// Generated: ${new Date().toISOString()}`,
    `// Orchestrator hero: ${orchId}`,
    "// Merge into ~/.openclaw/openclaw.json:",
    "//   agents.entries: { $include: \"./gotchibot-fleet.entries.json5\" }",
    "// Legacy 2026.7 agents.list:",
    "//   agents.list: { $include: \"./gotchibot-fleet.list.json5\" }",
    "",
  ].join("\n");

  writeFileSync(FLEET_ENTRIES, `${header}${JSON.stringify(configEntries, null, 2)}\n`);
  writeFileSync(FLEET_LIST, `${header}${JSON.stringify(list, null, 2)}\n`);

  mkdirSync(`${homedir()}/.openclaw`, { recursive: true });
  const homeFleetEntries = `${homedir()}/.openclaw/gotchibot-fleet.entries.json5`;
  const homeFleetList = `${homedir()}/.openclaw/gotchibot-fleet.list.json5`;
  writeFileSync(homeFleetEntries, `${header}${JSON.stringify(configEntries, null, 2)}\n`);
  writeFileSync(homeFleetList, `${header}${JSON.stringify(list, null, 2)}\n`);

  writeFileSync(
    AGENT_MAP,
    `${JSON.stringify(
      {
        orchestratorHeroId: orchId,
        orchestratorAgentId: heroToAgentId(orchId),
        agents: map,
        syncedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );

  const install = {
    "//": "Drop-in OpenClaw config fragment for GotchiBot fleet agents (2026.8+ uses agents.entries).",
    agents: {
      defaults: { $include: `${ROOT}/config/openclaw.gotchi.json5` },
      entries: { $include: FLEET_ENTRIES },
    },
  };
  writeFileSync(INSTALL_SNIPPET, `${JSON.stringify(install, null, 2)}\n`);
}

export async function syncFleet({ quiet = false } = {}) {
  const heroes = await loadHeroes();
  const orchId = orchestratorHeroId();
  const entries = {};
  const map = {};

  for (const hero of heroes) {
    const isOrchestrator = hero.id === orchId;
    const { id, entry } = buildEntry(hero, { isOrchestrator });
    entries[id] = entry;
    map[id] = {
      heroId: hero.id,
      name: hero.name || null,
      collateral: hero.collateral || hero.collateralAddress || null,
      bindType: hero.bindType || null,
      isOrchestrator,
      status: hero.agentStatus || "available",
    };
  }

  if (!Object.keys(entries).length && orchId) {
    const { id, entry } = buildEntry(
      { id: orchId, name: "Gotchi", bindType: "owned" },
      { isOrchestrator: true },
    );
    entries[id] = entry;
    map[id] = { heroId: orchId, isOrchestrator: true, status: "available" };
  }

  // Backward-compat alias: openclaw agent --agent gotchi → orchestrator hero.
  const orchAgentId = heroToAgentId(orchId);
  if (entries[orchAgentId] && orchAgentId !== "gotchi") {
    const { default: _orchDefault, ...orchRest } = entries[orchAgentId];
    const aliasDir = writeAgentPromptDir("gotchi", ORCH_PROMPT, { isOrchestrator: true });
    entries.gotchi = { ...orchRest, agentDir: aliasDir };
    map.gotchi = { ...map[orchAgentId], aliasOf: orchAgentId, isOrchestrator: true };
  }

  writeFleetArtifacts({ entries, map, orchId });

  const payload = {
    ok: true,
    orchestratorHeroId: orchId,
    orchestratorAgentId: orchAgentId,
    count: Object.keys(entries).length,
    agents: Object.keys(entries),
    fleetConfig: FLEET_ENTRIES,
    installSnippet: INSTALL_SNIPPET,
  };
  if (!quiet) {
    console.log(`openclaw fleet synced → ${payload.count} agents`);
    console.log(`  config: ${FLEET_ENTRIES}`);
    for (const id of payload.agents) {
      const m = map[id];
      const tag = m?.isOrchestrator ? "orch" : "sub";
      const alias = m?.aliasOf ? ` (alias → ${m.aliasOf})` : "";
      console.log(`  · ${id} [${tag}]${alias}`);
    }
  }
  return payload;
}

export function loadAgentMap() {
  try {
    return JSON.parse(readFileSync(AGENT_MAP, "utf8"));
  } catch {
    return null;
  }
}

export function saveOpenClawFocus(data) {
  ensureSessions();
  writeFileSync(
    OPENCLAW_FOCUS,
    `${JSON.stringify({ ...data, updatedAt: new Date().toISOString() }, null, 2)}\n`,
  );
}

export function loadOpenClawFocus() {
  try {
    return JSON.parse(readFileSync(OPENCLAW_FOCUS, "utf8"));
  } catch {
    return null;
  }
}

/** OpenClaw TUI agent id from focus + fleet map (orch default). */
export function resolveOpenClawTuiAgentId() {
  const override = process.env.GOTCHIBOT_OPENCLAW_AGENT?.trim();
  if (override) return override;

  const map = loadAgentMap();
  const orchId =
    map?.orchestratorAgentId || heroToAgentId(orchestratorHeroId());

  let focus = loadOpenClawFocus();
  if (!focus) {
    try {
      focus = JSON.parse(readFileSync(`${SESSIONS}/.focus.json`, "utf8"));
    } catch {
      focus = null;
    }
  }

  if (focus?.mode === "sub") {
    return String(focus.openclawAgentId || focus.heroId || orchId);
  }
  return orchId;
}

export async function switchOpenClawAgent(heroId) {
  await syncFleet({ quiet: true });
  const agentId = heroToAgentId(heroId);
  const orchId = orchestratorHeroId();
  const mode = heroId === orchId ? "orch" : "sub";
  saveOpenClawFocus({ agentId, heroId, mode });
  return { agentId, heroId, mode };
}

export function loadGatewayConfig() {
  try {
    return JSON.parse(readFileSync(GATEWAY_CONFIG, "utf8"));
  } catch {
    return null;
  }
}

export function saveGatewayConfig(data) {
  ensureSessions();
  writeFileSync(
    GATEWAY_CONFIG,
    `${JSON.stringify({ ...data, updatedAt: new Date().toISOString() }, null, 2)}\n`,
  );
}

/** Point MBP chat at iMac (or any) OpenClaw gateway. */
export function pointGateway({ host, port = "18789", token } = {}) {
  const h =
    host?.trim() ||
    process.env.REMOTE_HOST?.trim() ||
    process.env.GOTCHIBOT_REMOTE_HOST?.trim() ||
    process.env.GOTCHIBOT_OPENCLAW_HOST?.trim();
  if (!h) throw new Error("need host (arg or REMOTE_HOST)");
  let tok = token?.trim() || process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || "";
  if (!tok) {
    for (const p of [`${ROOT}/../openclaw/.env`, `${homedir()}/Dev/openclaw/.env`]) {
      try {
        const m = readFileSync(p, "utf8").match(/^OPENCLAW_GATEWAY_TOKEN=(.+)$/m);
        if (m) {
          tok = m[1].trim();
          break;
        }
      } catch {}
    }
  }
  const url = `http://${h}:${port}`;
  const cfg = { host: h, port, url, wsUrl: url.replace(/^http:/, "ws:"), token: tok || null };
  saveGatewayConfig(cfg);
  return cfg;
}

export function gatewayUrl() {
  const raw =
    process.env.OPENCLAW_GATEWAY_URL?.trim() ||
    process.env.GOTCHIBOT_OPENCLAW_URL?.trim() ||
    "";
  if (raw) return raw.replace(/\/$/, "");
  const file = loadGatewayConfig();
  if (file?.url) return String(file.url).replace(/\/$/, "");
  const port = process.env.OPENCLAW_GATEWAY_PORT || process.env.GOTCHIBOT_OPENCLAW_PORT || "18789";
  const host = process.env.GOTCHIBOT_OPENCLAW_HOST || "127.0.0.1";
  return `http://${host}:${port}`;
}

export function gatewayWsUrl() {
  const http = gatewayUrl();
  if (http.startsWith("https://")) return http.replace(/^https:/, "wss:");
  if (http.startsWith("http://")) return http.replace(/^http:/, "ws:");
  if (http.startsWith("ws")) return http;
  return `ws://${http}`;
}

export async function gatewayReachable() {
  const url = `${gatewayUrl()}/healthz`;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 2500);
    const r = await fetch(url, { signal: ac.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

export function findOpenclawBin() {
  const fromEnv = process.env.OPENCLAW_BIN?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const local = `${homedir()}/.openclaw/bin/openclaw`;
  if (existsSync(local)) return local;
  const r = spawnSync("which", ["openclaw"], { encoding: "utf8" });
  const p = (r.stdout || "").trim();
  return p && r.status === 0 ? p : null;
}

export function preferOpenClawChat() {
  if (process.env.GOTCHIBOT_OPENCLAW === "0") return false;
  if (process.env.GOTCHIBOT_CHAT_RUNTIME === "opencode") return false;
  return true;
}

function gatewayAuthArgs() {
  // openclaw agent 2026.7 has no --token/--password; gatewayProcessEnv sets OPENCLAW_GATEWAY_TOKEN.
  return [];
}

export function gatewayProcessEnv() {
  const file = loadGatewayConfig();
  const token =
    process.env.OPENCLAW_GATEWAY_TOKEN?.trim() ||
    process.env.GOTCHIBOT_OPENCLAW_TOKEN?.trim() ||
    file?.token?.trim() ||
    "";
  const password =
    process.env.OPENCLAW_GATEWAY_PASSWORD?.trim() ||
    process.env.GOTCHIBOT_OPENCLAW_PASSWORD?.trim() ||
    "";
  const env = {
    ...process.env,
    OPENCLAW_GATEWAY_URL: process.env.OPENCLAW_GATEWAY_URL?.trim() || gatewayUrl(),
  };
  if (token && !env.OPENCLAW_GATEWAY_TOKEN) env.OPENCLAW_GATEWAY_TOKEN = token;
  if (password && !env.OPENCLAW_GATEWAY_PASSWORD) env.OPENCLAW_GATEWAY_PASSWORD = password;
  return env;
}

/** Inject one user turn into an OpenClaw session (default: TUI main session). */
export function runAgentTurn(agentId, message, { json = false, timeout = 600, sessionKey } = {}) {
  const bin = findOpenclawBin();
  if (!bin) return { ok: false, reason: "openclaw-not-installed" };

  const key = (sessionKey || tuiSessionKey(agentId)).trim();
  const args = [
    "agent",
    "--agent",
    agentId,
    "--message",
    message,
    "--session-key",
    key,
    "--timeout",
    String(timeout),
    ...gatewayAuthArgs(),
  ];
  if (json) args.push("--json");

  const env = gatewayProcessEnv();
  const spawnOpts = {
    cwd: ROOT,
    encoding: "utf8",
    env,
    maxBuffer: 20 * 1024 * 1024,
    timeout: (Number(timeout) + 30) * 1000,
  };

  const run = () => spawnSync(bin, args, spawnOpts);

  let r = run();

  if (
    r.status !== 0 &&
    !process.env.GOTCHIBOT_SKIP_ABRA &&
    spawnSync("which", ["abra"], { encoding: "utf8" }).status === 0
  ) {
    r = spawnSync("abra", ["run", "gotchibot", "--", bin, ...args], spawnOpts);
  }

  const stderr = r.stderr || "";
  let reason = r.status === 0 ? null : "openclaw-agent-failed";
  if (reason && /pairing required|device is not approved/i.test(`${stderr}\n${r.stdout || ""}`)) {
    reason = "device-pairing-required";
  }

  return {
    ok: r.status === 0,
    status: r.status,
    stdout: r.stdout || "",
    stderr,
    sessionKey: key,
    reason,
  };
}

export function tuiSessionKey(agentId) {
  return `agent:${agentId}:main`;
}

function gatewayToken() {
  const file = loadGatewayConfig();
  return (
    process.env.OPENCLAW_GATEWAY_TOKEN?.trim() ||
    process.env.GOTCHIBOT_OPENCLAW_TOKEN?.trim() ||
    file?.token?.trim() ||
    ""
  );
}

function openaiContent(data) {
  const c = data?.choices?.[0]?.message?.content;
  if (typeof c === "string" && c.trim()) return c.trim();
  if (Array.isArray(c)) {
    return c
      .map((p) => (typeof p === "string" ? p : p?.text || ""))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

/** Headless HTTP chat — works even when `openclaw` CLI config is invalid. */
export async function chatViaHttp(agentId, message, { timeoutMs = 120_000, sessionKey } = {}) {
  const gateway = gatewayUrl().replace(/\/$/, "");
  const token = gatewayToken();
  const id = heroToAgentId(agentId);
  const key = (sessionKey || tuiSessionKey(id)).trim();
  try {
    const r = await fetch(`${gateway}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "x-openclaw-session-key": key,
        "x-openclaw-agent-id": id,
      },
      body: JSON.stringify({
        model: "openclaw/default",
        stream: false,
        messages: [{ role: "user", content: String(message || "") }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await r.text();
    if (!r.ok) {
      return { ok: false, reason: `http-${r.status}`, stdout: raw, sessionKey: key };
    }
    let text = raw;
    try {
      text = openaiContent(JSON.parse(raw)) || raw;
    } catch {
      /* keep raw */
    }
    if (!String(text || "").trim()) {
      return { ok: false, reason: "empty-http-reply", stdout: raw, sessionKey: key };
    }
    return { ok: true, stdout: text.endsWith("\n") ? text : `${text}\n`, sessionKey: key, via: "http" };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e), sessionKey: key };
  }
}

export async function chatViaOpenClaw(agentId, message, { json = false, sessionKey } = {}) {
  if (!preferOpenClawChat()) {
    return { ok: false, reason: "openclaw-disabled" };
  }
  if (!(await gatewayReachable())) {
    return { ok: false, reason: "gateway-unreachable", gateway: gatewayUrl() };
  }

  // Prefer HTTP when CLI is missing or known-broken (invalid ~/.openclaw config).
  const bin = findOpenclawBin();
  if (bin) {
    const cli = runAgentTurn(agentId, message, { json, sessionKey: sessionKey || tuiSessionKey(agentId) });
    if (cli.ok) return { ...cli, via: "cli" };
    const http = await chatViaHttp(agentId, message, { sessionKey: sessionKey || tuiSessionKey(agentId) });
    if (http.ok) return http;
    return { ...cli, httpFallback: http.reason };
  }

  return chatViaHttp(agentId, message, { sessionKey: sessionKey || tuiSessionKey(agentId) });
}

function cmdList(json) {
  const map = loadAgentMap();
  if (!map?.agents) {
    console.error("no fleet map — run: ./scripts/openclaw-fleet.mjs sync");
    process.exit(1);
  }
  const rows = Object.entries(map.agents).map(([agentId, m]) => ({
    agentId,
    ...m,
  }));
  if (json) console.log(JSON.stringify({ orchestrator: map.orchestratorAgentId, agents: rows }, null, 2));
  else {
    console.log("OpenClaw fleet agents");
    for (const r of rows) {
      const tag = r.isOrchestrator ? "orch" : "sub";
      const alias = r.aliasOf ? ` → ${r.aliasOf}` : "";
      console.log(`  ${r.agentId} [${tag}] hero=${r.heroId}${alias}`);
    }
  }
}

async function cmdStatus(json) {
  const map = loadAgentMap();
  const focus = loadOpenClawFocus();
  const reachable = await gatewayReachable();
  const payload = {
    gateway: gatewayUrl(),
    gatewayReachable: reachable,
    openclawBin: findOpenclawBin(),
    fleet: map,
    focus,
    preferOpenClawChat: preferOpenClawChat(),
  };
  if (json) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log(`gateway ${payload.gateway} ${reachable ? "reachable" : "unreachable"}`);
    console.log(`openclaw ${payload.openclawBin || "(not installed)"}`);
    console.log(`focus ${focus ? `${focus.mode} agent=${focus.agentId} hero=${focus.heroId}` : "(none)"}`);
    console.log(`fleet ${map?.agents ? Object.keys(map.agents).length : 0} agents`);
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const json = rest.includes("--json");
  const args = rest.filter((a) => a !== "--json");

  if (cmd === "sync") {
    const quietFlag = rest.includes("--quiet");
    const r = await syncFleet({ quiet: quietFlag || json });
    if (json) console.log(JSON.stringify(r, null, 2));
    return;
  }
  if (cmd === "list") {
    cmdList(json);
    return;
  }
  if (cmd === "status") {
    await cmdStatus(json);
    return;
  }
  if (cmd === "switch") {
    const heroId = args[0];
    if (!heroId) {
      console.error("usage: openclaw-fleet.mjs switch <heroId>");
      process.exit(2);
    }
    const r = await switchOpenClawAgent(heroId);
    if (json) console.log(JSON.stringify(r, null, 2));
    else console.log(`openclaw focus → agent=${r.agentId} hero=${r.heroId} mode=${r.mode}`);
    return;
  }
  if (cmd === "point") {
    const host = args.filter((a) => a !== "--json" && a !== "--quiet")[0];
    const r = pointGateway({ host });
    if (json) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(`chat gateway → ${r.url}`);
      console.log(`  saved: ${GATEWAY_CONFIG}`);
    }
    return;
  }
  if (cmd === "tui-agent") {
    const agentId = resolveOpenClawTuiAgentId();
    const map = loadAgentMap();
    const mode =
      agentId === (map?.orchestratorAgentId || heroToAgentId(orchestratorHeroId()))
        ? "orch"
        : "sub";
    if (json) {
      console.log(JSON.stringify({ agentId, mode, session: `agent:${agentId}:main` }, null, 2));
      return;
    }
    process.stdout.write(agentId);
    return;
  }
  if (cmd === "orch") {
    const heroId = orchestratorHeroId();
    const r = await switchOpenClawAgent(heroId);
    if (json) console.log(JSON.stringify(r, null, 2));
    else console.log(r.agentId);
    return;
  }
  if (cmd === "env") {
    const cfg = loadGatewayConfig();
    const url = gatewayUrl();
    const ws = gatewayWsUrl();
    const token = cfg?.token || process.env.OPENCLAW_GATEWAY_TOKEN || "";
    if (json) {
      console.log(JSON.stringify({ url, wsUrl: ws, token: token ? "set" : null }, null, 2));
      return;
    }
    console.log(`export GOTCHIBOT_OPENCLAW_URL=${JSON.stringify(url)}`);
    console.log(`export GOTCHIBOT_OPENCLAW_WS=${JSON.stringify(ws)}`);
    if (token) console.log(`export OPENCLAW_GATEWAY_TOKEN=${JSON.stringify(token)}`);
    return;
  }
  if (cmd === "chat") {
    let agentId = loadOpenClawFocus()?.agentId || heroToAgentId(orchestratorHeroId());
    const msgParts = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--agent" && args[i + 1]) {
        agentId = args[++i];
      } else msgParts.push(args[i]);
    }
    const message = msgParts.join(" ").trim();
    if (!message) {
      console.error('usage: openclaw-fleet.mjs chat "<prompt>" [--agent <id>]');
      process.exit(2);
    }
    const r = await chatViaOpenClaw(agentId, message, { json });
    if (!r.ok) {
      if (json) console.log(JSON.stringify(r, null, 2));
      else console.error(`openclaw chat failed: ${r.reason}${r.gateway ? ` (${r.gateway})` : ""}`);
      process.exit(1);
    }
    if (json) process.stdout.write(r.stdout);
    else if (r.stdout) process.stdout.write(r.stdout);
    return;
  }

  console.error(`usage:
  openclaw-fleet.mjs sync [--json] [--quiet]
  openclaw-fleet.mjs list [--json]
  openclaw-fleet.mjs status [--json]
  openclaw-fleet.mjs switch <heroId>
  openclaw-fleet.mjs point [host]     save iMac/remote gateway for MBP chat
  openclaw-fleet.mjs tui-agent [--json]  agent id for OpenClaw TUI session
  openclaw-fleet.mjs orch [--json]    reset OpenClaw focus to orchestrator
  openclaw-fleet.mjs env [--json]     print shell exports for gateway URL/token
  openclaw-fleet.mjs chat "<prompt>" [--agent <id>]`);
  process.exit(2);
}

if (process.argv[1] && process.argv[1].endsWith("openclaw-fleet.mjs")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
