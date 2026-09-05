#!/usr/bin/env node
/**
 * Passoff — hand live work from one cAavegotchi to another.
 *
 * Julius starts a job with one gotchi, walks away, comes back and wants a
 * different gotchi on it. The outgoing agent captures what it already knows
 * (branch, dirty tree, its session, thread anchor, open meeting) into a packet,
 * messages the incoming agent, and that agent picks up mid-stride instead of
 * rediscovering the job.
 *
 *   node scripts/passoff.mjs capture [--from <n|id|name>] [--note "…"] [--next "…"]
 *   node scripts/passoff.mjs send <to> [--from …] [--note …] [--next …]
 *                                 [--via openclaw|spawn|meet|none] [--dry-run]
 *   node scripts/passoff.mjs list [--to <n|id|name>] [--all] [--json]
 *   node scripts/passoff.mjs show [<id>] [--json]
 *   node scripts/passoff.mjs accept [<id>] [--as <n|id|name>] [--claim]
 *   node scripts/passoff.mjs resume [--as <n|id|name>] [--claim]
 *   node scripts/passoff.mjs drop <id>
 *
 * Facts only: everything in a packet is read from the working tree, the session
 * dirs, or the meeting transcript. Never invent progress, agents, or next steps.
 */
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";
import { resolveInviteTarget } from "./gotchi-meet.mjs";
import { loadCurrentMeeting, readTranscript, participantInfo } from "./meet-channel.mjs";
import {
  loadAgentMap,
  heroToAgentId,
  orchestratorHeroId,
  gatewayReachable,
  chatViaOpenClaw,
} from "./openclaw-fleet.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = `${ROOT}/sessions`;
const PACKETS = `${SESSIONS}/passoff`;
const LATEST_MD = `${SESSIONS}/PASSOFF.md`;
const FOCUS = `${SESSIONS}/.focus.json`;
const ANCHOR = `${SESSIONS}/.thread-anchor.json`;
const FOCUS_LIST = `${SESSIONS}/.focus-list.json`;

/** Caps — a packet is a briefing, not an archive. */
const MAX_DIRTY = 30;
const MAX_STAT = 30;
const MAX_PROMPT = 700;
const MAX_OUTPUT = 1400;
const MAX_TURNS = 6;
const MAX_TURN_CHARS = 320;
/** Older than this and the anchor points at last week's job, not this one. */
const ANCHOR_MAX_AGE_H = 48;
/** A session older than this is history, not the job in flight. */
const SESSION_WARM_H = 12;

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function readText(path, fallback = "") {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return fallback;
  }
}

function truncate(s, max) {
  const t = String(s || "").trim();
  return t.length <= max ? t : `${t.slice(0, max)}\n…[truncated]`;
}

function firstLine(s, max = 120) {
  const line = String(s || "")
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find(Boolean);
  return line ? (line.length > max ? `${line.slice(0, max)}…` : line) : "";
}

function git(args) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", timeout: 8000 });
  return r.status === 0 ? (r.stdout || "").trimEnd() : "";
}

function capLines(text, max) {
  const lines = String(text || "").split("\n").filter(Boolean);
  return {
    lines: lines.slice(0, max),
    more: Math.max(0, lines.length - max),
  };
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes(),
  )}${p(d.getSeconds())}`;
}

/* ── roster ─────────────────────────────────────────────────────────────── */

function heroLabel(hero) {
  if (!hero) return "?";
  const tag = hero.name || (hero.collateral ? String(hero.collateral).toUpperCase() : null);
  return tag && tag !== hero.id ? `${tag} (${hero.id})` : hero.id;
}

function mentionTag(hero) {
  const raw = hero?.name || hero?.collateral || hero?.id || "";
  return `@${String(raw).replace(/\s+/g, "").toUpperCase()}`;
}

function heroById(id) {
  const mapped = loadAgentMap()?.agents?.[id];
  return {
    id,
    name: mapped?.name || null,
    collateral: mapped?.collateral || null,
    isOrchestrator: !!mapped?.isOrchestrator,
  };
}

/** Who is speaking — explicit --from, else the focused hero, else the orchestrator. */
async function resolveFrom(query) {
  if (query) return resolveInviteTarget(query);
  const focus = readJson(FOCUS, {});
  const id = focus?.heroId || orchestratorHeroId();
  if (!id) throw new Error("no from-hero — pass --from <n|id|name> (roster: /switch)");
  return heroById(id);
}

/** Who is being handed to — explicit --as, else the focused hero. */
async function resolveMe(query) {
  return resolveFrom(query);
}

/* ── capture ────────────────────────────────────────────────────────────── */

function sessionsForHero(heroId) {
  let names = [];
  try {
    names = readdirSync(SESSIONS).filter(
      (n) => /^s\d{8}-\d{6}-/.test(n) && statSync(`${SESSIONS}/${n}`).isDirectory(),
    );
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.sort().reverse()) {
    const env = {};
    for (const line of readText(`${SESSIONS}/${name}/state.env`).split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
    }
    if (env.hero !== heroId) continue;
    out.push({ id: name, ...env });
    if (out.length >= 3) break;
  }
  return out;
}

function remoteSessionsForHero(heroId) {
  const list = readJson(FOCUS_LIST, {});
  const rows = list?.remote?.sessions || [];
  return rows.filter((r) => r.hero === heroId).slice(0, 3);
}

function captureGit() {
  const dirty = capLines(git(["status", "--porcelain"]), MAX_DIRTY);
  const stat = capLines(git(["diff", "--stat", "HEAD"]), MAX_STAT);
  return {
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]) || null,
    head: git(["log", "-1", "--pretty=%h %s"]) || null,
    recent: git(["log", "-5", "--pretty=%h %ad %s", "--date=short"]).split("\n").filter(Boolean),
    dirty: dirty.lines,
    dirtyMore: dirty.more,
    diffStat: stat.lines,
    diffStatMore: stat.more,
  };
}

function captureMeeting() {
  const meeting = loadCurrentMeeting();
  if (!meeting) return null;
  const turns = readTranscript(meeting.id).slice(-MAX_TURNS).map((t) => ({
    speaker: participantInfo(meeting, t.speaker).name,
    ts: t.ts,
    text: truncate(t.text, MAX_TURN_CHARS),
  }));
  return { id: meeting.id, topic: meeting.topic || null, turns };
}

function captureSession(heroId) {
  const local = sessionsForHero(heroId);
  const newest = local[0] || null;
  if (!newest) return { local: [], remote: remoteSessionsForHero(heroId), newest: null };
  const started = newest.started ? new Date(newest.started).getTime() : 0;
  const warm =
    newest.status === "running" || (!!started && Date.now() - started < SESSION_WARM_H * 3_600_000);
  return {
    local: local.map((s) => ({ id: s.id, model: s.model || null, status: s.status || null, started: s.started || null })),
    remote: remoteSessionsForHero(heroId),
    newest: {
      id: newest.id,
      model: newest.model || null,
      status: newest.status || null,
      started: newest.started || null,
      warm,
      // A cold session is someone else's finished job — name it, don't quote it.
      prompt: warm ? truncate(readText(`${SESSIONS}/${newest.id}/prompt.txt`), MAX_PROMPT) : null,
      output: warm
        ? truncate(
            readText(`${SESSIONS}/${newest.id}/output.md`).split("\n").slice(-40).join("\n"),
            MAX_OUTPUT,
          )
        : null,
    },
  };
}

/**
 * A finished session from last week says nothing about the job being passed —
 * only borrow its prompt as the task line while that session is still warm.
 */
function warmSessionPrompt(newest) {
  return newest?.warm ? newest.prompt || "" : "";
}

/**
 * The thread anchor is only worth carrying while it is warm — a week-old anchor
 * for another repo sends the incoming agent to the wrong file.
 */
function captureAnchor() {
  const anchor = readJson(ANCHOR, null);
  if (!anchor) return { anchor: null, anchorStale: null };
  const ageH = anchor.updatedAt
    ? Math.round((Date.now() - new Date(anchor.updatedAt).getTime()) / 3_600_000)
    : null;
  if (ageH == null || ageH > ANCHOR_MAX_AGE_H) {
    return { anchor: null, anchorStale: { topic: anchor.topic || null, ageHours: ageH } };
  }
  return { anchor: { ...anchor, ageHours: ageH }, anchorStale: null };
}

export function buildPacket({ from, to, note = "", next = "", task = "" }) {
  const now = new Date();
  const session = captureSession(from.id);
  const { anchor, anchorStale } = captureAnchor();
  const derivedTask =
    task ||
    firstLine(note) ||
    (anchor?.lastIntent ? String(anchor.lastIntent) : "") ||
    firstLine(warmSessionPrompt(session.newest)) ||
    "(task not stated — ask Julius before assuming)";
  return {
    id: `p${stamp(now)}-${Math.floor(Math.random() * 90000 + 10000)}`,
    at: now.toISOString(),
    status: "pending",
    from: { id: from.id, label: heroLabel(from) },
    to: to ? { id: to.id, label: heroLabel(to) } : null,
    task: derivedTask,
    note: note.trim() || null,
    next: next.trim() || null,
    repo: ROOT,
    git: captureGit(),
    session,
    anchor,
    anchorStale,
    meeting: captureMeeting(),
    project: readText(`${SESSIONS}/.project-current`).trim() || null,
    handoff: existsSync(`${SESSIONS}/HANDOFF.md`) ? "sessions/HANDOFF.md" : null,
  };
}

/* ── render ─────────────────────────────────────────────────────────────── */

export function packetMarkdown(p) {
  const L = [];
  L.push(`# PASSOFF ${p.id} — ${p.from.label} → ${p.to ? p.to.label : "(unsent)"}`);
  L.push("");
  L.push(`Captured ${p.at} · status **${p.status}**`);
  L.push("");
  L.push(`## Task`);
  L.push(p.task);
  if (p.note && p.note !== p.task) {
    L.push("");
    L.push(`## Done so far (from ${p.from.label})`);
    L.push(p.note);
  }
  if (p.next) {
    L.push("");
    L.push(`## Next step`);
    L.push(p.next);
  }
  L.push("");
  L.push(`## Working tree`);
  L.push(`- repo: \`${p.repo}\``);
  L.push(`- branch: \`${p.git.branch || "?"}\` @ ${p.git.head || "?"}`);
  if (p.project) L.push(`- project: ${p.project}`);
  if (p.git.dirty.length) {
    L.push(`- uncommitted (${p.git.dirty.length}${p.git.dirtyMore ? `+${p.git.dirtyMore} more` : ""}):`);
    for (const d of p.git.dirty) L.push(`  - \`${d}\``);
  } else {
    L.push("- uncommitted: clean");
  }
  if (p.git.diffStat.length) {
    L.push("- diff vs HEAD:");
    for (const d of p.git.diffStat) L.push(`  - ${d.trim()}`);
    if (p.git.diffStatMore) L.push(`  - …${p.git.diffStatMore} more`);
  }
  if (p.git.recent.length) {
    L.push("- recent commits:");
    for (const c of p.git.recent) L.push(`  - ${c}`);
  }
  if (p.anchorStale) {
    L.push("");
    L.push(
      `## Thread anchor: stale (${p.anchorStale.ageHours ?? "?"}h old, topic ${p.anchorStale.topic || "?"}) — not carried over`,
    );
  }
  if (p.anchor) {
    L.push("");
    L.push(`## Thread anchor (sessions/.thread-anchor.json, ${p.anchor.ageHours}h old)`);
    L.push("```json");
    L.push(truncate(JSON.stringify(p.anchor, null, 2), 1200));
    L.push("```");
  }
  if (p.session.newest) {
    const s = p.session.newest;
    L.push("");
    L.push(
      `## ${p.from.label} last session — ${s.id} (${s.model || "?"}, ${s.status || "?"}${
        s.warm ? "" : ", cold — started " + (s.started || "?")
      })`,
    );
    if (!s.warm) {
      L.push("");
      L.push(
        `Not carried over: this session predates the passoff window, so its prompt and output are not quoted here. Read it with \`./scripts/gotchibot output ${s.id}\` only if it turns out to be relevant.`,
      );
    }
    if (s.prompt) {
      L.push("");
      L.push("### It was spawned with");
      L.push("```");
      L.push(s.prompt);
      L.push("```");
    }
    if (s.output) {
      L.push("");
      L.push("### It reported (tail of output.md)");
      L.push("```");
      L.push(s.output);
      L.push("```");
    }
  }
  if (p.session.remote?.length) {
    L.push("");
    L.push(`## Remote (iMac) sessions for ${p.from.label}`);
    for (const r of p.session.remote) L.push(`- ${r.id} (${r.model || "?"}, ${r.status || "?"})`);
  }
  if (p.meeting) {
    L.push("");
    L.push(`## Open meeting — ${p.meeting.topic || p.meeting.id}`);
    for (const t of p.meeting.turns) L.push(`- **${t.speaker}**: ${t.text.replace(/\n/g, " ")}`);
  }
  if (p.handoff) {
    L.push("");
    L.push(`## Also on disk`);
    L.push(`- \`${p.handoff}\` (session handoff from \`gotchibot handoff\`)`);
  }
  L.push("");
  L.push(`## Instructions for ${p.to ? p.to.label : "the incoming gotchi"}`);
  L.push(
    [
      "Load skill `passoff`. This work is already underway — do not restart it.",
      "Verify the state above against the tree before building on it (facts age).",
      "Do not redo finished work. Do not invent progress that is not listed here.",
      `Full packet: \`sessions/passoff/${p.id}.json\``,
    ].join(" "),
  );
  return `${L.join("\n")}\n`;
}

/** The short message that actually wakes the incoming agent. */
export function packetBrief(p) {
  const L = [];
  L.push(`[passoff ${p.id}] ${p.from.label} → ${p.to ? p.to.label : "?"}`);
  L.push("");
  L.push(`Task: ${p.task}`);
  L.push(`Repo: ${p.repo} · branch ${p.git.branch || "?"} @ ${p.git.head || "?"}`);
  L.push(
    p.git.dirty.length
      ? `Uncommitted: ${p.git.dirty.length}${p.git.dirtyMore ? `+${p.git.dirtyMore}` : ""} file(s) — ${p.git.dirty
          .slice(0, 3)
          .map((d) => d.slice(3))
          .join(", ")}`
      : "Uncommitted: clean",
  );
  if (p.session.newest) {
    L.push(
      `Last session: ${p.session.newest.id} (${p.session.newest.model || "?"}, ${p.session.newest.status || "?"})`,
    );
  }
  if (p.anchor?.files?.length || p.anchor?.selector) {
    L.push(`Anchor: ${(p.anchor.files || []).join(", ")}${p.anchor.selector ? ` :: ${p.anchor.selector}` : ""}`);
  }
  if (p.note) L.push(`Done so far: ${firstLine(p.note, 300)}`);
  if (p.next) L.push(`Next step: ${firstLine(p.next, 300)}`);
  L.push("");
  L.push(`Pick it up: ./scripts/passoff.mjs accept ${p.id}`);
  L.push("Load skill `passoff`. Continue the work — do not restart it, do not redo finished steps.");
  return L.join("\n");
}

/* ── store ──────────────────────────────────────────────────────────────── */

function packetPath(id) {
  return `${PACKETS}/${id}.json`;
}

function savePacket(p, { latest = true } = {}) {
  mkdirSync(PACKETS, { recursive: true });
  writeFileSync(packetPath(p.id), `${JSON.stringify(p, null, 2)}\n`);
  if (latest) writeFileSync(LATEST_MD, packetMarkdown(p));
  return p;
}

export function listPackets({ to = null, all = false } = {}) {
  let names = [];
  try {
    names = readdirSync(PACKETS).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  return names
    .sort()
    .reverse()
    .map((n) => readJson(`${PACKETS}/${n}`, null))
    .filter(Boolean)
    .filter((p) => (all ? true : p.status === "pending"))
    .filter((p) => (to ? p.to?.id === to : true));
}

function loadPacket(id) {
  if (!id) {
    const [newest] = listPackets({ all: true });
    if (!newest) throw new Error("no passoff packets yet — run: passoff send <to>");
    return newest;
  }
  const p = readJson(packetPath(id), null);
  if (!p) throw new Error(`unknown passoff packet: ${id}`);
  return p;
}

/* ── delivery ───────────────────────────────────────────────────────────── */

async function deliverOpenClaw(p, brief) {
  if (!(await gatewayReachable())) {
    return { ok: false, reason: "gateway-unreachable" };
  }
  const agentId = heroToAgentId(p.to.id) || p.to.id;
  const r = await chatViaOpenClaw(agentId, brief);
  return r.ok ? { ok: true, via: r.via || "openclaw", agentId, stdout: r.stdout || "" } : { ok: false, reason: r.reason, agentId };
}

/**
 * Spawn delivery has to answer two questions the gateway path never asks: which
 * hero picks this up, and *where* the work lives. A packet whose repo is on the
 * iMac is useless to an agent spawned on this laptop, and a spawn that falls
 * back to the orchestrator hero is not a handoff at all — both happened the
 * first time this ran.
 */
function deliverSpawn(p, brief, { model = "nim", host = null } = {}) {
  const args = [`${ROOT}/scripts/gotchi-orchestrate.mjs`, "spawn"];
  if (host) args.push("--host", host);
  args.push("--model", model, brief);
  const r = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      GOTCHIBOT_HERO_ID: p.to.id,
    },
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
  if (r.status !== 0) return { ok: false, reason: out || `exit ${r.status}` };
  const landed = out.match(/spawned\s+(\S+)\s+on\s+(\S+).*?hero=(\S+?)[,)\s]/);
  if (landed) {
    const [, sid, whereRan, heroRan] = landed;
    // Landing on the wrong machine means the agent cannot see the work at all —
    // that is a failed delivery, not a warning.
    if (host && !whereRan.includes(host)) {
      return {
        ok: false,
        reason:
          `spawn landed as ${sid} on ${whereRan}, but this packet's work is on ${host} — ` +
          `kill ${sid} and retry; an agent on the wrong desk cannot see the repo`,
        stdout: out,
      };
    }
    if (heroRan !== p.to.id) {
      console.error(`[passoff] note: spawn reports hero ${heroRan}, packet is addressed to ${p.to.id}`);
    }
  }
  return { ok: true, via: host ? `spawn:${host}` : "spawn", stdout: out };
}

function deliverMeet(p, brief) {
  if (!loadCurrentMeeting()) return { ok: false, reason: "no-open-meeting" };
  const r = spawnSync(
    process.execPath,
    [`${ROOT}/scripts/gotchi-meet.mjs`, "say", `${mentionTag(p.to)} ${brief}`],
    { cwd: ROOT, encoding: "utf8" },
  );
  const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
  return r.status === 0 ? { ok: true, via: "meet", stdout: out } : { ok: false, reason: out || `exit ${r.status}` };
}

/* ── commands ───────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const args = { _: [], via: null, json: false, all: false, dryRun: false, claim: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from") args.from = argv[++i];
    else if (a === "--to") args.to = argv[++i];
    else if (a === "--as") args.as = argv[++i];
    else if (a === "--note") args.note = argv[++i];
    else if (a === "--next") args.next = argv[++i];
    else if (a === "--task") args.task = argv[++i];
    else if (a === "--via") args.via = argv[++i];
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--host") args.host = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a === "--all") args.all = true;
    else if (a === "--dry-run" || a === "--dry") args.dryRun = true;
    else if (a === "--claim") args.claim = true;
    else args._.push(a);
  }
  return args;
}

async function cmdCapture(args) {
  const from = await resolveFrom(args.from);
  const to = args.to ? await resolveInviteTarget(args.to) : null;
  const p = savePacket(
    buildPacket({ from, to, note: args.note || "", next: args.next || "", task: args.task || "" }),
  );
  if (args.json) {
    console.log(JSON.stringify(p, null, 2));
    return;
  }
  console.log(packetMarkdown(p));
  console.log(`saved: sessions/passoff/${p.id}.json · sessions/PASSOFF.md`);
  console.log(`send it: ./scripts/passoff.mjs send <to> --from ${from.id}`);
}

async function cmdSend(args) {
  const target = args._[0] || args.to;
  if (!target) throw new Error('usage: passoff send <to> [--from …] [--note "…"] [--next "…"]');
  const from = await resolveFrom(args.from);
  const to = await resolveInviteTarget(target);
  if (to.id === from.id) {
    throw new Error(`passoff needs two different gotchis — ${from.id} cannot hand off to itself`);
  }

  const p = buildPacket({
    from,
    to,
    note: args.note || "",
    next: args.next || "",
    task: args.task || "",
  });
  const brief = packetBrief(p);
  const via = args.via || "openclaw";

  if (args.dryRun) {
    console.log(brief);
    console.log("");
    console.log(`[dry-run] would deliver via ${via} to ${heroLabel(to)} — nothing sent, packet not saved`);
    return;
  }

  savePacket(p);

  let result = { ok: true, via: "none" };
  if (via === "openclaw") {
    result = await deliverOpenClaw(p, brief);
    if (!result.ok) {
      console.error(`openclaw delivery failed (${result.reason})`);
      console.error(
        `packet is saved and still pending — retry: ./scripts/passoff.mjs send ${to.id} --via spawn`,
      );
      console.error(`or let ${heroLabel(to)} collect it: ./scripts/passoff.mjs resume --as ${to.id}`);
    }
  } else if (via === "spawn") {
    result = deliverSpawn(p, brief, { model: args.model || "nim", host: args.host || null });
    if (!result.ok) console.error(`spawn delivery failed: ${result.reason}`);
  } else if (via === "meet") {
    result = deliverMeet(p, brief);
    if (!result.ok) console.error(`meet delivery failed (${result.reason})`);
  } else if (via !== "none") {
    throw new Error(`unknown --via ${via} (openclaw|spawn|meet|none)`);
  }

  p.delivery = { via, ok: result.ok, reason: result.reason || null, at: new Date().toISOString() };
  savePacket(p, { latest: false });

  if (args.json) {
    console.log(JSON.stringify({ id: p.id, from: p.from, to: p.to, delivery: p.delivery }, null, 2));
  } else {
    if (result.stdout) console.log(result.stdout.trim());
    const verdict = !result.ok
      ? `NOT delivered (${result.reason}) — packet pending`
      : via === "none"
        ? `saved, not delivered — collect with: ./scripts/passoff.mjs resume --as ${to.id}`
        : `delivered via ${result.via || via}`;
    console.log(`passoff ${p.id}: ${heroLabel(from)} → ${heroLabel(to)} · ${verdict}`);
    console.log(`packet: sessions/passoff/${p.id}.json · brief: sessions/PASSOFF.md`);
  }
  if (!result.ok) process.exitCode = 1;
}

async function cmdList(args) {
  const to = args.to ? (await resolveInviteTarget(args.to)).id : null;
  const rows = listPackets({ to, all: args.all });
  if (args.json) {
    console.log(JSON.stringify(rows.map((p) => ({ id: p.id, at: p.at, status: p.status, from: p.from, to: p.to, task: p.task })), null, 2));
    return;
  }
  if (!rows.length) {
    console.log(args.all ? "no passoff packets" : "no pending passoffs (use --all for history)");
    return;
  }
  for (const p of rows) {
    console.log(
      `${p.id}  ${p.status.padEnd(8)} ${p.from.label} → ${p.to ? p.to.label : "(unsent)"}  ${firstLine(p.task, 60)}`,
    );
  }
}

async function cmdShow(args) {
  const p = loadPacket(args._[0]);
  if (args.json) console.log(JSON.stringify(p, null, 2));
  else console.log(packetMarkdown(p));
}

async function claimHero(p) {
  try {
    const { setHeroAgentStatus } = await import("./hero-agent-state.mjs");
    await setHeroAgentStatus(p.to.id, "working", { task: firstLine(p.task, 80) });
    console.log(`hero-state: ${p.to.id} → working`);
  } catch (e) {
    console.error(`hero-state not updated (${e?.message || e}) — continue anyway`);
  }
}

async function cmdAccept(args, { pendingOnly = false } = {}) {
  const me = args.as ? await resolveInviteTarget(args.as) : await resolveMe(null);
  let p;
  if (args._[0]) {
    p = loadPacket(args._[0]);
  } else {
    [p] = listPackets({ to: me.id });
    if (!p) {
      if (pendingOnly) {
        console.log(`no pending passoff for ${heroLabel(me)}`);
        return;
      }
      throw new Error(`no pending passoff for ${heroLabel(me)} — list: ./scripts/passoff.mjs list --all`);
    }
  }
  if (p.to && p.to.id !== me.id) {
    console.error(`note: ${p.id} was addressed to ${p.to.label}, accepting as ${heroLabel(me)}`);
  }
  p.status = "accepted";
  p.acceptedAt = new Date().toISOString();
  p.acceptedBy = { id: me.id, label: heroLabel(me) };
  savePacket(p);
  if (args.claim) await claimHero({ ...p, to: { id: me.id } });
  if (args.json) console.log(JSON.stringify(p, null, 2));
  else {
    console.log(packetMarkdown(p));
    console.log(`accepted ${p.id} as ${heroLabel(me)} — continue this work, do not restart it.`);
  }
}

function cmdDrop(args) {
  const p = loadPacket(args._[0]);
  p.status = "dropped";
  p.droppedAt = new Date().toISOString();
  savePacket(p, { latest: false });
  console.log(`dropped ${p.id} (${p.from.label} → ${p.to ? p.to.label : "?"})`);
}

function usage() {
  console.error(`usage:
  passoff capture [--from <n|id|name>] [--to <n|id|name>] [--note "…"] [--next "…"] [--json]
  passoff send <to> [--from …] [--note "…"] [--next "…"] [--task "…"]
                    [--via openclaw|spawn|meet|none] [--model nim] [--host imac|local]
                    [--dry-run] [--json]
  passoff list [--to <n|id|name>] [--all] [--json]
  passoff show [<id>] [--json]
  passoff accept [<id>] [--as <n|id|name>] [--claim] [--json]
  passoff resume [--as <n|id|name>] [--claim]      # newest pending packet for me
  passoff drop <id>`);
  process.exit(2);
}

const COMMANDS = new Set(["capture", "send", "list", "show", "accept", "resume", "drop"]);

async function main() {
  let [cmd, ...rest] = process.argv.slice(2);
  // `/passoff` alone lists; `/passoff LINK` is the common case — send to LINK.
  if (!cmd) cmd = "list";
  else if (!COMMANDS.has(cmd) && !cmd.startsWith("-")) rest = [cmd, ...rest], (cmd = "send");
  const args = parseArgs(rest);
  switch (cmd) {
    case "capture":
      return cmdCapture(args);
    case "send":
      return cmdSend(args);
    case "list":
      return cmdList(args);
    case "show":
      return cmdShow(args);
    case "accept":
      return cmdAccept(args);
    case "resume":
      return cmdAccept(args, { pendingOnly: true });
    case "drop":
      return cmdDrop(args);
    default:
      return usage();
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e?.message || e);
    process.exit(1);
  });
}
