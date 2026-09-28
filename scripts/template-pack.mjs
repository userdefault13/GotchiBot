#!/usr/bin/env node
/**
 * template-pack.mjs — GotchiBot bot-template marketplace CLI (Prof. Link-Cube).
 *
 *   node scripts/template-pack.mjs pack <roleId>            build/overwrite packs/<roleId> from live config
 *   node scripts/template-pack.mjs list [--json]            print the catalog
 *   node scripts/template-pack.mjs show <id>                print pack.json + file tree
 *   node scripts/template-pack.mjs install <id|path|url> [--yes]
 *                                                           merge playbook + AGENTS template + vendored skills
 *   node scripts/template-pack.mjs apply <id> --hero <unassigned> | --mint <collateral> [--yes] [--standing-duty <key>]
 *                                                           install if needed, then prof-link-cube resummon.
 *                                                           A template is a new cAavegotchi ($5 mint) or one
 *                                                           with no assignment; --reassign moves a seated hero.
 *
 * Pack format (full desk = C):
 *   templates/marketplace/packs/<id>/
 *     pack.json      id, roleId, version, title, summary, skills[], skillsExternal[],
 *                    standingDuties[], cronHints[], tags[], downloadPath, files[]
 *     playbook.json  single-role playbook object (copy from config/agent-role-playbooks.json[roleId])
 *     AGENTS.md      from config/openclaw/templates/AGENTS.<role>.md
 *     skills/<name>/SKILL.md   vendored GotchiBot-owned skills
 *     standing-duties/<key>.md only if the pack declares keys
 *     cron-hints.md  from playbook autonomy + scheduleCmd / cron402 patterns
 *
 * No npm install. No auto-mint (spawning still requires a cAavegotchi on the
 * cartridge — the wallet gate). No secrets.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const MARKET = join(ROOT, "templates", "marketplace");
const PACKS = join(MARKET, "packs");
const CATALOG = join(MARKET, "catalog.json");
const WEB = join(MARKET, "web", "index.html");
const PLAYBOOKS_FILE = join(ROOT, "config", "agent-role-playbooks.json");
const ROLES_FILE = join(ROOT, "config", "agent-roles.json");
const TEMPLATE_DIR = join(ROOT, "config", "openclaw", "templates");
const OPENCODE_SKILLS = join(ROOT, ".opencode", "skills");
const CURSOR_SKILLS = join(ROOT, ".cursor", "skills");
const REGISTRY_FILE = join(ROOT, "skills", "registry.json");
const STANDING_DUTIES_FILE = join(ROOT, "config", "agent-standing-duties.json");
const TMP = join(ROOT, "tmp", "template-pack");

const VERSION = "1.0.0";
/** Public marketplace origin (Vercel / aarcadeghst.com). Home tunnel aliases still work as fallback. */
const BASE_URL = "https://aarcadeghst.com/gotchibot-templates";
const REMOTE_CATALOG_URL =
  process.env.GOTCHIBOT_TEMPLATES_CATALOG_URL || `${BASE_URL}/catalog.json`;
const REMOTE_CATALOG_FALLBACKS = [
  REMOTE_CATALOG_URL,
  "https://templates.aarcadeghst.com/catalog.json",
  "https://www.aarcadeghst.com/gotchibot-templates/catalog.json",
].filter((u, i, a) => a.indexOf(u) === i);

/** Product desk roles — standing duties owned by these heroes are never overwritten without --yes. */
const PRODUCT_DESK_ROLES = new Set([
  "trader-desk",
  "infra-monitor",
  "aarcade-comms-handler",
  "moltbook-watch",
  "orchestrator",
]);

const TAG_MAP = {
  "financial-analyst": ["analysis", "news", "trader"],
  "market-news": ["news", "headlines", "regime"],
  "market-research": ["research", "ic", "filings"],
  "infra-monitor": ["infra", "ops", "home"],
  "infra-docker": ["infra", "docker"],
  "infra-tunnel": ["infra", "tunnel"],
  "infra-hub": ["infra", "hub"],
  "infra-tailscale": ["infra", "tailscale"],
  "infra-mesh": ["infra", "mesh"],
  "infra-bridge": ["infra", "bridge"],
  "cron-manager": ["cron", "scheduler"],
  "dossier-ai-cron-site": ["cron", "dossier", "ui", "ai-cron-site"],
  "abra-vault": ["secrets", "vault"],
  "marketing-agency": ["marketing", "agency"],
  "social-media-manager": ["social", "content"],
  "fe-marketing": ["web", "design"],
  "merch-desk": ["merch", "pod", "plush", "toys", "quotes"],
  "brand-design": ["design", "brand", "kits"],
  "product-manager": ["product", "pm", "roadmap"],
  "arcade-game-monitor": ["arcade", "game", "monitor"],
  "art-director": ["art", "pixel", "studio", "brand"],
  "game-art-director": ["art", "direction", "style-guide", "prompts", "audit"],
  "security-engineer": ["security", "hardening", "vuln", "secrets", "gates"],
  "auditor": ["audit", "attestation", "controls", "review", "evidence"],
  "tool-maker": ["maker", "tool", "deterministic", "cli"],
  "skill-maker": ["maker", "skill", "skillmd", "workflow"],
  "policy-maker": ["maker", "policy", "governance", "gates"],
  "rule-maker": ["maker", "rules", "lint", "hooks", "ci"],
  "mcp-maker": ["maker", "mcp", "connector", "tools"],
  "central-bot": ["central", "makers", "routing", "orchestration-lite"],
  "roadblock-reviewer": ["review", "roadblock", "sessions", "central"],
  "worker": ["worker", "dispatch", "desk-request", "prof"],
  "customer-support": ["support", "chat", "clients"],
  "accountant": ["finance", "ap", "ar"],
  "mail-courier": ["mail", "courier", "inbox", "email", "agentmail"],
  "kanban-manager": ["kanban", "project", "boards", "tasks"],
  "bend-chief": ["bend", "crew", "routing"],
  "bend-laws": ["bend", "laws", "LAWS"],
  "bend-proofs": ["bend", "proofs", "PROOF"],
  "bend-crew": ["starter", "bend", "suite", "laws", "proofs"],
  "jev": ["starter", "typesafe", "jev", "system-one", "routing", "decisions"],
};

/**
 * Marketplace scope:
 *   starter  — portable starter templates (default browse / public offer)
 *   aarcade  — AarcadeGh-t / GotchiBot home-desk packs (opt-in)
 */
const STARTER_PACK_IDS = new Set([
  "accountant",
  "architect",
  "bend-crew",
  "brand-design",
  "customer-support",
  "game-art-director",
  "jev",
  "kanban-manager",
  "mail-courier",
  "marketing-agency",
  "product-manager",
  "social-media-manager",
]);

/** Suite packs: one catalog entry that installs/applies member role packs. */
const SUITE_PACK_MEMBERS = {
  "bend-crew": ["bend-chief", "bend-laws", "bend-proofs"],
};

export function isSuitePack(packOrId) {
  const id = typeof packOrId === "string" ? packOrId : packOrId?.id || packOrId?.roleId;
  if (packOrId && typeof packOrId === "object" && String(packOrId.kind || "").toLowerCase() === "suite") {
    return true;
  }
  return Boolean(id && SUITE_PACK_MEMBERS[id]);
}

export function suiteMembers(packOrId) {
  const id = typeof packOrId === "string" ? packOrId : packOrId?.id || packOrId?.roleId;
  if (packOrId && typeof packOrId === "object" && Array.isArray(packOrId.members)) {
    return packOrId.members.map(String);
  }
  return SUITE_PACK_MEMBERS[id] ? [...SUITE_PACK_MEMBERS[id]] : [];
}

export function resolvePackScope(packOrId) {
  const id = typeof packOrId === "string" ? packOrId : packOrId?.id || packOrId?.roleId;
  // Explicit starter roster wins over a stale scope field on disk / CDN.
  if (id && STARTER_PACK_IDS.has(id)) return "starter";
  if (packOrId && typeof packOrId === "object") {
    const s = String(packOrId.scope || "").toLowerCase();
    if (s === "aarcade") return "aarcade";
    if (s === "starter" || s === "generic") {
      // legacy/stale starter stamp — only honor if still on the roster (checked above)
      return "aarcade";
    }
    const tags = packOrId.tags || [];
    if (tags.includes("aarcade") || tags.includes("gotchibot-desk")) return "aarcade";
  }
  return "aarcade";
}

export function filterPacksByScope(packs, scope = "starter") {
  const list = Array.isArray(packs) ? packs : [];
  if (!scope || scope === "all") return list;
  return list.filter((p) => resolvePackScope(p) === scope);
}

/** Built-in standing-duty stubs (markdown). Unknown keys get a generic stub. */
const STANDING_DUTY_STUBS = {
  "trader-monitor": `# Standing duty: trader-monitor (composable)

Optional standing duty for the **financial-analyst** role. It is NOT wired by default.

What it does: on its schedule, run the gotchi-trader-monitor health query
(\`./scripts/gotchi-trader-desk.mjs status\` / the skill's query) and report the
health line — desk health only, never a trade decision.

This is a composable standing duty: it points at the existing
\`gotchi-trader-monitor\` skill + trader-desk playbook rather than requiring
hero-specific JSON. Wire it per-hero with:

\`\`\`bash
gotchibot templates apply financial-analyst --hero <hero> --standing-duty trader-monitor --yes
\`\`\`

Unwiring: remove the duty entry from config/agent-standing-duties.json (or ask
the orchestrator to).
`,
  "infra-docker": `# Standing duty: infra-docker (composable)

Optional subset of home infra. Owns Docker watched containers + watcher/verifier
loop (\`./scripts/infra-watch.mjs status --json\`, schedule truth, paper
\`infra-recover\`). Wire:

\`\`\`bash
gotchibot templates apply <role> --hero <hero> --standing-duty infra-docker --yes
\`\`\`

Or seat the full piece pack: \`gotchibot templates apply infra-docker --hero <available> --yes\`.
`,
  "infra-tunnel": `# Standing duty: infra-tunnel (composable)

Optional subset of home infra. Owns Cloudflare tunnel / public subgraph
(\`./scripts/gotchibot tunnel status\`). Wire:

\`\`\`bash
gotchibot templates apply <role> --hero <hero> --standing-duty infra-tunnel --yes
\`\`\`
`,
  "infra-hub": `# Standing duty: infra-hub (composable)

Optional subset of home infra. Owns Hub OpenClaw gateway
(\`./scripts/gotchibot hub status\`). Wire:

\`\`\`bash
gotchibot templates apply <role> --hero <hero> --standing-duty infra-hub --yes
\`\`\`
`,
  "infra-tailscale": `# Standing duty: infra-tailscale (composable)

Optional subset of home infra. Owns Tailscale path only (\`tailscale status\`,
MagicDNS / 100.x). Mesh/remote ops stay on infra-mesh. Wire:

\`\`\`bash
gotchibot templates apply <role> --hero <hero> --standing-duty infra-tailscale --yes
\`\`\`
`,
  "infra-mesh": `# Standing duty: infra-mesh (composable)

Optional subset of home infra. Owns GotchiBot agent mesh + remote Hub ops
(\`./scripts/gotchibot mesh\`). Path fail → Tailscale first. Wire:

\`\`\`bash
gotchibot templates apply <role> --hero <hero> --standing-duty infra-mesh --yes
\`\`\`
`,
  "infra-bridge": `# Standing duty: infra-bridge (composable)

Optional subset of home infra. Owns Desk→Hub Claude bridge
(\`./scripts/gotchibot bridge-ensure --json\`). Stay big-pickle. Wire:

\`\`\`bash
gotchibot templates apply <role> --hero <hero> --standing-duty infra-bridge --yes
\`\`\`
`,
};

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
}

function loadCatalog() {
  return readJson(CATALOG, { version: 1, baseUrl: BASE_URL, packs: [] });
}

/** Pull catalog from public marketplace; try Vercel path then templates.* tunnel. */
export async function fetchRemoteCatalog({ timeoutMs = 12_000 } = {}) {
  let lastErr = null;
  for (const url of REMOTE_CATALOG_FALLBACKS) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        redirect: "follow",
        signal: ac.signal,
        headers: { accept: "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ct = String(res.headers.get("content-type") || "");
      const j = await res.json();
      if (!j || !Array.isArray(j.packs)) throw new Error("catalog missing packs[]");
      // Reject SPA HTML mistaken as JSON (vercel fallback)
      if (!ct.includes("json") && typeof j.version === "undefined") {
        throw new Error("not a catalog JSON response");
      }
      const fetchedFrom = new URL(url).origin + new URL(url).pathname.replace(/\/catalog\.json$/, "");
      return {
        ...j,
        baseUrl: BASE_URL || fetchedFrom,
        source: "remote",
        fetchedAt: new Date().toISOString(),
        catalogUrl: url,
      };
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr || new Error("catalog fetch failed");
}

export async function loadCatalogPreferRemote() {
  try {
    return await fetchRemoteCatalog();
  } catch (e) {
    const local = loadCatalog();
    return {
      ...local,
      baseUrl: local.baseUrl || BASE_URL,
      source: "local",
      remoteError: String(e?.message || e),
      catalogUrl: REMOTE_CATALOG_URL,
    };
  }
}

/** CDN pack root: <baseUrl>/packs/<id>/ */
export function remotePackUrl(catalog, packId) {
  const base = String(catalog?.baseUrl || BASE_URL).replace(/\/+$/, "");
  const entry = (catalog?.packs || []).find((p) => p.id === packId || p.roleId === packId);
  const path = entry?.path || `packs/${packId}`;
  return `${base}/${String(path).replace(/^\/+/, "")}/`;
}

function saveCatalog(catalog) {
  writeJson(CATALOG, catalog);
}

function loadPlaybooks() {
  return readJson(PLAYBOOKS_FILE, {});
}

function savePlaybooks(playbooks) {
  writeJson(PLAYBOOKS_FILE, playbooks);
}

function loadRoles() {
  return readJson(ROLES_FILE, {});
}

function loadRegistry() {
  return readJson(REGISTRY_FILE, { skills: {} });
}

function loadStandingDuties() {
  return readJson(STANDING_DUTIES_FILE, { version: 1, duties: {} });
}

function isMcpOnly(name) {
  const reg = loadRegistry();
  return reg.skills?.[name]?.type === "mcp";
}

/** Find a vendorable skill dir (SKILL.md present) under the known skill roots. */
function findSkillDir(name) {
  const roots = [
    join(ROOT, "skills", name),
    join(OPENCODE_SKILLS, name),
    join(CURSOR_SKILLS, name),
  ];
  for (const root of roots) {
    if (existsSync(join(root, "SKILL.md"))) return root;
  }
  return null;
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(abs, base));
    else out.push(abs.slice(base.length + 1));
  }
  return out.sort();
}

function cronHintsFromPlaybook(playbook) {
  const hints = [];
  const autonomy = String(playbook.autonomy || "");
  if (playbook.scheduleCmd) {
    hints.push(`Schedule truth: \`${playbook.scheduleCmd}\` is the only source of truth for whether the desk's waker is loaded.`);
  }
  if (/cron402/i.test(autonomy)) {
    hints.push("cron402: webhook crons live in Gotchi-Trader config/cron402-jobs.json; status via `npm run cron402 -- status` / mcp-cron402. Never invent a cron402 job a status command does not confirm.");
  }
  if (/launchd/i.test(autonomy)) {
    hints.push("launchd: iMac LaunchAgents are installed per-desk (`gotchibot <desk> schedule install`); `schedule status` confirms load + last run.");
  }
  if (/crontab/i.test(autonomy)) {
    hints.push("crontab: iMac user crontab entries are installed by the desk's schedule install command; `schedule status` confirms them.");
  }
  if (hints.length === 0) {
    hints.push("No schedule declared in the playbook — this desk is wake-on-demand only.");
  }
  return hints;
}

function buildPack(roleId) {
  const playbooks = loadPlaybooks();
  const playbook = playbooks[roleId];
  if (!playbook) {
    console.error(`pack: no playbook for role "${roleId}" in config/agent-role-playbooks.json`);
    process.exit(2);
  }
  const templateFile = join(TEMPLATE_DIR, `AGENTS.${roleId}.md`);
  if (!existsSync(templateFile)) {
    console.error(`pack: no template config/openclaw/templates/AGENTS.${roleId}.md`);
    process.exit(2);
  }

  const packDir = join(PACKS, roleId);
  const skillsDir = join(packDir, "skills");
  const standingDir = join(packDir, "standing-duties");
  rmSync(packDir, { recursive: true, force: true });
  mkdirSync(skillsDir, { recursive: true });
  mkdirSync(standingDir, { recursive: true });

  // playbook + AGENTS template
  writeJson(join(packDir, "playbook.json"), playbook);
  writeFileSync(join(packDir, "AGENTS.md"), readFileSync(templateFile, "utf8"));

  // vendor skills (skip MCP-only / missing SKILL.md → skillsExternal)
  const skills = [];
  const skillsExternal = [...(Array.isArray(playbook.skillsExternal) ? playbook.skillsExternal : [])];
  for (const name of playbook.skills || []) {
    const src = findSkillDir(name);
    if (src) {
      cpSync(src, join(skillsDir, name), { recursive: true, filter: (p) => !p.includes("/node_modules") });
      skills.push(name);
    } else {
      skillsExternal.push(name);
    }
  }
  const external = [...new Set(skillsExternal)].sort();

  // standing duties (only keys the pack declares)
  const standingDuties = [];
  for (const key of playbook.standingDuties || []) {
    const stub = STANDING_DUTY_STUBS[key] || `# Standing duty: ${key}\n\nOptional composable standing duty for the ${roleId} role. Wire per-hero with \`gotchibot templates apply ${roleId} --hero <hero> --standing-duty ${key} --yes\`.\n`;
    writeFileSync(join(standingDir, `${key}.md`), stub);
    standingDuties.push(key);
  }
  if (standingDuties.length === 0) rmSync(standingDir, { recursive: true, force: true });

  // cron hints
  writeFileSync(join(packDir, "cron-hints.md"), `# cron-hints — ${roleId}\n\n${cronHintsFromPlaybook(playbook).map((h) => `- ${h}`).join("\n")}\n`);

  // pack.json
  const prev = readJson(join(packDir, "pack.json"), null);
  const version = prev?.version || VERSION;
  const packJson = {
    id: roleId,
    roleId,
    version,
    title: playbook.title || roleId,
    summary: playbook.summary || "",
    scope: resolvePackScope(roleId),
    ...(SUITE_PACK_MEMBERS[roleId]
      ? {
          kind: "suite",
          members: [...SUITE_PACK_MEMBERS[roleId]],
          applyHint:
            "Suite — apply with --heroes role=hero,… for each member (never one hero for the whole crew).",
        }
      : {}),
    skills,
    skillsExternal: external,
    standingDuties,
    cronHints: cronHintsFromPlaybook(playbook),
    tags: TAG_MAP[roleId] || ["marketplace"],
    downloadPath: `packs/${roleId}`,
    files: listFiles(packDir),
  };
  writeJson(join(packDir, "pack.json"), packJson);

  // refresh catalog entry
  const catalog = loadCatalog();
  const entry = {
    id: roleId,
    roleId,
    title: packJson.title,
    summary: packJson.summary,
    scope: packJson.scope,
    ...(packJson.kind ? { kind: packJson.kind } : {}),
    ...(packJson.members ? { members: packJson.members } : {}),
    version,
    path: packJson.downloadPath,
    tags: packJson.tags,
    skills: packJson.skills,
    ...(external.length ? { skillsExternal: external } : {}),
  };
  catalog.packs = catalog.packs.filter((p) => p.id !== roleId);
  catalog.packs.push(entry);
  catalog.packs.sort((a, b) => a.id.localeCompare(b.id));
  saveCatalog(catalog);

  // refresh the embedded catalog fallback in web/index.html (file:// friendly)
  try {
    const html = readFileSync(WEB, "utf8");
    const embedded = JSON.stringify(catalog).replace(/</g, "\\u003c");
    const updated = html.replace(
      /<!--CATALOG_START-->[\s\S]*?<!--CATALOG_END-->/,
      `<!--CATALOG_START-->\n${embedded}\n<!--CATALOG_END-->`,
    );
    writeFileSync(WEB, updated);
  } catch {
    /* web page absent — fine */
  }

  console.log(`packed ${roleId} v${version} → templates/marketplace/packs/${roleId}`);
  console.log(`  skills:        ${skills.length ? skills.join(", ") : "(none vendored)"}`);
  console.log(`  skillsExternal:${external.length ? " " + external.join(", ") : " (none)"}`);
  console.log(`  standingDuties:${standingDuties.length ? " " + standingDuties.join(", ") : " (none)"}`);
  console.log(`  files:         ${packJson.files.length}`);
  return packJson;
}

function cmdList(json) {
  // sync wrapper — prefer async path from marketplace-menu / list --remote
  const catalog = loadCatalog();
  if (json) {
    console.log(JSON.stringify(catalog, null, 2));
    return;
  }
  console.log(`GotchiBot template marketplace — ${catalog.packs.length} pack(s)  (baseUrl: ${catalog.baseUrl})`);
  console.log("");
  for (const p of catalog.packs) {
    const scope = resolvePackScope(p);
    console.log(`  ${p.id.padEnd(28)} v${String(p.version).padEnd(7)} [${scope}] ${p.title}`);
    console.log(`    ${p.summary}`);
    console.log(`    tags: ${(p.tags || []).join(", ") || "-"}   skills: ${(p.skills || []).join(", ") || "-"}${p.skillsExternal?.length ? `   external: ${p.skillsExternal.join(", ")}` : ""}`);
    console.log(`    install: gotchibot templates install ${p.id}`);
    console.log("");
  }
}

async function cmdListRemote(json) {
  const catalog = await loadCatalogPreferRemote();
  if (json) {
    console.log(JSON.stringify(catalog, null, 2));
    return;
  }
  const src = catalog.source === "remote" ? "CDN" : `local (CDN: ${catalog.remoteError || "unavailable"})`;
  console.log(
    `GotchiBot template marketplace — ${catalog.packs.length} pack(s)  · ${src}`,
  );
  console.log(`  catalog  ${catalog.catalogUrl || REMOTE_CATALOG_URL}`);
  console.log(`  baseUrl  ${catalog.baseUrl}`);
  console.log("");
  for (const p of catalog.packs) {
    const scope = resolvePackScope(p);
    console.log(`  ${p.id.padEnd(28)} v${String(p.version).padEnd(7)} [${scope}] ${p.title}`);
    console.log(`    ${p.summary}`);
    console.log(`    tags: ${(p.tags || []).join(", ") || "-"}`);
    console.log(`    remote: ${remotePackUrl(catalog, p.id)}`);
    console.log(`    install: gotchibot templates install ${remotePackUrl(catalog, p.id)}`);
    console.log("");
  }
}

/** Stamp scope on every pack.json + catalog (+ embedded web fallback). */
function cmdStampScopes() {
  const catalog = loadCatalog();
  let nStarter = 0;
  let nAarcade = 0;
  for (const entry of catalog.packs) {
    const scope = resolvePackScope(entry);
    entry.scope = scope;
    if (scope === "starter") nStarter += 1;
    else nAarcade += 1;
    const packFile = join(PACKS, entry.id, "pack.json");
    if (existsSync(packFile)) {
      const pj = readJson(packFile, {});
      pj.scope = scope;
      writeJson(packFile, pj);
    }
  }
  catalog.packs.sort((a, b) => a.id.localeCompare(b.id));
  saveCatalog(catalog);
  try {
    const html = readFileSync(WEB, "utf8");
    const embedded = JSON.stringify(catalog).replace(/</g, "\\u003c");
    const updated = html.replace(
      /<!--CATALOG_START-->[\s\S]*?<!--CATALOG_END-->/,
      `<!--CATALOG_START-->\n${embedded}\n<!--CATALOG_END-->`,
    );
    writeFileSync(WEB, updated);
  } catch {
    /* web page absent — fine */
  }
  console.log(`stamped scope on ${catalog.packs.length} packs → ${nStarter} starter, ${nAarcade} aarcade`);
}

function cmdShow(id) {
  const catalog = loadCatalog();
  const entry = catalog.packs.find((p) => p.id === id || p.roleId === id);
  const packDir = entry ? join(PACKS, entry.id) : resolve(id);
  const packFile = existsSync(join(packDir, "pack.json")) ? join(packDir, "pack.json") : null;
  if (!packFile) {
    console.error(`show: no pack "${id}" in the catalog and no pack.json at ${packDir}`);
    process.exit(2);
  }
  const packJson = readJson(packFile, {});
  console.log(JSON.stringify(packJson, null, 2));
  console.log("");
  console.log(`paths (${packDir}):`);
  for (const f of listFiles(packDir)) console.log(`  ${f}`);
}

/** Resolve an install source: catalog id, local path, file:// or http(s) URL. */
async function resolvePackSource(arg) {
  if (typeof arg !== "string" || !arg.trim()) {
    console.error("install: need <id|path|url>");
    process.exit(2);
  }
  const s = arg.trim();

  // file:// URL
  if (s.startsWith("file://")) {
    const p = s.slice("file://".length);
    return resolveLocal(p);
  }

  // http(s) URL (CDN pack root or pack.json)
  if (/^https?:\/\//i.test(s)) {
    return fetchPackUrl(s);
  }

  // catalog id — local pack dir first, then remote CDN
  const localCatalog = loadCatalog();
  const localEntry = localCatalog.packs.find(
    (p) => p.id === s || p.roleId === s || p.path === s,
  );
  if (localEntry) {
    const dir = join(PACKS, localEntry.id);
    if (existsSync(join(dir, "pack.json"))) {
      return { dir, source: `catalog:${localEntry.id}` };
    }
  }

  // Prefer remote catalog when CDN is up (or id only exists remotely)
  try {
    const remote = await fetchRemoteCatalog();
    const entry = (remote.packs || []).find(
      (p) => p.id === s || p.roleId === s || p.path === s,
    );
    if (entry) {
      return fetchPackUrl(remotePackUrl(remote, entry.id));
    }
  } catch {
    /* CDN down — fall through */
  }

  if (localEntry) {
    console.error(
      `install: pack "${localEntry.id}" missing under templates/marketplace/packs/ and CDN unreachable`,
    );
    process.exit(2);
  }

  // local path
  return resolveLocal(s);
}

function resolveLocal(p) {
  let path = p;
  if (existsSync(path) && statSync(path).isFile() && path.endsWith("pack.json")) path = dirname(path);
  if (!existsSync(join(path, "pack.json"))) {
    console.error(`install: no pack.json at ${path}`);
    process.exit(2);
  }
  return { dir: resolve(path), source: path };
}

async function fetchText(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.text();
}

async function fetchBuffer(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Minimal-viable URL install: .zip/.tar.gz archive, or pack.json + files[] siblings. */
async function fetchPackUrl(url) {
  mkdirSync(TMP, { recursive: true });
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });

  if (/\.(zip|tar\.gz|tgz)(\?|$)/i.test(url)) {
    const buf = await fetchBuffer(url);
    const archive = join(TMP, `pack${/\.zip(\?|$)/i.test(url) ? ".zip" : ".tar.gz"}`);
    writeFileSync(archive, buf);
    const r = spawnSync(/\.zip(\?|$)/i.test(url) ? "unzip" : "tar", /\.zip(\?|$)/i.test(url) ? ["-oq", archive, "-d", TMP] : ["-xzf", archive, "-C", TMP], { stdio: "inherit" });
    if (r.status !== 0) {
      console.error(`install: failed to extract ${archive}`);
      process.exit(2);
    }
    // find pack.json under the extracted tree
    const found = findPackJson(TMP);
    if (!found) {
      console.error("install: archive has no pack.json");
      process.exit(2);
    }
    return { dir: found, source: url };
  }

  // pack.json (+ siblings listed in files[])
  const packUrl = url.endsWith("pack.json") ? url : `${url.replace(/\/+$/, "")}/pack.json`;
  const packJson = JSON.parse(await fetchText(packUrl));
  const packDir = join(TMP, packJson.id || "pack");
  mkdirSync(packDir, { recursive: true });
  writeFileSync(join(packDir, "pack.json"), JSON.stringify(packJson, null, 2));
  const base = packUrl.slice(0, packUrl.length - "pack.json".length);
  for (const f of packJson.files || []) {
    if (f === "pack.json") continue;
    const dst = join(packDir, f);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, await fetchText(`${base}${f}`));
  }
  return { dir: packDir, source: packUrl };
}

function findPackJson(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findPackJson(abs);
      if (found) return found;
    } else if (entry.name === "pack.json") {
      return dir;
    }
  }
  return null;
}

function saveStandingDuties(duties) {
  if (Object.keys(duties.duties || {}).length === 0) return;
  writeJson(STANDING_DUTIES_FILE, duties);
}

function parseHeroesMap(raw) {
  // bend-chief=h1,bend-laws=h2,bend-proofs=h3
  const out = {};
  if (!raw || typeof raw !== "string") return out;
  for (const part of raw.split(",")) {
    const s = part.trim();
    if (!s) continue;
    const i = s.indexOf("=");
    if (i <= 0) continue;
    out[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  }
  return out;
}

async function cmdApply(
  arg,
  { hero, heroes = null, yes = false, standingDuty = null, mint = null, reassign = false } = {},
) {
  const catalog = loadCatalog();
  const entry = catalog.packs.find((p) => p.id === arg || p.roleId === arg);
  const roleId = entry?.roleId || arg;
  let packDir = entry ? join(PACKS, entry.id) : null;

  if (!packDir || !existsSync(join(packDir, "pack.json"))) {
    if (entry) {
      console.log(`apply: pack ${entry.id} not built yet — installing first`);
      const { dir, source } = await resolvePackSource(entry.id);
      cmdInstallFrom(dir, source, { yes });
      packDir = join(PACKS, entry.id);
      if (!existsSync(join(packDir, "pack.json"))) packDir = dir;
    } else {
      console.error(`apply: unknown pack "${arg}" (not in catalog)`);
      process.exit(2);
    }
  }

  const packJson = readJson(join(packDir, "pack.json"), {});

  if (isSuitePack(packJson) || isSuitePack(roleId)) {
    const members = suiteMembers(packJson).length ? suiteMembers(packJson) : suiteMembers(roleId);
    const map = heroes && Object.keys(heroes).length ? heroes : {};
    if (!Object.keys(map).length) {
      console.error(
        `apply suite ${roleId}: need --heroes ${members.map((m) => `${m}=<hero>`).join(",")}`,
      );
      process.exit(2);
    }
    // Ensure suite + members installed first
    cmdInstallFrom(packDir, `catalog:${roleId}`, { yes });
    for (const member of members) {
      const h = map[member];
      if (!h) {
        console.error(`apply suite: missing hero for member ${member}`);
        process.exit(2);
      }
      console.log(`\n── suite member ${member} → ${h} ──`);
      const memberMint = h.startsWith("mint:") ? h.slice("mint:".length) : null;
      await cmdApply(member, {
        hero: memberMint ? null : h,
        mint: memberMint,
        yes,
        standingDuty: null,
        reassign,
      });
    }
    console.log(`\n✓ suite ${roleId} seated (${members.length} members)`);
    return;
  }

  const seat = await import("./template-seat.mjs");
  if (hero && mint) {
    console.error("apply: pass --hero <unassigned> or --mint <collateral>, not both");
    process.exit(2);
  }
  if (!hero && !mint) {
    const free = await seat.unassignedHeroes().catch(() => []);
    console.error(
      "apply: a template needs a cAavegotchi — --hero <unassigned> or --mint <collateral> ($5)\n" +
        (free.length
          ? `  unassigned: ${free.map((h) => h.id).join(", ")}`
          : "  no unassigned cAavegotchis on this cartridge — use --mint"),
    );
    process.exit(2);
  }
  if (hero) {
    const check = seat.seatCheck(hero, roleId);
    if (!check.ok && !reassign) {
      console.error(`apply: ${check.reason} — pick an unassigned cAavegotchi, --mint one, or pass --reassign`);
      process.exit(2);
    }
  }
  if (mint) {
    const known = seat.mintCollaterals().map((c) => c.key);
    if (!known.includes(mint)) {
      console.error(`apply: unknown collateral "${mint}" — one of: ${known.join(", ")}`);
      process.exit(2);
    }
    if (!yes) {
      console.log(`apply ${roleId} → new cAavegotchi (${mint}, $5) (dry-run, no --yes)`);
      console.log("  pass --yes to mint and seat the template on the new hero.");
      return;
    }
    console.log(`apply ${roleId}: minting a new ${mint} cAavegotchi ($5)…`);
    try {
      hero = await seat.mintTemplateHero(mint);
    } catch (e) {
      console.error(`apply: mint failed — ${e?.message || e}`);
      process.exit(1);
    }
    console.log(`  ✓ minted ${hero}`);
  }

  const resummon = [
    "node",
    join(ROOT, "scripts", "prof-link-cube.mjs"),
    "resummon",
    "--role", roleId,
    "--keep-playbook",
    "--hero", hero,
  ];
  if (standingDuty) resummon.push("--standing-duty", standingDuty);
  if (yes) resummon.push("--yes");

  if (!yes) {
    console.log(`apply ${roleId} → hero ${hero} (dry-run, no --yes)`);
    console.log(`  would run: ${resummon.join(" ")}`);
    console.log("  pass --yes to execute the resummon (role wiring + AGENTS template + fleet sync).");
    return;
  }

  console.log(`apply ${roleId} → hero ${hero}`);
  const r = spawnSync(resummon[0], resummon.slice(1), { stdio: "inherit", cwd: ROOT });
  if (r.status !== 0) {
    console.error(`apply: prof-link-cube resummon failed (exit ${r.status})`);
    process.exit(r.status || 1);
  }
  // Nest pack on cart + equip assignment slot (label = marketplace pack).
  try {
    const { equipPack } = await import("./pack-wearable.mjs");
    const eq = equipPack(hero, entry?.id || roleId);
    console.log(`  ✓ pack wearable → slot ${eq.slot}  (${eq.packId})  [assignment label]`);
  } catch (e) {
    console.error(`  · pack wearable equip skipped: ${e?.message || e}`);
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) {
    console.error(`usage:
  template-pack.mjs pack <roleId>            build/overwrite packs/<roleId> from live config
  template-pack.mjs list [--remote] [--json] print the catalog (CDN first with --remote)
  template-pack.mjs show <id>                print pack.json + file tree
  template-pack.mjs stamp-scopes             set scope=starter|aarcade on packs + catalog
  template-pack.mjs install <id|path|url> [--yes]   merge playbook + AGENTS + skills (+ standing duties with --yes)
  template-pack.mjs apply <id> --hero <unassigned> [--yes] [--standing-duty <key>] [--reassign]
  template-pack.mjs apply <id> --mint <collateral> [--yes]   mint a new cAavegotchi ($5) and seat it
  template-pack.mjs apply <suite> --heroes role=hero|mint:<collateral>,… [--yes]   seat every suite member
  template-pack.mjs equip <id> --hero <hero>   nest + equip pack wearable only (no resummon)
  template-pack.mjs cdn deploy|status|undeploy [--yes]   home-infra CDN (templates.aarcadeghst.com)
  template-pack.mjs menu                     interactive Marketplace (pulls public catalog)`);
    process.exit(2);
  }

  switch (cmd) {
    case "cdn": {
      const r = spawnSync(
        process.execPath,
        [join(ROOT, "scripts", "templates-cdn-deploy.mjs"), ...rest],
        { stdio: "inherit", cwd: ROOT },
      );
      process.exit(r.status ?? 1);
      break;
    }
    case "menu":
    case "marketplace": {
      const r = spawnSync(
        process.execPath,
        [join(ROOT, "scripts", "marketplace-menu.mjs"), ...rest],
        { stdio: "inherit", cwd: ROOT },
      );
      process.exit(r.status ?? 1);
      break;
    }
    case "stamp-scopes":
      cmdStampScopes();
      break;
    case "pack": {
      const roleId = rest[0];
      if (!roleId) {
        console.error("usage: template-pack.mjs pack <roleId>");
        process.exit(2);
      }
      buildPack(roleId);
      break;
    }
    case "list":
      if (rest.includes("--remote")) {
        await cmdListRemote(rest.includes("--json"));
      } else {
        cmdList(rest.includes("--json"));
      }
      break;
    case "show": {
      const id = rest[0];
      if (!id) {
        console.error("usage: template-pack.mjs show <id>");
        process.exit(2);
      }
      cmdShow(id);
      break;
    }
    case "install": {
      const arg = rest[0];
      if (!arg) {
        console.error("usage: template-pack.mjs install <id|path|url> [--yes]");
        process.exit(2);
      }
      const yes = rest.includes("--yes");
      const { dir, source } = await resolvePackSource(arg);
      cmdInstallFrom(dir, source, { yes });
      break;
    }
    case "apply": {
      const arg = rest[0];
      if (!arg) {
        console.error(
          "usage: template-pack.mjs apply <id> --hero <unassigned> | --mint <collateral> [--yes] [--reassign]\n" +
            "       template-pack.mjs apply <suite> --heroes role=hero|mint:<collateral>,… [--yes]",
        );
        process.exit(2);
      }
      const hero = flagValue(rest, "--hero");
      const heroes = parseHeroesMap(flagValue(rest, "--heroes"));
      const yes = rest.includes("--yes");
      const standingDuty = flagValue(rest, "--standing-duty");
      const mint = flagValue(rest, "--mint");
      const reassign = rest.includes("--reassign");
      await cmdApply(arg, { hero, heroes, yes, standingDuty, mint, reassign });
      break;
    }
    case "equip": {
      const arg = rest[0];
      const hero = flagValue(rest, "--hero");
      if (!arg || !hero) {
        console.error("usage: template-pack.mjs equip <id> --hero <hero>");
        process.exit(2);
      }
      const { equipPack } = await import("./pack-wearable.mjs");
      const eq = equipPack(hero, arg);
      console.log(`equipped ${hero} → ${eq.packId}  (slot ${eq.slot})  [assignment label]`);
      break;
    }
    default:
      console.error(`template-pack.mjs: unknown command "${cmd}"`);
      process.exit(2);
  }
}

function flagValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}

/** Sync install body (source already resolved). */
function cmdInstallFrom(dir, source, { yes = false } = {}) {
  const packJson = readJson(join(dir, "pack.json"), null);
  if (!packJson) {
    console.error(`install: ${dir}/pack.json missing or invalid`);
    process.exit(2);
  }
  const roleId = packJson.roleId || packJson.id;
  const playbook = readJson(join(dir, "playbook.json"), null);
  const agentsMd = existsSync(join(dir, "AGENTS.md")) ? readFileSync(join(dir, "AGENTS.md"), "utf8") : null;
  const changes = [];

  // 1) merge playbook (always)
  if (playbook) {
    const playbooks = loadPlaybooks();
    const existed = Boolean(playbooks[roleId]);
    playbooks[roleId] = playbook;
    savePlaybooks(playbooks);
    changes.push(`playbook ${existed ? "updated" : "added"}: config/agent-role-playbooks.json → ${roleId}`);
  }

  // 2) AGENTS.<role>.md template (write if missing, or with --yes)
  const templateFile = join(TEMPLATE_DIR, `AGENTS.${roleId}.md`);
  if (agentsMd) {
    if (!existsSync(templateFile)) {
      writeFileSync(templateFile, agentsMd);
      changes.push(`AGENTS template written: config/openclaw/templates/AGENTS.${roleId}.md`);
    } else if (yes) {
      writeFileSync(templateFile, agentsMd);
      changes.push(`AGENTS template overwritten (--yes): config/openclaw/templates/AGENTS.${roleId}.md`);
    } else {
      changes.push(`AGENTS template exists (kept; --yes to overwrite): config/openclaw/templates/AGENTS.${roleId}.md`);
    }
  }

  // 3) vendored skills → .opencode/skills (+ .cursor/skills mirror if that pattern exists)
  const cursorMirror = existsSync(CURSOR_SKILLS);
  for (const name of packJson.skills || []) {
    const src = join(dir, "skills", name);
    if (!existsSync(join(src, "SKILL.md"))) {
      changes.push(`skill ${name}: SKILL.md missing in pack — skipped`);
      continue;
    }
    const dst = join(OPENCODE_SKILLS, name);
    if (!existsSync(join(dst, "SKILL.md")) || yes) {
      rmSync(dst, { recursive: true, force: true });
      cpSync(src, dst, { recursive: true });
      changes.push(`skill vendored: .opencode/skills/${name}`);
    } else {
      changes.push(`skill exists (kept; --yes to overwrite): .opencode/skills/${name}`);
    }
    if (cursorMirror) {
      const cdst = join(CURSOR_SKILLS, name);
      if (!existsSync(join(cdst, "SKILL.md")) || yes) {
        rmSync(cdst, { recursive: true, force: true });
        cpSync(src, cdst, { recursive: true });
        changes.push(`skill mirrored: .cursor/skills/${name}`);
      }
    }
  }

  // 4) standing-duty snippets → config/agent-standing-duties.json (--yes only;
  //    never overwrite product desk heroes without --yes)
  const duties = loadStandingDuties();
  const dutyKeys = packJson.standingDuties || [];
  for (const key of dutyKeys) {
    const stubFile = join(dir, "standing-duties", `${key}.md`);
    if (!existsSync(stubFile)) continue;
    const existing = duties.duties?.[key];
    const ownerRole = existing?.hero ? loadRoles()[existing.hero] : null;
    const productOwned = ownerRole && PRODUCT_DESK_ROLES.has(ownerRole);
    if (existing && productOwned && !yes) {
      changes.push(`standing duty ${key}: owned by product desk hero ${existing.hero} (${ownerRole}) — not overwritten without --yes`);
      continue;
    }
    if (!yes) {
      changes.push(`standing duty ${key}: snippet available (install with --yes to merge into config/agent-standing-duties.json)`);
      continue;
    }
    duties.duties = duties.duties || {};
    duties.duties[key] = {
      title: `Standing duty: ${key}`,
      hero: existing?.hero || null,
      roleId,
      source: `templates/marketplace/packs/${roleId}/standing-duties/${key}.md`,
      note: "Composable standing duty from the bot-template marketplace. Wire per-hero with `gotchibot templates apply <id> --hero <hero> --standing-duty <key> --yes`.",
    };
    changes.push(`standing duty merged: config/agent-standing-duties.json → ${key}`);
  }
  saveStandingDuties(duties);

  // 5) no auto-mint
  changes.push("no cAavegotchi minted — spawning still requires a cAavegotchi on the cartridge (wallet gate)");

  console.log(`installed ${packJson.id} v${packJson.version} from ${source}`);
  for (const c of changes) console.log(`  - ${c}`);

  // 6) suite → install each member pack from local marketplace
  if (isSuitePack(packJson) || isSuitePack(roleId)) {
    const members = suiteMembers(packJson).length ? suiteMembers(packJson) : suiteMembers(roleId);
    for (const member of members) {
      if (member === roleId) continue;
      const memberDir = join(PACKS, member);
      if (!existsSync(join(memberDir, "pack.json"))) {
        console.log(`  · suite member ${member}: pack not built yet (run templates pack ${member})`);
        continue;
      }
      console.log(`\n── suite member install ${member} ──`);
      cmdInstallFrom(memberDir, `suite:${roleId}/${member}`, { yes });
    }
  }
}

export {
  BASE_URL,
  REMOTE_CATALOG_URL,
  loadCatalog,
  STARTER_PACK_IDS,
};

const isMain =
  process.argv[1] &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (isMain) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}