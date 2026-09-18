#!/usr/bin/env node
/**
 * pstack-dossier-cron — data-ai-cron-site fetch/persist/show for patch dossier.
 *
 * SoT: cron402 remembered jobs (~/.cron402/jobs.json) + GET /v1/crons/:id
 * Optional persist: sessions/pstack/<slug>/dossier.json → top-level key `cron`
 * (not a second cron store — snapshot of cron402 for the pane).
 *
 * Usage:
 *   node scripts/pstack-dossier-cron.mjs fetch [--slug <slug>] [--json] [--state <path>]
 *   node scripts/pstack-dossier-cron.mjs persist --slug <slug> [--json]
 *   node scripts/pstack-dossier-cron.mjs show [--slug <slug>] [--json]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PSTACK_ROOT = join(ROOT, "sessions", "pstack");
const CURRENT = join(ROOT, "sessions", ".pstack-dossier-current");
const API_URL = (process.env.CRON402_API_URL || "https://cron402-api.user-defaults.workers.dev").replace(/\/$/, "");
const DEFAULT_STATE = join(process.env.CRON402_STATE_DIR || join(homedir(), ".cron402"), "jobs.json");

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function readJson(path, fallback = null) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") flags.json = true;
    else if (a.startsWith("--") && i + 1 < argv.length) {
      flags[a.slice(2)] = argv[++i];
    } else positional.push(a);
  }
  return { cmd: positional[0], flags, positional };
}

function currentSlug() {
  const cur = readJson(CURRENT, null);
  if (typeof cur === "string" && cur.trim()) return cur.trim();
  if (cur && typeof cur.slug === "string") return cur.slug;
  try {
    if (existsSync(CURRENT)) {
      const t = readFileSync(CURRENT, "utf8").trim();
      if (t) return t;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function dossierPath(slug) {
  return join(PSTACK_ROOT, slug, "dossier.json");
}

/** RememberedJob fields from cron402-mcp store.ts */
function loadRememberedJobs(statePath, apiUrl) {
  const raw = readJson(statePath, []);
  const list = Array.isArray(raw) ? raw : [];
  return list.filter((j) => !j.apiUrl || j.apiUrl === apiUrl);
}

function logSnippetFromExecution(ex) {
  if (!ex || typeof ex !== "object") return "";
  if (ex.error) return String(ex.error).slice(0, 240);
  if (ex.statusCode != null) return `HTTP ${ex.statusCode}`;
  if (ex.ok === true || ex.ok === 1) return "ok";
  if (ex.ok === false || ex.ok === 0) return "fail";
  return "";
}

/** Normalize get_cron / GET /v1/crons/:id body → executions[] with real field names */
function normalizeExecutions(jobBody) {
  const detail = jobBody?.job && typeof jobBody.job === "object" ? jobBody.job : jobBody;
  const execs = detail?.executions;
  if (!Array.isArray(execs)) return [];
  return execs.map((ex) => ({
    runAt: ex.runAt ?? ex.ranAt ?? ex.at ?? null,
    ok: ex.ok ?? null,
    attempts: ex.attempts ?? null,
    statusCode: ex.statusCode ?? ex.status ?? null,
    error: ex.error ?? null,
    durationMs: ex.durationMs ?? ex.duration ?? null,
  }));
}

async function fetchJobLive(jobId) {
  const res = await fetch(`${API_URL}/v1/crons/${jobId}`);
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

/**
 * Contract shape for dossier-ai-cron-site:
 * {
 *   fetchedAt, apiUrl, statePath,
 *   agents: [{
 *     jobId, schedule, means, url, createdAt, status, credits,
 *     executions: [{ runAt, ok, attempts, statusCode, error, durationMs }],
 *     logSnippet, logPath
 *   }]
 * }
 */
export async function fetchCronAgents({ statePath = DEFAULT_STATE, apiUrl = API_URL } = {}) {
  const known = loadRememberedJobs(statePath, apiUrl);
  const agents = [];
  for (const j of known) {
    const jobId = j.jobId;
    if (!jobId) continue;
    let status = "unknown";
    let credits = null;
    let executions = [];
    let liveError = null;
    try {
      const live = await fetchJobLive(jobId);
      if (live.ok) {
        const detail = live.body?.job && typeof live.body.job === "object" ? live.body.job : live.body;
        status = detail?.status ?? live.body?.status ?? "unknown";
        credits = detail?.credits ?? live.body?.credits ?? null;
        executions = normalizeExecutions(live.body);
      } else {
        status = `lookup failed (${live.status})`;
        liveError = typeof live.body === "object" ? JSON.stringify(live.body).slice(0, 200) : String(live.status);
      }
    } catch (e) {
      status = "unreachable";
      liveError = String(e?.message || e);
    }
    const last = executions[0] || null;
    agents.push({
      jobId,
      schedule: j.schedule ?? null,
      means: j.description ?? j.means ?? null,
      url: j.url ?? null,
      createdAt: j.createdAt ?? null,
      status,
      credits,
      executions,
      logSnippet: last ? logSnippetFromExecution(last) : liveError || "",
      logPath: null,
    });
  }
  return {
    fetchedAt: new Date().toISOString(),
    apiUrl,
    statePath,
    count: agents.length,
    agents,
    note:
      agents.length === 0
        ? `No jobs in ${statePath} for ${apiUrl}. Empty is valid — do not invent rows.`
        : undefined,
  };
}

async function cmdFetch(flags) {
  const statePath = flags.state ? resolve(flags.state) : DEFAULT_STATE;
  const data = await fetchCronAgents({ statePath });
  if (flags.json) {
    console.log(JSON.stringify(data, null, 2));
    return data;
  }
  console.log(`# dossier-cron fetch  ${data.fetchedAt}`);
  console.log(`api: ${data.apiUrl}`);
  console.log(`state: ${data.statePath}`);
  console.log(`count: ${data.count}`);
  if (data.note) console.log(`note: ${data.note}`);
  for (const a of data.agents) {
    const last = a.executions[0];
    const lastBit = last
      ? ` last ok=${last.ok} statusCode=${last.statusCode} runAt=${last.runAt}`
      : " last=(none)";
    console.log(`- ${a.jobId}  ${a.schedule || "?"}  status=${a.status} credits=${a.credits}${lastBit}`);
    if (a.logSnippet) console.log(`    logSnippet: ${a.logSnippet}`);
  }
  return data;
}

async function cmdPersist(flags) {
  const slug = flags.slug || currentSlug();
  if (!slug) die("persist: need --slug <slug> (or set pstack dossier current)");
  const p = dossierPath(slug);
  if (!existsSync(p)) die(`persist: no dossier at ${p} — run: gotchibot pstack dossier new ${slug} --goal "…"`);
  const dossier = readJson(p);
  if (!dossier || typeof dossier !== "object") die(`persist: bad dossier json: ${p}`);
  const data = await fetchCronAgents({ statePath: flags.state ? resolve(flags.state) : DEFAULT_STATE });
  dossier.cron = {
    fetchedAt: data.fetchedAt,
    apiUrl: data.apiUrl,
    statePath: data.statePath,
    agents: data.agents,
  };
  dossier.updatedAt = new Date().toISOString();
  writeJson(p, dossier);
  if (flags.json) {
    console.log(JSON.stringify({ slug, path: p, cron: dossier.cron }, null, 2));
    return;
  }
  console.log(`persisted cron slice → ${p} (agents=${data.count})`);
}

function cmdShow(flags) {
  const slug = flags.slug || currentSlug();
  if (!slug) die("show: need --slug <slug> (or set pstack dossier current)");
  const p = dossierPath(slug);
  if (!existsSync(p)) die(`show: no dossier at ${p}`);
  const dossier = readJson(p, {});
  const cron = dossier.cron || null;
  if (flags.json) {
    console.log(JSON.stringify({ slug, path: p, cron }, null, 2));
    return;
  }
  if (!cron) {
    console.log(`no cron slice on ${slug} — run: ./scripts/pstack-dossier-cron.mjs persist --slug ${slug}`);
    return;
  }
  console.log(`# dossier.cron — ${slug}  fetchedAt=${cron.fetchedAt}`);
  console.log(`agents: ${(cron.agents || []).length}`);
  for (const a of cron.agents || []) {
    console.log(`- ${a.jobId} schedule=${a.schedule} status=${a.status} credits=${a.credits} logSnippet=${a.logSnippet || ""}`);
  }
}

const { cmd, flags } = parseArgs(process.argv.slice(2));
if (!cmd || cmd === "help" || cmd === "-h") {
  console.log(`pstack-dossier-cron fetch|persist|show [--slug <slug>] [--json] [--state <jobs.json>]`);
  process.exit(0);
}
if (cmd === "fetch") await cmdFetch(flags);
else if (cmd === "persist") await cmdPersist(flags);
else if (cmd === "show") cmdShow(flags);
else die(`unknown command: ${cmd}`);
