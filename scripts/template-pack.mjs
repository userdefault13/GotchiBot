#!/usr/bin/env node
/**
 * template-pack.mjs — GotchiBot bot-template marketplace CLI (Prof. Link-Cube).
 *
 *   node scripts/template-pack.mjs pack <roleId>            build/overwrite packs/<roleId> from live config
 *   node scripts/template-pack.mjs list [--json]            print the catalog
 *   node scripts/template-pack.mjs show <id>                print pack.json + file tree
 *   node scripts/template-pack.mjs install <id|path|url> [--yes]
 *                                                           merge playbook + AGENTS template + vendored skills
 *   node scripts/template-pack.mjs apply <id> --hero <hero> [--yes] [--standing-duty <key>] [--force] [--project <slug>]
 *                                                           apply gate (roster + available + starter crew) then resummon
 *   install needs NO hero/gotchi — free, no apply gate.
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
const BASE_URL = "https://aarcadeghst.com/gotchibot-templates";

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
};

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
  const catalog = loadCatalog();
  if (json) {
    console.log(JSON.stringify(catalog, null, 2));
    return;
  }
  console.log(`GotchiBot template marketplace — ${catalog.packs.length} pack(s)  (baseUrl: ${catalog.baseUrl})`);
  console.log("");
  for (const p of catalog.packs) {
    console.log(`  ${p.id.padEnd(20)} v${p.version.padEnd(7)} ${p.title}`);
    console.log(`    ${p.summary}`);
    console.log(`    tags: ${(p.tags || []).join(", ") || "-"}   skills: ${(p.skills || []).join(", ") || "-"}${p.skillsExternal?.length ? `   external: ${p.skillsExternal.join(", ")}` : ""}`);
    console.log(`    install: gotchibot templates install ${p.id}`);
    console.log("");
  }
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

  // catalog id
  const catalog = loadCatalog();
  const entry = catalog.packs.find((p) => p.id === s || p.roleId === s || p.path === s);
  if (entry) {
    const dir = join(PACKS, entry.id);
    if (existsSync(join(dir, "pack.json"))) return { dir, source: `catalog:${entry.id}` };
  }

  // file:// URL
  if (s.startsWith("file://")) {
    const p = s.slice("file://".length);
    return resolveLocal(p);
  }

  // http(s) URL
  if (/^https?:\/\//i.test(s)) {
    return fetchPackUrl(s);
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

async function cmdApply(arg, {
  hero,
  yes = false,
  standingDuty = null,
  force = false,
  project = null,
} = {}) {
  const catalog = loadCatalog();
  const entry = catalog.packs.find((p) => p.id === arg || p.roleId === arg);
  const roleId = entry?.roleId || arg;
  const packDir = entry ? join(PACKS, entry.id) : null;

  if (!packDir || !existsSync(join(packDir, "pack.json"))) {
    if (entry) {
      console.log(`apply: pack ${entry.id} not built yet — installing first`);
      const { dir, source } = await resolvePackSource(entry.id);
      cmdInstallFrom(dir, source, { yes });
    } else {
      console.error(`apply: unknown pack "${arg}" (not in catalog)`);
      process.exit(2);
    }
  }

  const { assertHeroApplicable, listApplicableHeroes, formatGateFailure } =
    await import("./hero-apply-gate.mjs");
  const { currentProjectSlug } = await import("./project-context.mjs");
  const projectSlug = project || currentProjectSlug() || null;

  if (!hero) {
    console.error("apply: --hero <hero> required (e.g. starter-dai-h1-2)");
    const listed = await listApplicableHeroes();
    if (listed.warnings?.length) {
      for (const w of listed.warnings) console.error(`  warning: ${w}`);
    }
    if (listed.heroes.length) {
      console.error(`  available heroes: ${listed.heroes.join(", ")}`);
    } else {
      console.error("  available heroes: (none found on roster/cache)");
    }
    process.exit(2);
  }

  // Rule 3 — gate before dry-run / resummon. install path never calls this.
  const gate = await assertHeroApplicable(hero, { project: projectSlug, force });
  for (const w of gate.warnings || []) console.error(w.startsWith("WARNING") ? w : `warning: ${w}`);
  if (!gate.ok) {
    for (const line of formatGateFailure(gate)) console.error(line);
    process.exit(2);
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
  if (force) resummon.push("--force");

  if (!yes) {
    console.log(`apply ${roleId} → hero ${hero} (dry-run, no --yes)`);
    console.log(`  would run: ${resummon.join(" ")}`);
    console.log("  pass --yes to execute the resummon (role wiring + AGENTS template + fleet sync).");
    return;
  }

  console.log(`apply ${roleId} → hero ${hero}`);
  const r = spawnSync(resummon[0], resummon.slice(1), {
    stdio: "inherit",
    cwd: ROOT,
    env: { ...process.env, GOTCHIBOT_APPLY_GATE_OK: "1" },
  });
  if (r.status !== 0) {
    console.error(`apply: prof-link-cube resummon failed (exit ${r.status})`);
    process.exit(r.status || 1);
  }
  // Nest pack on cart + equip assignment slot (label = marketplace pack).
  // Gate already passed — skip re-check in equip callers via env.
  const prevGate = process.env.GOTCHIBOT_APPLY_GATE_OK;
  process.env.GOTCHIBOT_APPLY_GATE_OK = "1";
  try {
    const { equipPack } = await import("./pack-wearable.mjs");
    const eq = equipPack(hero, entry?.id || roleId);
    console.log(`  ✓ pack wearable → slot ${eq.slot}  (${eq.packId})  [assignment label]`);
  } catch (e) {
    console.error(`  · pack wearable equip skipped: ${e?.message || e}`);
  } finally {
    if (prevGate === undefined) delete process.env.GOTCHIBOT_APPLY_GATE_OK;
    else process.env.GOTCHIBOT_APPLY_GATE_OK = prevGate;
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) {
    console.error(`usage:
  template-pack.mjs pack <roleId>            build/overwrite packs/<roleId> from live config
  template-pack.mjs list [--json]            print the catalog
  template-pack.mjs show <id>                print pack.json + file tree
  template-pack.mjs install <id|path|url> [--yes]   merge playbook + AGENTS + skills (NO hero required; no apply gate)
  template-pack.mjs apply <id> --hero <hero> [--yes] [--standing-duty <key>] [--force] [--project <slug>]
                           apply gate then resummon + equip (slot 15 = assignment)
  template-pack.mjs equip <id> --hero <hero> [--force] [--project <slug>]   nest + equip (apply gate)
  template-pack.mjs cdn deploy|status|undeploy [--yes]   home-infra CDN (templates.aarcadeghst.com)`);
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
      cmdList(rest.includes("--json"));
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
          "usage: template-pack.mjs apply <id> --hero <hero> [--yes] [--standing-duty <key>] [--force] [--project <slug>]",
        );
        process.exit(2);
      }
      const hero = flagValue(rest, "--hero");
      const yes = rest.includes("--yes");
      const force = rest.includes("--force");
      const standingDuty = flagValue(rest, "--standing-duty");
      const project = flagValue(rest, "--project");
      await cmdApply(arg, { hero, yes, standingDuty, force, project });
      break;
    }
    case "equip": {
      const arg = rest[0];
      const hero = flagValue(rest, "--hero");
      if (!arg || !hero) {
        console.error("usage: template-pack.mjs equip <id> --hero <hero> [--force] [--project <slug>]");
        process.exit(2);
      }
      const force = rest.includes("--force");
      const project = flagValue(rest, "--project");
      const { assertHeroApplicable, formatGateFailure } = await import("./hero-apply-gate.mjs");
      const { currentProjectSlug } = await import("./project-context.mjs");
      const gate = await assertHeroApplicable(hero, {
        project: project || currentProjectSlug() || null,
        force,
      });
      for (const w of gate.warnings || []) console.error(w.startsWith("WARNING") ? w : `warning: ${w}`);
      if (!gate.ok) {
        for (const line of formatGateFailure(gate)) console.error(line);
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
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});