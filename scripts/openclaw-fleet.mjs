#!/usr/bin/env node
/**
 * OpenClaw fleet — one OpenClaw agent per cartridge cAavegotchi.
 *
 *   node scripts/openclaw-fleet.mjs sync [--json]
 *   node scripts/openclaw-fleet.mjs list [--json]
 *   node scripts/openclaw-fleet.mjs status [--json]
 *   node scripts/openclaw-fleet.mjs switch <heroId>
 *   node scripts/openclaw-fleet.mjs chat "<prompt>" [--agent <id>]
 *   node scripts/openclaw-fleet.mjs doctor [--json] [--live]
 *     --live also sends one "pong" prompt through the gateway to the orchestrator
 *     (probe session, not main) and to the focused sub hero, and fails with the
 *     upstream error text — e.g. "401 Invalid API key." when the Hub's model
 *     provider key is dead, which /healthz and GET /v1/models never reveal.
 *
 * Generates config/openclaw.fleet.generated.json5 for the gateway agents.entries
 * merge and keeps sessions/.openclaw-agent-map.json in sync with cartridge heroes.
 *
 * Every hero gets its OWN OpenClaw workspace at config/openclaw/workspaces/<id>/
 * (AGENTS.md, SOUL.md, IDENTITY.md, USER.md, memory/, skills/), rendered from
 * config/openclaw/templates/ + config/agent-role-playbooks.json. OpenClaw loads
 * persona files from the agent workspace only — never from agentDir — so a
 * shared workspace meant every hero booted as the orchestrator, and "Skills to
 * load: …" named skills that lived in .opencode/skills/ where OpenClaw never
 * looks. `doctor` fails when a rendered prompt references a skill or script
 * that does not exist.
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  cpSync,
  rmSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
  statSync,
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

export const TEMPLATE_DIR = `${ROOT}/config/openclaw/templates`;
export const OPENCODE_SKILLS = `${ROOT}/.opencode/skills`;
export const WORKSPACE_ROOT_REL = "config/openclaw/workspaces";

/** Skills every orchestrator session can see (on top of its playbook). */
const ORCH_SKILLS = [
  "delegate-first",
  "browser-tool",
  "gotchibot-bridge",
  "claude-pane-proxy",
  "hub-sop",
  "synergy",
  "caavegotchi-spawn",
  "gotchibot-hub",
  "gotchibot",
];
/** Skills every hero gets, orchestrator or not. */
const COMMON_SKILLS = ["passoff"];
/** OpenClaw truncates a bootstrap file past this many chars (its default). */
const BOOTSTRAP_MAX_CHARS = 20_000;
const BOOTSTRAP_TOTAL_MAX_CHARS = 60_000;
const BOOTSTRAP_FILES = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"];

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

/** Parse one of our generated .json5 files (JSON plus `//` comment lines). */
function readGeneratedJson(path, fallback = null) {
  try {
    const raw = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => !/^\s*\/\//.test(line))
      .join("\n");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function loadPlaybooks() {
  return readJsonFile(`${ROOT}/config/agent-role-playbooks.json`, {}) || {};
}

/** Thin load of role id + playbook for a hero (duplicated in gotchi-meet — avoid circular imports). */
function loadRoleForHero(heroId) {
  const id = String(heroId || "").trim();
  if (!id) return { roleId: null, playbook: null };
  const roles = readJsonFile(`${ROOT}/config/agent-roles.json`, {}) || {};
  const playbooks = loadPlaybooks();
  const roleId = roles[id] || null;
  if (!roleId) return { roleId: null, playbook: null };
  const playbook = playbooks[roleId] || null;
  return { roleId, playbook };
}

/** Canonical workspace path — must match Docker bind mount on iMac (capital Dev). */
export function fleetWorkspace() {
  const override = process.env.GOTCHIBOT_OPENCLAW_WORKSPACE?.trim();
  if (override) return override;
  try {
    return realpathSync(ROOT).replace("/Users/juliuswong/dev/", "/Users/juliuswong/Dev/");
  } catch {
    return String(ROOT).replace("/Users/juliuswong/dev/", "/Users/juliuswong/Dev/");
  }
}

export function heroWorkspaceRoot() {
  return `${fleetWorkspace()}/${WORKSPACE_ROOT_REL}`;
}

export function heroWorkspaceDir(agentId) {
  return `${heroWorkspaceRoot()}/${agentId}`;
}

function renderTemplate(file, vars) {
  const src = readFileSync(`${TEMPLATE_DIR}/${file}`, "utf8");
  return src.replace(/\{\{([A-Z_]+)\}\}/g, (m, key) =>
    Object.hasOwn(vars, key) ? String(vars[key] ?? "") : m,
  );
}

function heroSkillNames({ playbook, isOrchestrator }) {
  const fromRole = Array.isArray(playbook?.skills) ? playbook.skills : [];
  const base = isOrchestrator ? ORCH_SKILLS : ["browser-tool"];
  return [...new Set([...fromRole, ...base, ...COMMON_SKILLS])];
}

/** Relative symlink, idempotent; an existing real dir/file is left alone. */
function ensureSymlink(linkPath, target) {
  try {
    const st = lstatSync(linkPath);
    if (!st.isSymbolicLink()) return false;
    if (readlinkSync(linkPath) === target) return true;
    rmSync(linkPath);
  } catch {
    /* absent */
  }
  symlinkSync(target, linkPath);
  return true;
}

/** Copy the hero's skills from .opencode/skills into <workspace>/skills (OpenClaw's scan path). */
function copySkills(wsDir, names) {
  const dst = `${wsDir}/skills`;
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });
  const copied = [];
  const missing = [];
  for (const name of names) {
    const src = `${OPENCODE_SKILLS}/${name}`;
    if (!existsSync(`${src}/SKILL.md`)) {
      missing.push(name);
      continue;
    }
    cpSync(src, `${dst}/${name}`, {
      recursive: true,
      filter: (p) => !p.includes("/node_modules"),
    });
    copied.push(name);
  }
  writeFileSync(
    `${dst}/README.md`,
    "Generated by scripts/openclaw-fleet.mjs sync from .opencode/skills/ — edit the source there, not these copies.\n",
  );
  return { copied, missing };
}

/**
 * Render one hero's OpenClaw workspace. This is the only prompt path OpenClaw
 * actually reads (agents.entries.<id>.workspace → AGENTS/SOUL/IDENTITY/USER.md).
 */
export function writeHeroWorkspace(hero, { id, name, emoji, isOrchestrator, orchId }) {
  const repo = fleetWorkspace();
  const ws = heroWorkspaceDir(id);
  mkdirSync(ws, { recursive: true });

  let { roleId, playbook } = loadRoleForHero(hero.id || id);
  if (!roleId && isOrchestrator) {
    roleId = "orchestrator";
    playbook = loadPlaybooks().orchestrator || null;
  }
  const role = roleId || "worker";
  const skills = heroSkillNames({ playbook, isOrchestrator });
  const agentsTemplate = existsSync(`${TEMPLATE_DIR}/AGENTS.${role}.md`)
    ? `AGENTS.${role}.md`
    : "AGENTS.worker.md";

  const vars = {
    NAME: name,
    ID: id,
    EMOJI: emoji,
    ROLE: role,
    ROLE_TITLE: playbook?.title || (role === "worker" ? "Worker hero" : role),
    ORCH_ID: orchId,
    ORCH_NOTE: isOrchestrator ? " — that is me" : " — my boss; orchestration goes to it",
    REPO: repo,
    WORKSPACE: ws,
    SKILLS: skills.join(", "),
    REPORT_CMD: playbook?.reportCmd || "",
    CYCLE_CMD: playbook?.cycleCmd || "",
    WATCH_CMD: playbook?.watchCmd || "",
    VERIFY_CMD: playbook?.verifyCmd || "",
    VERIFY_WINDOW: playbook?.verifyWindow || "",
  };
  vars.COMMON = renderTemplate("AGENTS.common.md", vars).trim();

  const stamp = (tpl) =>
    `<!-- generated by scripts/openclaw-fleet.mjs sync from config/openclaw/templates/${tpl}; edit the template, not this file -->\n`;
  writeFileSync(`${ws}/AGENTS.md`, stamp(agentsTemplate) + renderTemplate(agentsTemplate, vars));
  writeFileSync(`${ws}/SOUL.md`, stamp("SOUL.md") + renderTemplate("SOUL.md", vars));
  writeFileSync(`${ws}/IDENTITY.md`, stamp("IDENTITY.md") + renderTemplate("IDENTITY.md", vars));
  // USER.md is Julius, the same for every hero: the repo root file is the source.
  writeFileSync(`${ws}/USER.md`, readFileSync(`${ROOT}/USER.md`, "utf8"));

  // Relative links so the tree works on the MBP, the iMac and inside a bind mount.
  const up = "../../../..";
  ensureSymlink(`${ws}/repo`, up);
  if (isOrchestrator) ensureSymlink(`${ws}/memory`, `${up}/memory`);
  else mkdirSync(`${ws}/memory`, { recursive: true });

  const { copied, missing } = copySkills(ws, skills);
  return { ws, role, template: agentsTemplate, skills, copiedSkills: copied, missingSkills: missing };
}

/** agentDir is OpenClaw STATE (auth profiles, sessions). It never reads a prompt from here. */
function writeAgentStateDir(id, wsDir) {
  const dir = `${fleetWorkspace()}/config/openclaw/agents/${id}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    `${dir}/AGENTS.md`,
    [
      `OpenClaw agentDir for ${id}: auth profiles, model registry, sessions.`,
      "OpenClaw does NOT read a prompt from this directory.",
      `The live persona is ${wsDir}/AGENTS.md, rendered from config/openclaw/templates/`,
      "by scripts/openclaw-fleet.mjs sync. Edit the templates, then sync.",
      "",
    ].join("\n"),
  );
  return dir;
}

function buildEntry(hero, { isOrchestrator, orchId }) {
  const id = heroToAgentId(hero.id);
  const name =
    hero.name ||
    (isOrchestrator ? "Gotchi" : String(hero.collateral || id).toUpperCase());
  const emoji = isOrchestrator ? "👻" : collateralEmoji(hero.collateral);
  const rendered = writeHeroWorkspace(hero, { id, name, emoji, isOrchestrator, orchId });
  const agentDir = writeAgentStateDir(id, rendered.ws);
  const entry = {
    identity: { name, emoji },
    workspace: rendered.ws,
    agentDir,
    skills: rendered.skills,
    // Fleet heroes work the HOST: tmux windows on the desktop, docker, the Claude
    // CLI (login keychain), launchagents. A sandbox container has none of that and
    // mounts only the workspace, so a hero under agents.defaults.sandbox.mode=all
    // cannot run a single row of its AGENTS.md. Per-agent beats defaults.
    sandbox: { mode: "off" },
  };
  if (isOrchestrator) {
    entry.default = true;
    entry.groupChat = { mentionPatterns: ["@gotchi", "@Gotchi", "gotchi"] };
  }
  return { id, entry, rendered };
}

async function loadHeroes() {
  const meta = loadMeta();
  let heroes = [];
  if (meta?.cartridgeId) {
    try {
      heroes = await fetchCartridgeHeroes(meta.cartridgeId);
    } catch {
      heroes = [];
    }
  }
  if (heroes.length) return heroes;
  // Cartridge API down: keep the last generated roster instead of shrinking the
  // fleet to the orchestrator alone (which silently deleted every other hero's entry).
  const last = readGeneratedJson(FLEET_LIST, []);
  if (Array.isArray(last) && last.length) {
    console.error(`openclaw-fleet: cartridge heroes unavailable — reusing ${last.length} ids from ${FLEET_LIST}`);
    return last
      .filter((e) => e?.id && !e.aliasOf && e.id !== "gotchi")
      .map((e) => ({ id: e.id, name: e.identity?.name || null, bindType: null }));
  }
  const orch = orchestratorHeroId();
  return orch ? [{ id: orch, name: "Gotchi", bindType: "owned" }] : [];
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

/**
 * Rewrite a generated file only when it actually changed. The header carries a
 * generation timestamp, so a plain write dirties these tracked config files on
 * every sync — i.e. on nearly every gotchibot invocation — which buries real
 * fleet changes in timestamp churn and makes `git status` lie about the tree.
 */
function writeGenerated(path, contents) {
  const withoutStamp = (s) => String(s).replace(/^\/\/ Generated: .*$/m, "");
  try {
    if (withoutStamp(readFileSync(path, "utf8")) === withoutStamp(contents)) return false;
  } catch {
    /* no previous file — write it */
  }
  writeFileSync(path, contents);
  return true;
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

  writeGenerated(FLEET_ENTRIES, `${header}${JSON.stringify(configEntries, null, 2)}\n`);
  writeGenerated(FLEET_LIST, `${header}${JSON.stringify(list, null, 2)}\n`);

  mkdirSync(`${homedir()}/.openclaw`, { recursive: true });
  const homeFleetEntries = `${homedir()}/.openclaw/gotchibot-fleet.entries.json5`;
  const homeFleetList = `${homedir()}/.openclaw/gotchibot-fleet.list.json5`;
  writeGenerated(homeFleetEntries, `${header}${JSON.stringify(configEntries, null, 2)}\n`);
  writeGenerated(homeFleetList, `${header}${JSON.stringify(list, null, 2)}\n`);

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

  const rendered = {};
  for (const hero of heroes) {
    const isOrchestrator = hero.id === orchId;
    const { id, entry, rendered: r } = buildEntry(hero, { isOrchestrator, orchId });
    entries[id] = entry;
    rendered[id] = r;
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
    const { id, entry, rendered: r } = buildEntry(
      { id: orchId, name: "Gotchi", bindType: "owned" },
      { isOrchestrator: true, orchId },
    );
    entries[id] = entry;
    rendered[id] = r;
    map[id] = { heroId: orchId, isOrchestrator: true, status: "available" };
  }

  // Backward-compat alias: openclaw agent --agent gotchi → orchestrator hero.
  const orchAgentId = heroToAgentId(orchId);
  if (entries[orchAgentId] && orchAgentId !== "gotchi") {
    const { default: _orchDefault, ...orchRest } = entries[orchAgentId];
    // Same workspace (same persona), its own agentDir (OpenClaw forbids sharing state dirs).
    const aliasDir = writeAgentStateDir("gotchi", orchRest.workspace);
    entries.gotchi = { ...orchRest, agentDir: aliasDir };
    map.gotchi = { ...map[orchAgentId], aliasOf: orchAgentId, isOrchestrator: true };
  }

  writeFleetArtifacts({ entries, map, orchId });

  const doctor = doctorFleet({ entries });
  const payload = {
    ok: doctor.ok,
    orchestratorHeroId: orchId,
    orchestratorAgentId: orchAgentId,
    count: Object.keys(entries).length,
    agents: Object.keys(entries),
    fleetConfig: FLEET_ENTRIES,
    installSnippet: INSTALL_SNIPPET,
    workspaces: heroWorkspaceRoot(),
    problems: doctor.problems,
  };
  if (!quiet) {
    console.log(`openclaw fleet synced → ${payload.count} agents`);
    console.log(`  config: ${FLEET_ENTRIES}`);
    console.log(`  workspaces: ${payload.workspaces}`);
    for (const id of payload.agents) {
      const m = map[id];
      const r = rendered[id];
      const tag = m?.isOrchestrator ? "orch" : "sub";
      const alias = m?.aliasOf ? ` (alias → ${m.aliasOf})` : "";
      const role = r ? ` role=${r.role} skills=${r.copiedSkills.length}` : "";
      console.log(`  · ${id} [${tag}]${alias}${role}`);
    }
  }
  if (doctor.problems.length) {
    console.error(`openclaw-fleet doctor: ${doctor.problems.length} problem(s) — run ./scripts/openclaw-fleet.mjs doctor`);
    for (const p of doctor.problems) console.error(`  ✗ ${p}`);
  }
  return payload;
}

/**
 * Prove every hero can actually follow its prompt: workspace files present and
 * under OpenClaw's bootstrap caps, no unresolved placeholders, every allowed skill
 * really copied with a matching frontmatter name, every `./scripts/<file>` the
 * prompt names really on disk. Silent versions of all four are how the fleet ran
 * blind for three days.
 */
export function doctorFleet({ entries } = {}) {
  const cfgEntries = entries || readGeneratedJson(FLEET_ENTRIES, null);
  const problems = [];
  const checks = [];
  const repo = fleetWorkspace();
  if (!cfgEntries || !Object.keys(cfgEntries).length) {
    problems.push(`no fleet entries at ${FLEET_ENTRIES} — run sync`);
    return { ok: false, problems, checks };
  }
  // Effective sandbox mode on THIS host: per-agent entry, else the gateway's
  // agents.defaults (read from the live ~/.openclaw/openclaw.json when present).
  const liveCfg = readJsonFile(`${homedir()}/.openclaw/openclaw.json`, null);
  const defaultSandbox = liveCfg?.agents?.defaults?.sandbox?.mode;
  if (defaultSandbox) checks.push(`gateway agents.defaults.sandbox.mode=${defaultSandbox}`);
  const skillName = (file) => {
    try {
      const m = readFileSync(file, "utf8").match(/^name:\s*(.+?)\s*$/m);
      return m ? m[1].replace(/^["']|["']$/g, "") : null;
    } catch {
      return null;
    }
  };
  for (const [id, e] of Object.entries(cfgEntries)) {
    const ws = e.workspace;
    if (!ws || !existsSync(ws)) {
      problems.push(`${id}: workspace missing (${ws})`);
      continue;
    }
    if (!e.agentDir || !existsSync(e.agentDir)) problems.push(`${id}: agentDir missing (${e.agentDir})`);
    const mode = e.sandbox?.mode || defaultSandbox || "off";
    if (mode === "all")
      problems.push(`${id}: effective sandbox mode is "all" — tools run in a container without the repo, tmux, docker or the Claude CLI; set agents.entries.${id}.sandbox.mode to "off"`);
    let total = 0;
    for (const f of BOOTSTRAP_FILES) {
      const p = `${ws}/${f}`;
      if (!existsSync(p)) {
        problems.push(`${id}: ${f} missing`);
        continue;
      }
      const body = readFileSync(p, "utf8");
      total += body.length;
      if (body.length > BOOTSTRAP_MAX_CHARS)
        problems.push(`${id}: ${f} is ${body.length} chars; OpenClaw truncates at ${BOOTSTRAP_MAX_CHARS}`);
      const left = body.match(/\{\{[A-Z_]+\}\}/g);
      if (left) problems.push(`${id}: ${f} has unresolved placeholders ${[...new Set(left)].join(" ")}`);
      checks.push(`${id}: ${f} ${body.length} chars`);
    }
    if (total > BOOTSTRAP_TOTAL_MAX_CHARS)
      problems.push(`${id}: bootstrap total ${total} chars exceeds ${BOOTSTRAP_TOTAL_MAX_CHARS}`);
    for (const sk of e.skills || []) {
      const file = `${ws}/skills/${sk}/SKILL.md`;
      if (!existsSync(file)) {
        problems.push(`${id}: skill "${sk}" not in ${ws}/skills (source .opencode/skills/${sk}/SKILL.md ${existsSync(`${OPENCODE_SKILLS}/${sk}/SKILL.md`) ? "exists — resync" : "does not exist"})`);
        continue;
      }
      const n = skillName(file);
      if (n !== sk) problems.push(`${id}: skill dir "${sk}" but SKILL.md name is "${n}" — OpenClaw matches on name`);
    }
    try {
      const agents = readFileSync(`${ws}/AGENTS.md`, "utf8");
      const seen = new Set();
      for (const m of agents.matchAll(/\.\/scripts\/([\w./-]+)/g)) {
        const rel = m[1].replace(/[.,;:]+$/, "");
        if (seen.has(rel)) continue;
        seen.add(rel);
        if (!existsSync(`${repo}/scripts/${rel}`)) problems.push(`${id}: AGENTS.md names ./scripts/${rel} which does not exist`);
      }
      for (const m of agents.matchAll(/skill `([\w-]+)`/g)) {
        if (!(e.skills || []).includes(m[1])) problems.push(`${id}: AGENTS.md tells it to read skill "${m[1]}" but that skill is not in its allowlist`);
      }
    } catch {
      /* reported above */
    }
    try {
      const st = lstatSync(`${ws}/repo`);
      if (!st.isSymbolicLink()) problems.push(`${id}: ${ws}/repo is not a symlink`);
    } catch {
      problems.push(`${id}: ${ws}/repo symlink missing`);
    }
  }
  return { ok: problems.length === 0, problems, checks };
}

/**
 * One real prompt through the gateway per target (orchestrator + focused sub hero
 * when different), on a dedicated probe session so main chat history stays clean.
 * The only check that catches a dead model key behind a healthy gateway.
 */
export async function doctorLive() {
  const map = loadAgentMap();
  const orchId = map?.orchestratorAgentId || heroToAgentId(orchestratorHeroId());
  const focused = (() => {
    try {
      return resolveOpenClawTuiAgentId();
    } catch {
      return orchId;
    }
  })();
  const targets = [...new Set([orchId, focused].filter(Boolean))];
  const out = [];
  for (const agentId of targets) {
    if (!(await gatewayReachable())) {
      out.push({ agentId, ok: false, error: `gateway unreachable at ${gatewayUrl()}` });
      continue;
    }
    const r = await chatViaHttp(agentId, "Reply with the single word: pong", {
      sessionKey: `agent:${agentId}:probe`,
      timeoutMs: 90_000,
    });
    if (r.ok) out.push({ agentId, ok: true, reply: String(r.stdout || "").trim() });
    else {
      let detail = r.reason || "unknown";
      try {
        const j = JSON.parse(r.stdout || "");
        detail = j?.error?.message ? `${r.reason}: ${j.error.message}` : detail;
      } catch {
        if (r.stdout) detail = `${detail}: ${String(r.stdout).slice(0, 160)}`;
      }
      out.push({ agentId, ok: false, error: detail });
    }
  }
  return out;
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
    // Tailscale cold path to the iMac has measured 7s on the first hit; 2.5s
    // reported a healthy gateway as unreachable and blocked every sub chat.
    const t = setTimeout(() => ac.abort(), 8000);
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
export async function chatViaHttp(agentId, message, { timeoutMs = 240_000, sessionKey } = {}) {
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
      // Name the provider failure so a hero's "no reply" is never a mystery again:
      // 401 = dead model key on the Hub, 429/402 = model rate-limited or out of quota.
      let detail = "";
      try {
        detail = JSON.parse(raw)?.error?.message || "";
      } catch {
        detail = String(raw || "").slice(0, 160);
      }
      const label =
        r.status === 401 ? "model-auth" : r.status === 429 || r.status === 402 ? "rate-limited" : `http-${r.status}`;
      return { ok: false, reason: detail ? `${label}: ${detail}` : label, status: r.status, stdout: raw, sessionKey: key };
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

  // HTTP first: it is the path the Hub actually serves, and a provider error it
  // returns (401 dead key, 429 rate limit) is FINAL — retrying through the CLI only
  // burns minutes. The CLI is a fallback for transport failures only, and on this
  // Desk it currently fails config validation before it even connects.
  const key = sessionKey || tuiSessionKey(agentId);
  const http = await chatViaHttp(agentId, message, { sessionKey: key });
  if (http.ok) return http;
  if (http.status) return http; // the gateway answered; nothing the CLI can add
  const bin = findOpenclawBin();
  if (bin) {
    const cli = runAgentTurn(agentId, message, { json, sessionKey: key });
    if (cli.ok) return { ...cli, via: "cli" };
    return { ...cli, reason: `${http.reason}; cli=${cli.reason}` };
  }
  return http;
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
  if (cmd === "doctor") {
    const r = doctorFleet();
    if (rest.includes("--live")) {
      const live = await doctorLive();
      r.live = live;
      for (const l of live) {
        if (l.ok) r.checks.push(`live ${l.agentId}: replied "${l.reply.slice(0, 40)}"`);
        else r.problems.push(`live ${l.agentId}: no working model — ${l.error}`);
      }
      r.ok = r.problems.length === 0;
    }
    if (json) console.log(JSON.stringify(r, null, 2));
    else {
      for (const c of r.checks) console.log(`ok    ${c}`);
      for (const p of r.problems) console.log(`FAIL  ${p}`);
      console.log(r.ok ? "openclaw fleet doctor: all heroes can follow their prompts" : `openclaw fleet doctor: ${r.problems.length} problem(s)`);
    }
    process.exit(r.ok ? 0 : 1);
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
