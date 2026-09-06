#!/usr/bin/env node
/**
 * Contexter — carry a session's working knowledge across a context window.
 *
 *   node scripts/contexter.mjs save [--task "…"] [--decision "…"] [--value k=v]
 *                                   [--tried "…"] [--open "…"] [--next "…"]
 *   node scripts/contexter.mjs latest [--json] [--brief]
 *   node scripts/contexter.mjs show [<id>] [--json]
 *   node scripts/contexter.mjs list [--json]
 *   node scripts/contexter.mjs prune [--keep N]
 *
 * A long session accumulates things that are expensive to rediscover and easy
 * to lose when the window compacts: the container name you settled on, the
 * session id an agent is running under, the port that actually answers, the
 * approach you already proved wrong. A compaction summary keeps the story and
 * drops most of those.
 *
 * A capsule is therefore two halves:
 *
 *   facts     read off the desk (branch, HEAD, dirty files, running sessions,
 *             open meeting, pending passoffs) — free, and always current
 *   narrative supplied by whoever is working (task, decisions *with reasons*,
 *             key values, dead ends, open threads, next step) — the part no
 *             script can infer and the part that actually gets lost
 *
 * Capsules chain: each one records its predecessor, so a long session leaves a
 * trail rather than one overwritten file.
 *
 * Related but different: `gotchibot handoff` is session → session, `passoff` is
 * agent → agent. Contexter is the same worker across its own memory boundary.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { isMainModule } from "./is-main.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = `${ROOT}/sessions`;
const CAPSULES = `${SESSIONS}/context`;
const LATEST_MD = `${SESSIONS}/CONTEXT.md`;
const FOCUS = `${SESSIONS}/.focus.json`;
const FOCUS_LIST = `${SESSIONS}/.focus-list.json`;
const MEETINGS = `${SESSIONS}/meetings`;

/** Keep capsules small enough that reading one is cheaper than rediscovering. */
const MAX_DIRTY = 20;
const MAX_COMMITS = 8;
const DEFAULT_KEEP = 20;

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function git(args) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", timeout: 8000 });
  return r.status === 0 ? (r.stdout || "").trimEnd() : "";
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* ── facts ──────────────────────────────────────────────────────────────── */

/**
 * Everything a capsule can know without being told. Cheap and local: no SSH,
 * no gateway, no cartridge — a capsule must never fail to save because some
 * service is down, which is exactly when you need it most.
 */
function captureFacts() {
  const dirty = git(["status", "--porcelain"]).split("\n").filter(Boolean);
  const focus = readJson(FOCUS, {}) || {};
  const focusList = readJson(FOCUS_LIST, {}) || {};

  const running = (focusList.entries || [])
    .filter((e) => e.kind === "session" && e.status === "running")
    .map((e) => ({ id: e.id, hero: e.hero || null, host: e.host || "local", model: e.model || null }));

  let meeting = null;
  try {
    const id = String(readFileSync(`${MEETINGS}/.current`, "utf8")).trim();
    const m = id ? readJson(`${MEETINGS}/${id}/meeting.json`) : null;
    if (m?.status === "open") meeting = { id, topic: m.topic || null };
  } catch {
    /* no meeting */
  }

  let passoffs = [];
  try {
    passoffs = readdirSync(`${SESSIONS}/passoff`)
      .filter((n) => n.endsWith(".json"))
      .map((n) => readJson(`${SESSIONS}/passoff/${n}`))
      .filter((p) => p && p.status === "pending")
      .map((p) => ({ id: p.id, from: p.from?.label, to: p.to?.label, task: p.task }));
  } catch {
    /* none */
  }

  return {
    host: hostname().replace(/\.local$/, ""),
    repo: ROOT,
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]) || null,
    head: git(["log", "-1", "--pretty=%h %s"]) || null,
    commits: git(["log", `-${MAX_COMMITS}`, "--pretty=%h %s"]).split("\n").filter(Boolean),
    dirty: dirty.slice(0, MAX_DIRTY),
    dirtyMore: Math.max(0, dirty.length - MAX_DIRTY),
    focus: { mode: focus.mode || null, heroId: focus.heroId || null },
    runningSessions: running,
    meeting,
    pendingPassoffs: passoffs,
  };
}

/* ── capsules ───────────────────────────────────────────────────────────── */

function capsulePaths(id) {
  return { json: `${CAPSULES}/${id}.json`, md: `${CAPSULES}/${id}.md` };
}

export function listCapsules() {
  try {
    return readdirSync(CAPSULES)
      .filter((n) => n.endsWith(".json"))
      .sort()
      .reverse()
      .map((n) => readJson(`${CAPSULES}/${n}`))
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function latestCapsule() {
  return listCapsules()[0] || null;
}

function renderMarkdown(c) {
  const L = [];
  L.push(`# Context capsule ${c.id}`);
  L.push("");
  L.push(
    `${c.at} · ${c.host} · ${c.reason}${c.previous ? ` · follows ${c.previous}` : ""}` +
      `${c.inheritedFrom ? ` · narrative inherited from ${c.inheritedFrom} (facts below are current)` : ""}`,
  );
  L.push("");
  L.push("## Task in flight");
  L.push(c.task || "(not stated — ask before assuming)");

  if (c.decisions?.length) {
    L.push("");
    L.push("## Decisions already made");
    L.push("*Do not re-litigate these; the reason is why they stand.*");
    for (const d of c.decisions) L.push(`- ${d}`);
  }
  if (c.values?.length) {
    L.push("");
    L.push("## Key values");
    L.push("*Identifiers that are expensive to rediscover.*");
    L.push("");
    L.push("| name | value |");
    L.push("|---|---|");
    for (const v of c.values) L.push(`| ${v.k} | \`${v.v}\` |`);
  }
  if (c.tried?.length) {
    L.push("");
    L.push("## Dead ends — already tried, do not repeat");
    for (const t of c.tried) L.push(`- ${t}`);
  }
  if (c.open?.length) {
    L.push("");
    L.push("## Open threads");
    for (const o of c.open) L.push(`- ${o}`);
  }
  if (c.next) {
    L.push("");
    L.push("## Next step");
    L.push(c.next);
  }

  const f = c.facts || {};
  L.push("");
  L.push("## Desk state when this was saved");
  L.push(`- repo \`${f.repo}\` on \`${f.branch}\` @ ${f.head || "?"}`);
  if (f.focus?.heroId) L.push(`- focus ${f.focus.mode || "?"} · hero ${f.focus.heroId}`);
  if (f.dirty?.length) {
    L.push(`- uncommitted (${f.dirty.length}${f.dirtyMore ? `+${f.dirtyMore}` : ""}): ${f.dirty.map((d) => d.slice(3)).join(", ")}`);
  } else {
    L.push("- working tree clean");
  }
  if (f.runningSessions?.length) {
    L.push("- running sessions:");
    for (const s of f.runningSessions) L.push(`  - ${s.id} · ${s.hero || "?"} · ${s.host}${s.model ? ` · ${s.model}` : ""}`);
  }
  if (f.meeting) L.push(`- meeting OPEN: ${f.meeting.topic || f.meeting.id}`);
  if (f.pendingPassoffs?.length) {
    L.push("- pending passoffs:");
    for (const p of f.pendingPassoffs) L.push(`  - ${p.id} ${p.from} → ${p.to}`);
  }
  if (f.commits?.length) {
    L.push("- recent commits:");
    for (const c2 of f.commits) L.push(`  - ${c2}`);
  }

  L.push("");
  L.push("## How to use this");
  L.push(
    "Read it once, then verify anything you are about to act on — a capsule is a " +
      "snapshot, and the tree moves. Continue from **Next step**; do not redo what " +
      "**Decisions** and **Dead ends** already settled.",
  );
  return `${L.join("\n")}\n`;
}

export function saveCapsule({ task = "", decisions = [], values = [], tried = [], open = [], next = "", reason = "manual" } = {}) {
  mkdirSync(CAPSULES, { recursive: true });
  const previous = latestCapsule();
  const now = new Date();

  // A hook-driven save carries facts but no narrative, and it becomes the
  // newest capsule — which would shadow the reasoning someone wrote by hand a
  // moment earlier. Inherit the narrative from the last capsule that had one,
  // so the safety net never costs you the good capsule.
  const bare = !task.trim() && !next.trim() && !decisions.length && !values.length && !tried.length && !open.length;
  const source = bare ? listCapsules().find((c) => c.task || c.next || c.decisions?.length) : null;
  const inherited = Boolean(source);

  const capsule = {
    id: `c${stamp(now)}`,
    at: now.toISOString(),
    host: hostname().replace(/\.local$/, ""),
    reason,
    previous: previous?.id || null,
    inheritedFrom: inherited ? source.id : null,
    task: inherited ? source.task : task.trim(),
    decisions: inherited ? source.decisions || [] : decisions,
    values: inherited ? source.values || [] : values,
    tried: inherited ? source.tried || [] : tried,
    open: inherited ? source.open || [] : open,
    next: inherited ? source.next : next.trim(),
    facts: captureFacts(),
  };
  const paths = capsulePaths(capsule.id);
  writeFileSync(paths.json, `${JSON.stringify(capsule, null, 2)}\n`);
  const md = renderMarkdown(capsule);
  writeFileSync(paths.md, md);
  writeFileSync(LATEST_MD, md);
  return capsule;
}

/**
 * The compact form a fresh window needs first: what we were doing, what is
 * settled, the identifiers, and the next step. Everything else can be read
 * from the capsule on demand.
 */
export function briefFor(c) {
  if (!c) return "";
  const L = [];
  L.push(
    `Context capsule ${c.id} (${c.at}, ${c.reason}) — carried over from before the window turned.` +
      (c.inheritedFrom ? ` Narrative inherited from ${c.inheritedFrom}; the desk state is current.` : ""),
  );
  if (c.task) L.push(`Task: ${c.task}`);
  if (c.next) L.push(`Next step: ${c.next}`);
  if (c.decisions?.length) L.push(`Settled: ${c.decisions.join(" · ")}`);
  if (c.tried?.length) L.push(`Already failed (do not retry): ${c.tried.join(" · ")}`);
  if (c.values?.length) L.push(`Key values: ${c.values.map((v) => `${v.k}=${v.v}`).join(" · ")}`);
  const f = c.facts || {};
  L.push(`Desk: ${f.branch || "?"} @ ${f.head || "?"} · ${f.dirty?.length || 0} uncommitted`);
  if (f.runningSessions?.length) L.push(`Running: ${f.runningSessions.map((s) => `${s.id}(${s.hero || "?"}@${s.host})`).join(" · ")}`);
  if (c.open?.length) L.push(`Open: ${c.open.join(" · ")}`);
  L.push(`Full capsule: sessions/context/${c.id}.md`);
  return L.join("\n");
}

/* ── cli ────────────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const args = { decisions: [], values: [], tried: [], open: [], json: false, brief: false, _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--task") args.task = argv[++i];
    else if (a === "--decision") args.decisions.push(argv[++i]);
    else if (a === "--tried") args.tried.push(argv[++i]);
    else if (a === "--open") args.open.push(argv[++i]);
    else if (a === "--next") args.next = argv[++i];
    else if (a === "--reason") args.reason = argv[++i];
    else if (a === "--keep") args.keep = Number(argv[++i]);
    else if (a === "--json") args.json = true;
    else if (a === "--brief") args.brief = true;
    else if (a === "--value") {
      const raw = String(argv[++i] || "");
      const eq = raw.indexOf("=");
      if (eq > 0) args.values.push({ k: raw.slice(0, eq).trim(), v: raw.slice(eq + 1).trim() });
    } else args._.push(a);
  }
  return args;
}

function usage() {
  console.error(`usage:
  contexter save [--task "…"] [--decision "…"]… [--value name=value]…
                 [--tried "…"]… [--open "…"]… [--next "…"] [--reason precompact|manual]
  contexter latest [--brief] [--json]     # what the next window should read first
  contexter show [<id>] [--json]
  contexter list [--json]
  contexter prune [--keep ${DEFAULT_KEEP}]`);
  process.exit(2);
}

function main() {
  const [cmd = "latest", ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (cmd === "save") {
    const c = saveCapsule({
      task: args.task || "",
      decisions: args.decisions,
      values: args.values,
      tried: args.tried,
      open: args.open,
      next: args.next || "",
      reason: args.reason || "manual",
    });
    if (args.json) console.log(JSON.stringify(c, null, 2));
    else {
      console.log(`saved ${c.id} → sessions/context/${c.id}.md (also sessions/CONTEXT.md)`);
      if (c.inheritedFrom) {
        console.error(`note: no narrative given — inherited it from ${c.inheritedFrom}; facts are current.`);
      } else if (!c.task && !c.next) {
        console.error(
          "note: no --task and no --next — this capsule carries facts only. The narrative is the half a script cannot infer.",
        );
      }
    }
    return;
  }

  if (cmd === "latest") {
    const c = latestCapsule();
    if (!c) {
      console.log("no context capsules yet — save one: ./scripts/gotchibot contexter save --task … --next …");
      return;
    }
    if (args.json) console.log(JSON.stringify(c, null, 2));
    else if (args.brief) console.log(briefFor(c));
    else console.log(readFileSync(capsulePaths(c.id).md, "utf8"));
    return;
  }

  if (cmd === "show") {
    const id = args._[0];
    const c = id ? readJson(capsulePaths(id).json) : latestCapsule();
    if (!c) {
      console.error(id ? `unknown capsule: ${id}` : "no capsules yet");
      process.exit(1);
    }
    if (args.json) console.log(JSON.stringify(c, null, 2));
    else console.log(readFileSync(capsulePaths(c.id).md, "utf8"));
    return;
  }

  if (cmd === "list") {
    const rows = listCapsules();
    if (args.json) {
      console.log(JSON.stringify(rows.map((c) => ({ id: c.id, at: c.at, reason: c.reason, task: c.task })), null, 2));
      return;
    }
    if (!rows.length) {
      console.log("no context capsules yet");
      return;
    }
    for (const c of rows) {
      console.log(`${c.id}  ${c.reason.padEnd(10)} ${(c.task || "(no task stated)").slice(0, 70)}`);
    }
    return;
  }

  if (cmd === "prune") {
    const keep = Number.isFinite(args.keep) ? args.keep : DEFAULT_KEEP;
    const rows = listCapsules();
    const drop = rows.slice(keep);
    for (const c of drop) {
      for (const p of Object.values(capsulePaths(c.id))) rmSync(p, { force: true });
    }
    console.log(`kept ${Math.min(rows.length, keep)}, removed ${drop.length}`);
    return;
  }

  usage();
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(e?.message || e);
    process.exit(1);
  }
}
