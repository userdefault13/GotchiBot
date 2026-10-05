#!/usr/bin/env node
/**
 * OpenClaw fleet — one OpenClaw agent per cartridge cAavegotchi.
 *
 *   node scripts/openclaw-fleet.mjs sync [--json]
 *   node scripts/openclaw-fleet.mjs refresh-workspaces [--json]
 *     Re-render every on-disk hero workspace (COMMON_SKILLS etc.) without
 *     rewriting the OpenClaw fleet list — use when Sepolia nest is small but
 *     stale workspaces still need common-skill promotion.
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
import { assertTailnetHost, assertTailnetUrl } from "./tailnet-transport.mjs";
import { readTailscaleStatus } from "./tailscale-cli.mjs";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  cpSync,
  rmSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMeta } from "./identity.mjs";
import {
  fetchCartridgeHeroes,
  fetchGotchiNames,
  loadOnboarding,
  ROOT,
  SESSIONS,
} from "./onboarding-lib.mjs";
import { buildPersonaLine } from "./gotchi-persona.mjs";
import { renderHireSheet, heroTrust, AGENTS_MD_LIMIT } from "./hire-sheet.mjs";

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
  "pstack",
  "ralph",
];
/** Skills every hero gets, orchestrator or not. */
const COMMON_SKILLS = ["passoff", "desk-wake", "cursor-cli", "codex-cli", "gotchibot-bridge", "jev"];
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

/** Stable orchestrator id: exists whether or not a gotchi avatar is bound. */
export const ORCH_AGENT_ID = "orchestrator";
/** Orchestrator display name until a gotchi avatar is bound. */
export const ORCH_DEFAULT_NAME = "Orchestrator";
const ORCH_ALIASES = new Set([ORCH_AGENT_ID, "gotchi", "orch"]);

/** Hero bound as the orchestrator's avatar; null until one is chosen. */
export function orchestratorHeroId() {
  const ob = loadOnboarding();
  const meta = loadMeta();
  if (ob.orchestratorHeroId && String(ob.orchestratorHeroId).startsWith("owned-")) {
    return ob.orchestratorHeroId;
  }
  if (meta?.activeHeroId && String(meta.activeHeroId).startsWith("owned-")) {
    return meta.activeHeroId;
  }
  return ob.orchestratorHeroId || meta?.activeHeroId || null;
}

/** Bound avatar hero id, else the stable `orchestrator` id. Never empty. */
export function orchestratorId() {
  return orchestratorHeroId() || ORCH_AGENT_ID;
}

export function isOrchestratorId(id) {
  const s = String(id || "").trim();
  if (!s) return false;
  return ORCH_ALIASES.has(s) || s === orchestratorHeroId();
}

/** Bound gotchi's name, else "Orchestrator". */
export function orchestratorDisplayName() {
  const hero = orchestratorHeroId();
  const name = hero ? heroDisplayName(hero) : null;
  return name && name !== "Gotchi" ? name : ORCH_DEFAULT_NAME;
}

/**
 * Heroes that are always in the fleet without a cAavegotchi seat. Their SOUL.md /
 * IDENTITY.md come from `persona`, not the gotchi templates; AGENTS.md still
 * renders from AGENTS.<role>.md. Never spawn seats — the wallet gate seats only
 * cartridge heroes.
 */
const BUILTIN_HEROES = [
  {
    id: "prof-link-cube",
    name: "Prof. Link-Cube",
    emoji: "🧊",
    bindType: "builtin",
    persona: "config/npc/prof-link-cube",
  },
];

function builtinHero(id) {
  return BUILTIN_HEROES.find((h) => h.id === id) || null;
}

export function builtinHeroes() {
  return BUILTIN_HEROES.map((h) => ({ ...h }));
}

function collateralEmoji(collateral) {
  const c = String(collateral || "").toLowerCase();
  if (c.includes("link")) return "🔗";
  if (c.includes("aave")) return "👻";
  if (c.includes("eth")) return "💎";
  return "🤖";
}

/** Name/emoji a hero workspace was last rendered with; ignores the uppercased-id fallback. */
function readWorkspaceIdentity(dir, id) {
  try {
    const text = readFileSync(`${dir}/IDENTITY.md`, "utf8");
    const name = text.match(/^- \*\*Name:\*\* (.+)$/m)?.[1]?.trim() || null;
    const emoji = text.match(/^- \*\*Emoji:\*\* (.+)$/m)?.[1]?.trim() || null;
    return { name: name && name !== String(id).toUpperCase() ? name : null, emoji };
  } catch {
    return { name: null, emoji: null };
  }
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

/**
 * Canonical workspace path — must match the Docker bind mount on the iMac, which
 * uses a capital Dev. On a case-insensitive FS ~/dev and ~/Dev are one directory,
 * so folding is cosmetic. On a case-sensitive FS they are two directories, and
 * folding blindly points the fleet at an empty ghost tree. Only fold when the
 * folded path resolves to the same directory.
 */
export function fleetWorkspace() {
  const override = process.env.GOTCHIBOT_OPENCLAW_WORKSPACE?.trim();
  if (override) return override;
  const home = (process.env.HOME || homedir()).replace(/\/+$/, "");
  let p;
  try {
    p = realpathSync(ROOT);
  } catch {
    p = ROOT;
  }
  const dev = `${home}/dev/`;
  if (!p.toLowerCase().startsWith(dev.toLowerCase())) return p;
  const folded = `${home}/Dev/${p.slice(dev.length)}`;
  if (folded === p) return p;
  try {
    if (realpathSync(folded) === p) return folded;
  } catch {
    /* folded path does not exist — the case difference is a different directory */
  }
  if (existsSync(folded) && !fleetWorkspace.warned) {
    fleetWorkspace.warned = true;
    console.error(
      `openclaw-fleet: ${dev}GotchiBot and ${home}/Dev/GotchiBot both exist and are different directories. Using ${p}.`,
    );
  }
  return p;
}

export function heroWorkspaceRoot() {
  return `${fleetWorkspace()}/${WORKSPACE_ROOT_REL}`;
}

export function heroWorkspaceDir(agentId) {
  return `${heroWorkspaceRoot()}/${agentId}`;
}

/** Gotchi name the fleet sync rendered into the hero's IDENTITY.md; null when none. */
export function heroDisplayName(heroId) {
  if (!heroId) return null;
  return readWorkspaceIdentity(heroWorkspaceDir(heroToAgentId(heroId)), heroId).name;
}

function renderTemplate(file, vars) {
  const src = readFileSync(`${TEMPLATE_DIR}/${file}`, "utf8");
  return src.replace(/\{\{([A-Z_]+)\}\}/g, (m, key) =>
    Object.hasOwn(vars, key) ? String(vars[key] ?? "") : m,
  );
}

function loadStandingDuties() {
  return readJsonFile(`${ROOT}/config/agent-standing-duties.json`, {}) || {};
}

function heroSkillNames({ playbook, isOrchestrator, standing }) {
  const fromRole = Array.isArray(playbook?.skills) ? playbook.skills : [];
  const fromStanding = Array.isArray(standing?.skills) ? standing.skills : [];
  const base = isOrchestrator ? ORCH_SKILLS : ["browser-tool"];
  return [...new Set([...fromRole, ...fromStanding, ...base, ...COMMON_SKILLS])];
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
  // Per-hero standing duty (config/agent-standing-duties.json) rides on top of
  // the role: extra skills + a rendered AGENTS.md section. Lets a hero keep an
  // old desk (e.g. trader monitor) after a rehatch to a new role.
  const standing = loadStandingDuties()[id] || null;
  // Role-bound orchestrators (config/agent-roles.json) still
  // need the full orch skill pack — desk pin alone must not strip them.
  const orchSkills = isOrchestrator || role === "orchestrator";
  const skills = heroSkillNames({ playbook, isOrchestrator: orchSkills, standing });
  const agentsTemplate = existsSync(`${TEMPLATE_DIR}/AGENTS.${role}.md`)
    ? `AGENTS.${role}.md`
    : "AGENTS.worker.md";

  const vars = {
    NAME: name,
    ID: id,
    EMOJI: emoji,
    ROLE: role,
    ROLE_TITLE: playbook?.title || (role === "worker" ? "Worker hero" : role),
    PERSONA: buildPersonaLine({ ...hero, name }),
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
    STANDING_DUTY: standing?.markdown
      ? `## ${standing.label || "Standing duty"}\n\n${standing.markdown}`
      : "",
  };
  vars.HIRE = renderHireSheet({
    roleId: role,
    playbook,
    trust: heroTrust(id),
    isOrchestrator: orchSkills,
    orchId,
  });
  vars.COMMON = renderTemplate("AGENTS.common.md", vars).trim();

  const stamp = (tpl) =>
    `<!-- generated by scripts/openclaw-fleet.mjs sync from config/openclaw/templates/${tpl}; edit the template, not this file -->\n`;
  let agentsBody = stamp(agentsTemplate) + renderTemplate(agentsTemplate, vars);
  // OpenClaw cuts AGENTS.md at 20000 chars — right through the shared rules at
  // the end. A full probation sheet on a big role can push it over; squeeze it.
  if (agentsBody.length > AGENTS_MD_LIMIT - 200 && vars.HIRE.includes("Trust: probation")) {
    vars.HIRE = renderHireSheet({ roleId: role, playbook, trust: "probation", orchId, compact: true });
    vars.COMMON = renderTemplate("AGENTS.common.md", vars).trim();
    agentsBody = stamp(agentsTemplate) + renderTemplate(agentsTemplate, vars);
  }
  writeFileSync(`${ws}/AGENTS.md`, agentsBody);
  const persona = hero.persona ? `${ROOT}/${hero.persona}` : null;
  for (const file of ["SOUL.md", "IDENTITY.md"]) {
    const own = persona && existsSync(`${persona}/${file}`) ? `${persona}/${file}` : null;
    const body = own
      ? `<!-- copied by scripts/openclaw-fleet.mjs sync from ${hero.persona}/${file}; edit that file, not this one -->\n${readFileSync(own, "utf8")}`
      : stamp(file) + renderTemplate(file, vars);
    writeFileSync(`${ws}/${file}`, body);
  }
  // USER.md is UserDefault, the same for every hero: the repo root file is the source.
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
    (isOrchestrator ? ORCH_DEFAULT_NAME : String(hero.collateral || id).toUpperCase());
  const emoji = isOrchestrator ? "👻" : hero.emoji || collateralEmoji(hero.collateral);
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

function heroTokenId(hero) {
  const tok = hero?.sourceTokenId || String(hero?.id || "").match(/^(?:owned|rental)-(\d+)$/)?.[1];
  return tok ? String(tok) : null;
}

/** tokenId → gotchi name from the core subgraph; empty map when unreachable. */
async function gotchiNamesFor(heroes) {
  try {
    return await fetchGotchiNames(heroes.map(heroTokenId).filter(Boolean));
  } catch {
    return new Map();
  }
}

async function loadHeroes() {
  const meta = loadMeta();
  let heroes = [];

  // Base Sepolia nest heroes for the desk owner.
  if (meta?.owner && meta?.cartridgeId) {
    try {
      // Hero objects, not raw bytes32 keys: owned/rented keys map back to `owned-<tokenId>`.
      const { readSepoliaHeroesForOwner } = await import("./cartridge-sepolia.mjs");
      const sep = await readSepoliaHeroesForOwner(String(meta.owner).toLowerCase());
      if (sep.cartridgeId && String(sep.cartridgeId) === String(meta.cartridgeId)) {
        heroes = (sep.heroes || []).map((h) => ({
          id: String(h.id),
          name: null,
          bindType: h.bindType || null,
          sourceTokenId: h.sourceTokenId || null,
        }));
      }
    } catch {
      heroes = [];
    }
    if (heroes.length) return heroes;
    // Empty on-chain roster is normal for desk-pin orch — don't reuse stale 29-id fleet.
    const orch = orchestratorHeroId() || meta.activeHeroId || null;
    if (orch) return [{ id: String(orch), name: null, bindType: "desk" }];
    return [];
  }

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
      .filter((e) => e?.id && !e.aliasOf && !ORCH_ALIASES.has(e.id))
      .map((e) => ({ id: e.id, name: e.identity?.name || null, bindType: null }));
  }
  const orch = orchestratorHeroId();
  return orch ? [{ id: orch, name: null, bindType: "owned" }] : [];
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
    // Explicit multi-agent ownership is configured on the fleet fragment;
    // keep the legacy default marker out of agents.entries.
    delete rest.default;
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
        orchestratorHeroId: orchestratorHeroId(),
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
      ownership: "explicit",
      defaults: {
        $include: `${ROOT}/config/openclaw.gotchi.json5`,
        systemAgent: { agentId: orchId },
      },
      entries: { $include: FLEET_ENTRIES },
    },
  };
  writeFileSync(INSTALL_SNIPPET, `${JSON.stringify(install, null, 2)}\n`);
}

export async function syncFleet({ quiet = false } = {}) {
  const loadedHeroes = await loadHeroes();
  const heroes = [
    ...loadedHeroes,
    ...BUILTIN_HEROES.filter((b) => !loadedHeroes.some((h) => h.id === b.id)),
  ];
  const orchId = orchestratorHeroId();
  const entries = {};
  const map = {};

  const rendered = {};
  const gotchiNames = await gotchiNamesFor(heroes);
  for (const loaded of heroes) {
    const hero = { ...loaded, name: gotchiNames.get(heroTokenId(loaded)) || loaded.name };
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

  const orchAgentId = heroToAgentId(orchestratorId());
  if (!entries[orchAgentId]) {
    const { id, entry, rendered: r } = buildEntry(
      { id: orchAgentId, name: orchId ? null : ORCH_DEFAULT_NAME, bindType: orchId ? "owned" : null },
      { isOrchestrator: true, orchId: orchAgentId },
    );
    entries[id] = entry;
    rendered[id] = r;
    map[id] = { heroId: orchId, isOrchestrator: true, status: "available" };
  }

  // `orchestrator` (stable) and `gotchi` (legacy) both reach the orchestrator.
  for (const alias of [ORCH_AGENT_ID, "gotchi"]) {
    if (alias === orchAgentId) continue;
    const { default: _orchDefault, ...orchRest } = entries[orchAgentId];
    // Same workspace (same persona), its own agentDir (OpenClaw forbids sharing state dirs).
    const aliasDir = writeAgentStateDir(alias, orchRest.workspace);
    entries[alias] = { ...orchRest, agentDir: aliasDir };
    map[alias] = { ...map[orchAgentId], aliasOf: orchAgentId, isOrchestrator: true };
  }

  writeFleetArtifacts({ entries, map, orchId: orchAgentId });

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
 * Re-render every hero workspace that already exists on disk.
 * Does NOT rewrite fleet.list / fleet.generated — Sepolia nest stays nest-sized.
 * Use after COMMON_SKILLS (or templates) change so every gotchi gets the update.
 */
export async function refreshAllWorkspaces({ quiet = false } = {}) {
  const root = heroWorkspaceRoot();
  const orchId = orchestratorId();
  const last = readGeneratedJson(FLEET_LIST, []);
  const byId = new Map();
  if (Array.isArray(last)) {
    for (const e of last) {
      if (!e?.id || e.aliasOf || (ORCH_ALIASES.has(e.id) && e.id !== orchestratorId())) continue;
      byId.set(e.id, {
        id: e.id,
        name: e.identity?.name || null,
        collateral: null,
        bindType: null,
      });
    }
  }

  let ids = [];
  try {
    ids = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((id) => existsSync(`${root}/${id}/AGENTS.md`))
      .sort();
  } catch {
    ids = [];
  }

  const rendered = {};
  const gotchiNames = await gotchiNamesFor(ids.map((id) => ({ id })));
  for (const id of ids) {
    const hero = builtinHero(id) || byId.get(id) || { id, name: null, bindType: null };
    const isOrchestrator = id === orchId;
    // The fleet list is nest-sized on Sepolia, so most heroes are missing from
    // it; without a subgraph name, keep the one already rendered on disk.
    const onDisk = readWorkspaceIdentity(`${root}/${id}`, id);
    const listName = hero.name && hero.name !== id.toUpperCase() ? hero.name : null;
    const name =
      gotchiNames.get(heroTokenId({ id })) ||
      onDisk.name ||
      listName ||
      (isOrchestrator ? ORCH_DEFAULT_NAME : String(hero.collateral || id).toUpperCase());
    const emoji = isOrchestrator ? "👻" : hero.emoji || onDisk.emoji || collateralEmoji(hero.collateral);
    const r = writeHeroWorkspace(
      { ...hero, id },
      { id, name, emoji, isOrchestrator, orchId },
    );
    writeAgentStateDir(id, r.ws);
    rendered[id] = r;
  }

  const withJev = Object.entries(rendered).filter(([, r]) =>
    (r.skills || []).includes("jev"),
  ).length;
  const payload = {
    ok: true,
    count: ids.length,
    withJev,
    commonSkills: COMMON_SKILLS,
    agents: ids,
    workspaces: root,
    fleetListUntouched: true,
  };
  if (!quiet) {
    console.log(
      `openclaw workspaces refreshed → ${payload.count} dirs (jev on ${withJev}; fleet list untouched)`,
    );
    for (const id of ids) {
      const r = rendered[id];
      const tag = id === orchId ? "orch" : "sub";
      console.log(`  · ${id} [${tag}] role=${r.role} skills=${r.copiedSkills.length}`);
    }
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
  // A wrong root makes every script reference look missing. Say it once, not per file.
  if (!existsSync(`${repo}/scripts`)) {
    problems.push(
      `fleet root ${repo} has no scripts/ — heroes would be rendered against a tree that is not the repo`,
    );
    return { ok: false, problems, checks };
  }
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
  // Fleet files store absolute paths, so a copy committed on one machine points
  // at the other machine's tree. Rebase them onto this repo before checking.
  const rebase = (p) => {
    const i = String(p || "").indexOf("/config/openclaw/");
    return i > 0 ? `${repo}${p.slice(i)}` : p;
  };
  for (const [id, e] of Object.entries(cfgEntries)) {
    const ws = rebase(e.workspace);
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
  const orchId = map?.orchestratorAgentId || heroToAgentId(orchestratorId());
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
    map?.orchestratorAgentId || heroToAgentId(orchestratorId());

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
  const mode = isOrchestratorId(heroId) ? "orch" : "sub";
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
  let h =
    host?.trim() ||
    process.env.REMOTE_HOST?.trim() ||
    process.env.GOTCHIBOT_REMOTE_HOST?.trim() ||
    process.env.GOTCHIBOT_OPENCLAW_HOST?.trim();
  if (!h) throw new Error("need host (arg or REMOTE_HOST)");
  h = assertTailnetHost(h, { local: true, status: () => readTailscaleStatus().json });
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
  if (raw) return assertTailnetUrl(raw.replace(/\/$/, ""), { local: true, status: () => readTailscaleStatus().json });
  const file = loadGatewayConfig();
  if (file?.url) return assertTailnetUrl(String(file.url).replace(/\/$/, ""), { local: true, status: () => readTailscaleStatus().json });
  const port = process.env.OPENCLAW_GATEWAY_PORT || process.env.GOTCHIBOT_OPENCLAW_PORT || "18789";
  const host = process.env.GOTCHIBOT_OPENCLAW_HOST || "127.0.0.1";
  return assertTailnetUrl(`http://${host}:${port}`, { local: true, status: () => readTailscaleStatus().json });
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

const HUB_SSH_TARGET_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/;

/** First DNS label. imacOmarchy and imacomarchy.tail….ts.net are the same machine. */
export function shortHostName(host) {
  const s = String(host || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/\.local$/, "");
  return s ? s.split(".")[0] : "";
}

/** Loopback port the gateway actually binds. Never a Tailscale address. */
export function gatewayListenPort(url = gatewayUrl()) {
  try {
    const u = new URL(url);
    if (u.port && /^\d+$/.test(u.port)) return u.port;
  } catch {
    /* fall through */
  }
  const env = String(
    process.env.OPENCLAW_GATEWAY_PORT || process.env.GOTCHIBOT_OPENCLAW_PORT || "18789",
  );
  return /^\d+$/.test(env) ? env : "18789";
}

function hubDeskSshTarget() {
  const fromEnv = String(process.env.GOTCHIBOT_HUB_SSH || "").trim();
  if (HUB_SSH_TARGET_RE.test(fromEnv)) return fromEnv;
  try {
    const prefs = JSON.parse(readFileSync(`${SESSIONS}/.hub-desk.json`, "utf8"));
    const ssh = String(prefs?.ssh || "").trim();
    if (HUB_SSH_TARGET_RE.test(ssh)) return ssh;
  } catch {
    /* no desk ssh target */
  }
  return "";
}

/** How a status probe reaches the hub. Host comes from remote config or the desk ssh target. */
export function hubHealthRoute(cfg) {
  if (cfg?.host && cfg?.user && cfg?.key) {
    return { kind: "remote-lib", host: String(cfg.host), cfg };
  }
  const desk = hubDeskSshTarget();
  if (desk) {
    return { kind: "ssh", host: desk.slice(desk.lastIndexOf("@") + 1), target: desk };
  }
  if (cfg?.host && cfg?.user && HUB_SSH_TARGET_RE.test(`${cfg.user}@${cfg.host}`)) {
    return { kind: "ssh", host: String(cfg.host), target: `${cfg.user}@${cfg.host}` };
  }
  return { kind: "none", host: cfg?.host ? String(cfg.host) : "", target: "" };
}

function remoteHealthScript(port) {
  return (
    `code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 ` +
    `http://127.0.0.1:${port}/healthz 2>/dev/null || true); printf 'OC_HEALTHZ:%s\\n' "$code"`
  );
}

/** true / false from an OC_HEALTHZ marker, or null when the marker never arrived. */
export function parseHubHealthMarker(stdout) {
  const text = String(stdout || "");
  const m = text.match(/OC_HEALTHZ:([0-9]{3})/);
  if (m) return /^2\d\d$/.test(m[1]);
  if (/OC_HEALTHZ:\s*$/m.test(text)) return false;
  return null;
}

async function probeLoopbackHealth(url) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 2500);
    const r = await fetch(url, { signal: ac.signal });
    clearTimeout(t);
    return r.ok ? true : false;
  } catch {
    return null;
  }
}

async function execHubHealth(port) {
  const { remoteConfig, materializeKey, runSsh } = await import("./remote-lib.mjs");
  const route = hubHealthRoute(remoteConfig());
  if (route.kind === "none") {
    const err = new Error("no-hub-ssh-target");
    err.code = "NO_HUB_SSH";
    throw err;
  }
  const script = remoteHealthScript(port);
  if (route.kind === "remote-lib") {
    const key = materializeKey(route.cfg.key);
    try {
      const r = runSsh(route.cfg, key.path, script, { stdio: "pipe", timeout: 12_000 });
      if (r.error) throw r.error;
      return String(r.stdout || "");
    } finally {
      key.dispose();
    }
  }
  const r = spawnSync(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=5",
      "-o",
      "StrictHostKeyChecking=accept-new",
      route.target,
      script,
    ],
    { encoding: "utf8", timeout: 12_000 },
  );
  if (r.error) throw r.error;
  return String(r.stdout || "");
}

/**
 * Status-bar gateway probe. Chat keeps gatewayReachable().
 * Local /healthz when this machine is the gateway. Otherwise SSH to the hub
 * target the desk already has and curl 127.0.0.1 there (the gateway is not
 * bound on Tailscale). null means the remote check could not be made.
 */
export async function statusGatewayReachable(opts = {}) {
  const port = opts.port != null ? String(opts.port) : gatewayListenPort();
  if (!/^\d+$/.test(port)) return null;

  const probeLocal = opts.probeLocal || probeLoopbackHealth;
  const local = await probeLocal(`http://127.0.0.1:${port}/healthz`);
  if (local === true || local === false) return local;

  let hubHost;
  if (Object.prototype.hasOwnProperty.call(opts, "hubHost")) {
    hubHost = String(opts.hubHost ?? "");
  } else {
    const { remoteConfig } = await import("./remote-lib.mjs");
    hubHost = hubHealthRoute(remoteConfig()).host || "";
  }
  const name = opts.hostname != null ? opts.hostname : hostname();
  if (hubHost && shortHostName(name) === shortHostName(hubHost)) return false;
  if (!hubHost) return null;

  // The gateway answers over the tailnet directly. Ask it before SSH: an SSH
  // probe needs Tailscale SSH approval, and a pending approval left this "OC?"
  // even with the gateway up. Only a healthy answer is final; else fall back.
  const probeTailnet = opts.probeTailnet || probeLoopbackHealth;
  try {
    const host = hubHost.includes(":") && !hubHost.startsWith("[") ? `[${hubHost}]` : hubHost;
    if ((await probeTailnet(`http://${host}:${port}/healthz`)) === true) return true;
  } catch {
    /* fall back to SSH */
  }

  const execRemote = opts.execRemote || execHubHealth;
  try {
    return parseHubHealthMarker(await execRemote(port));
  } catch {
    return null;
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
  // GOTCHIBOT_OPENCLAW=0 is the only off switch. GOTCHIBOT_CHAT_RUNTIME says which
  // UI the chat pane runs (chat-pane.sh exports "opencode" into the pane), not
  // whether heroes on the gateway may be reached; treating it as "off" meant every
  // `agent-focus chat --sub` from inside the gotchi pane failed with
  // openclaw-disabled while the same command worked from a plain shell.
  if (process.env.GOTCHIBOT_OPENCLAW === "0") return false;
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
  if (cmd === "refresh-workspaces") {
    const quietFlag = rest.includes("--quiet");
    const r = await refreshAllWorkspaces({ quiet: quietFlag || json });
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
      agentId === (map?.orchestratorAgentId || heroToAgentId(orchestratorId()))
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
    const r = await switchOpenClawAgent(orchestratorId());
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
    let agentId = loadOpenClawFocus()?.agentId || heroToAgentId(orchestratorId());
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
  openclaw-fleet.mjs refresh-workspaces [--json] [--quiet]
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
