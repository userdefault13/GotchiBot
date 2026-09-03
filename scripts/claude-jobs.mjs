#!/usr/bin/env node
/**
 * Async Claude job store (pending → ready/failed → collected).
 * No polling — receiver push marks ready; orch collects by id.
 *
 *   node scripts/claude-jobs.mjs list [--status pending|ready|failed|collected]
 *   node scripts/claude-jobs.mjs get <id>
 *   node scripts/claude-jobs.mjs collect <id>
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const JOBS_DIR = join(ROOT, "var/claude-jobs");
const EVENTS = join(JOBS_DIR, "events.jsonl");

export function jobsDir() {
  mkdirSync(JOBS_DIR, { recursive: true });
  return JOBS_DIR;
}

function jobPath(id) {
  const safe = String(id || "").replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!safe) throw new Error("missing job id");
  return join(jobsDir(), `${safe}.json`);
}

function writeJob(job) {
  const p = jobPath(job.id);
  writeFileSync(p, JSON.stringify(job, null, 2) + "\n");
  return job;
}

function appendEvent(ev) {
  jobsDir();
  appendFileSync(EVENTS, JSON.stringify({ ...ev, at: ev.at || new Date().toISOString() }) + "\n");
}

export function createPending({ id, prompt, meta = {} } = {}) {
  if (!id) throw new Error("id required");
  const job = {
    id: String(id),
    status: "pending",
    prompt: String(prompt || ""),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    response: null,
    ok: null,
    meta,
  };
  writeJob(job);
  appendEvent({ type: "claude_pending", id: job.id });
  return job;
}

export function getJob(id) {
  const p = jobPath(id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function markReady(id, payload = {}) {
  const prev = getJob(id) || {
    id: String(id),
    prompt: payload.prompt || "",
    createdAt: new Date().toISOString(),
    meta: {},
  };
  const ok = payload.ok !== false;
  const job = {
    ...prev,
    status: ok ? "ready" : "failed",
    ok,
    response: payload.response != null ? String(payload.response) : prev.response,
    prompt: payload.prompt != null ? String(payload.prompt) : prev.prompt,
    updatedAt: new Date().toISOString(),
    resultAt: new Date().toISOString(),
    raw: payload,
  };
  writeJob(job);
  appendEvent({ type: ok ? "claude_ready" : "claude_failed", id: job.id });
  return job;
}

export function markFailed(id, err) {
  return markReady(id, {
    ok: false,
    response: typeof err === "string" ? err : err?.message || String(err),
  });
}

export function listJobs({ status } = {}) {
  const dir = jobsDir();
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json") || name === "events.jsonl") continue;
    try {
      const job = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (status && job.status !== status) continue;
      out.push(job);
    } catch {
      /* skip */
    }
  }
  out.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return out;
}

/** Return reply text and mark collected. If still pending, return pending without mutating. */
export function collectJob(id) {
  const job = getJob(id);
  if (!job) return { ok: false, status: "missing", id, error: `unknown job ${id}` };
  if (job.status === "pending") {
    return { ok: false, status: "pending", id, error: "still pending — wait for push wake" };
  }
  if (job.status === "collected") {
    return {
      ok: job.ok !== false,
      status: "collected",
      id,
      response: job.response,
      already: true,
    };
  }
  const collected = {
    ...job,
    status: "collected",
    collectedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeJob(collected);
  appendEvent({ type: "claude_collected", id });
  return {
    ok: job.ok !== false,
    status: "collected",
    id,
    response: job.response,
    prompt: job.prompt,
  };
}

function usage() {
  console.error(`usage:
  claude-jobs.mjs list [--status pending|ready|failed|collected] [--json]
  claude-jobs.mjs get <id> [--json]
  claude-jobs.mjs collect <id> [--json]`);
  process.exit(2);
}

const isMain =
  Boolean(process.argv[1]) &&
  fileURLToPath(import.meta.url) ===
    (process.argv[1].startsWith("/")
      ? process.argv[1]
      : join(process.cwd(), process.argv[1]));
if (isMain || /claude-jobs\.mjs$/.test(process.argv[1] || "")) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const cmd = args.find((a) => !a.startsWith("--"));
  if (!cmd || cmd === "-h" || cmd === "--help") usage();

  if (cmd === "list") {
    const si = args.indexOf("--status");
    const status = si >= 0 ? args[si + 1] : undefined;
    const jobs = listJobs({ status });
    console.log(json ? JSON.stringify(jobs, null, 2) : JSON.stringify(jobs, null, 2));
    process.exit(0);
  }

  if (cmd === "get") {
    const id = args.filter((a) => !a.startsWith("--") && a !== "get")[0];
    if (!id) usage();
    const job = getJob(id);
    if (!job) {
      console.error(JSON.stringify({ ok: false, error: "missing", id }));
      process.exit(1);
    }
    console.log(JSON.stringify(job, null, json ? 0 : 2));
    process.exit(0);
  }

  if (cmd === "collect") {
    const id = args.filter((a) => !a.startsWith("--") && a !== "collect")[0];
    if (!id) usage();
    const r = collectJob(id);
    if (json || r.status !== "collected") {
      console.log(JSON.stringify(r, null, 2));
    } else {
      process.stdout.write(String(r.response || "").endsWith("\n") ? r.response : `${r.response || ""}\n`);
    }
    process.exit(r.ok || r.status === "pending" ? (r.status === "pending" ? 2 : 0) : 1);
  }

  usage();
}
