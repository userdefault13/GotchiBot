#!/usr/bin/env node
/**
 * Desk project files ↔ Hub.
 *
 * A local write of the open project's dossier, kanban/factory cards, meet, or
 * inbox merges that file onto the Hub (POST /api/gotchibot/projects/files).
 * A pane reload pulls the Hub copy (GET /api/gotchibot/projects/:slug/files)
 * and paints that. Uses the paired desk token via chat-hub-client. No second hub.
 *
 *   node scripts/hub-project-sync.mjs pull
 */
import { mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";
import { currentProjectSlug } from "./project-context.mjs";
import { projectSyncPathOk } from "../services/gotchibot-api/projects.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_FILE_BYTES = 256 * 1024;
const queues = new Map();

function testProcess() {
  return process.execArgv.includes("--test") || process.env.NODE_TEST_CONTEXT != null;
}

export function repoRel(root, absPath) {
  const rel = relative(resolve(root), resolve(absPath)).split(sep).join("/");
  if (!rel || rel.startsWith("../") || rel === "..") return null;
  return projectSyncPathOk(rel) ? rel : null;
}

function slugOf(rel) {
  return rel.split("/")[2] || null;
}

/**
 * Write Hub file texts onto the desk. Hub wins unless the local file is newer
 * than the Hub mtime (a write that has not reached the Hub yet).
 * @returns {string[]} repo-relative paths written
 */
export function applyHubProjectFiles(root, files) {
  const base = resolve(root);
  const written = [];
  for (const f of files || []) {
    if (!projectSyncPathOk(f?.path) || typeof f.text !== "string") continue;
    const abs = resolve(base, f.path);
    if (abs !== base && !abs.startsWith(base + sep)) continue;
    let current = null;
    let localMtime = 0;
    try {
      current = readFileSync(abs, "utf8");
      localMtime = statSync(abs).mtimeMs;
    } catch {
      current = null;
    }
    if (current === f.text) continue;
    const hubMtime = Date.parse(f.mtime || "");
    if (current != null && Number.isFinite(hubMtime) && localMtime > hubMtime + 1000) continue;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.text);
    if (Number.isFinite(hubMtime)) {
      const d = new Date(hubMtime);
      try {
        utimesSync(abs, d, d);
      } catch {
        /* advisory */
      }
    }
    written.push(f.path);
  }
  return written;
}

async function defaultHubRequest() {
  const mod = await import("./chat-hub-client.mjs");
  return mod.hubRequest;
}

export async function pushProjectFiles({ root, slug, rels, hubRequest, env = process.env } = {}) {
  const files = [];
  for (const rel of rels || []) {
    if (!projectSyncPathOk(rel) || !rel.startsWith(`sessions/pstack/${slug}/`)) continue;
    const abs = join(root, rel);
    let text;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) continue;
    let mtime = null;
    try {
      mtime = statSync(abs).mtime.toISOString();
    } catch {
      mtime = null;
    }
    files.push({ path: rel, text, mtime });
  }
  if (!files.length) return { ok: true, skipped: "empty" };
  const request = hubRequest || (await defaultHubRequest());
  const signal = AbortSignal.timeout(8000);
  return request("POST", "/api/gotchibot/projects/files", { body: { files }, env, signal });
}

/** Pull the open project's Hub copy onto disk. */
export async function pullOpenProject({ root = ROOT, slug, hubRequest, env = process.env } = {}) {
  const s = slug || currentProjectSlug();
  if (!s) return { ok: false, skipped: "no-project", written: [] };
  const request = hubRequest || (await defaultHubRequest());
  const signal = AbortSignal.timeout(4000);
  const res = await request("GET", `/api/gotchibot/projects/${encodeURIComponent(s)}/files`, { env, signal });
  const written = applyHubProjectFiles(root, res?.files || []);
  return { ok: true, slug: s, written };
}

/**
 * Schedule a merge-push of one project file. No-ops in `node --test` unless a
 * hubRequest is injected, and when GOTCHIBOT_HUB_PROJECT_SYNC=0.
 */
/**
 * The debounce timer is unref'd so it never holds a pane open — which also
 * meant a one-shot CLI (gotchi-meet.mjs chat/switch/say …) exited before its
 * push fired and the Hub never saw the write. beforeExit fires when the loop
 * drains (not on process.exit), so flush there; the push keeps the loop alive
 * until it lands, then beforeExit fires again with nothing queued.
 */
let exitFlushHooked = false;
function hookExitFlush() {
  if (exitFlushHooked) return;
  exitFlushHooked = true;
  process.on("beforeExit", () => {
    if (!queues.size) return;
    flushProjectWrites().catch(() => {});
  });
}

export function publishProjectWrite(absPath, { root = ROOT, env = process.env, hubRequest, debounceMs = 400 } = {}) {
  if (env.GOTCHIBOT_HUB_PROJECT_SYNC === "0") return false;
  if (!hubRequest && testProcess()) return false;
  hookExitFlush();
  const rel = repoRel(root, absPath);
  if (!rel) return false;
  const slug = slugOf(rel);
  if (!slug) return false;
  const key = `${resolve(root)}\0${slug}`;
  let q = queues.get(key);
  if (!q) {
    q = { rels: new Set(), timer: null, root, slug, env, hubRequest };
    queues.set(key, q);
  }
  q.rels.add(rel);
  q.env = env;
  if (hubRequest) q.hubRequest = hubRequest;
  clearTimeout(q.timer);
  q.timer = setTimeout(() => {
    const rels = [...q.rels];
    const job = { root: q.root, slug: q.slug, rels, hubRequest: q.hubRequest, env: q.env };
    queues.delete(key);
    pushProjectFiles(job).catch(() => {});
  }, debounceMs);
  q.timer.unref?.();
  return true;
}

/** Push anything still waiting. Tests use this instead of the timer. */
export async function flushProjectWrites() {
  const jobs = [...queues.entries()];
  queues.clear();
  const out = [];
  for (const [, q] of jobs) {
    clearTimeout(q.timer);
    out.push(
      await pushProjectFiles({
        root: q.root,
        slug: q.slug,
        rels: [...q.rels],
        hubRequest: q.hubRequest,
        env: q.env,
      }),
    );
  }
  return out;
}

/**
 * Pull on an interval. `onChange` runs only when Hub bytes were written.
 * Unpaired desks and a down Hub leave the local files alone.
 */
export function startHubProjectMirror({ root = ROOT, intervalMs = 5000, onChange, env = process.env } = {}) {
  if (env.GOTCHIBOT_HUB_PROJECT_SYNC === "0" || testProcess()) {
    return () => {};
  }
  let stopped = false;
  let busy = false;
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const r = await pullOpenProject({ root, env });
      if (!stopped && r.written?.length && onChange) onChange(r);
    } catch {
      /* keep the local copy */
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

if (isMainModule(import.meta.url)) {
  const cmd = process.argv[2] || "pull";
  if (cmd !== "pull") {
    console.error("usage: hub-project-sync.mjs pull");
    process.exit(2);
  }
  pullOpenProject({ root: ROOT })
    .then((r) => {
      if (process.argv.includes("--json")) console.log(JSON.stringify({ ok: true, slug: r.slug, written: r.written?.length || 0 }));
      process.exit(0);
    })
    .catch(() => {
      process.exit(0);
    });
}
