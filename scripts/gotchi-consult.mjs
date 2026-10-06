#!/usr/bin/env node
/**
 * Consult — one gotchi asks another and waits for the answer.
 *
 * bot-inbox is fire-and-forget, passoff hands the whole job over; a consult is
 * the synchronous middle: ask a role or hero, block until it replies, keep the
 * thread so follow-ups land in the same conversation.
 *
 *   gotchibot consult <role|n|id|name> "question" [--from <hero>] [--via auto|openclaw|spawn] [--json]
 *   gotchibot consult followup <thread> "question"
 *   gotchibot consult show <thread> [--json]
 *   gotchibot consult list [--json]
 *
 * Roles resolve through config/agent-roles.json (architect → owned-954), anything
 * else through the /switch roster. Threads: sessions/consults/<id>.json. Over
 * OpenClaw each thread gets its own session key, so follow-ups keep context; the
 * spawn fallback replays the thread into the brief instead.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";
import {
  loadAgentMap,
  heroToAgentId,
  orchestratorHeroId,
  gatewayReachable,
  chatViaOpenClaw,
} from "./openclaw-fleet.mjs";
import { heroForRole } from "./orch-route.mjs";
import { recordEdge, closeEdge } from "./agent-graph.mjs";
import { currentProjectSlug, projectRoles, roleBrief } from "./project-context.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STORE = `${ROOT}/sessions/consults`;
const ROLES = `${ROOT}/config/agent-roles.json`;
const MAX_REPLAY_TURNS = 4;
const MAX_REPLAY_CHARS = 1200;

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function truncate(s, max) {
  const t = String(s || "").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function hero(id, role = null) {
  const mapped = loadAgentMap()?.agents?.[id];
  return { id, name: mapped?.name || null, collateral: mapped?.collateral || null, role: role || projectRoles()[id] || null };
}

function label(h) {
  const tag = h.name || (h.collateral ? String(h.collateral).toUpperCase() : null);
  const base = tag && tag !== h.id ? `${tag} (${h.id})` : h.id;
  return h.role && h.role !== h.id ? `${h.role} · ${base}` : base;
}

async function resolveWho(query) {
  const q = String(query || "").trim().replace(/^@/, "");
  if (!q) throw new Error("who? pass a role (architect), roster n, hero id, or name");
  const roles = projectRoles();
  if (Object.values(roles).includes(q)) {
    const id = heroForRole(q);
    if (!id) throw new Error(`no hero seated as ${q} (config/agent-roles.json)`);
    return hero(id, q);
  }
  if (roles[q]) return hero(q);
  const { resolveInviteTarget } = await import("./gotchi-meet.mjs");
  const h = await resolveInviteTarget(q);
  return hero(h.id);
}

function threadPath(id) {
  return `${STORE}/${id}.json`;
}

function loadThread(id) {
  const t = readJson(threadPath(id));
  if (!t) throw new Error(`no consult thread ${id} — list: gotchibot consult list`);
  return t;
}

function saveThread(t) {
  mkdirSync(STORE, { recursive: true });
  writeFileSync(threadPath(t.id), `${JSON.stringify(t, null, 2)}\n`);
}

function brief(t, question, { replay }) {
  const lines = [
    `[consult ${t.id} · ${label(t.from)} is asking you${t.to.role ? ` as ${t.to.role}` : ""} · your reply goes straight back to them]`,
    ...(t.project && t.to?.id ? [roleBrief(t.to.id, t.project)].filter(Boolean) : []),
    "",
  ];
  if (replay && t.turns.length) {
    lines.push("Earlier in this thread:");
    for (const turn of t.turns.slice(-MAX_REPLAY_TURNS)) {
      lines.push(`Q: ${truncate(turn.q, MAX_REPLAY_CHARS)}`, `A: ${truncate(turn.a, MAX_REPLAY_CHARS)}`, "");
    }
    lines.push("Follow-up:");
  }
  lines.push(
    question,
    "",
    "Answer in your role and lead with the answer. If this belongs to another desk, say which one.",
    "Do not start building or spawning: the asker decides what happens next.",
  );
  return lines.join("\n");
}

function askOpenClaw(t, message) {
  return chatViaOpenClaw(heroToAgentId(t.to.id), message, { sessionKey: t.sessionKey }).then((r) =>
    r.ok ? { ok: true, via: "openclaw", reply: String(r.stdout || "").trim() } : { ok: false, reason: r.reason || "openclaw chat failed" },
  );
}

function run(args, { timeoutMs } = {}) {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", timeout: timeoutMs, env: process.env });
  return { ok: r.status === 0, out: `${r.stdout || ""}`.trim(), err: `${r.stderr || ""}`.trim(), status: r.status };
}

function askSpawn(t, message, { waitMin }) {
  const orch = `${ROOT}/scripts/gotchi-orchestrate.mjs`;
  const r = spawnSync(process.execPath, [orch, "spawn", "--host", "auto", "--model", "nim", message], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, GOTCHIBOT_HERO_ID: t.to.id },
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
  if (r.status !== 0) return { ok: false, reason: out || `spawn exit ${r.status}` };
  const landed = out.match(/spawned\s+(\S+)\s+on\s+(\S+)/) || out.match(/\b(s\d{8}-\d{6}-\d+)\b/);
  if (!landed) return { ok: false, reason: `spawned but no session id in: ${truncate(out, 200)}` };
  const sid = landed[1];
  const host = /imac|remote/i.test(landed[2] || "") ? ["--host", "imac"] : [];
  const w = run([orch, "wait", ...host, sid], { timeoutMs: waitMin * 60_000 });
  if (!w.ok) return { ok: false, reason: `session ${sid} did not finish in ${waitMin}m (${truncate(w.err || w.out, 160)})`, sessionId: sid };
  const o = run([orch, "output", ...host, sid]);
  if (!o.ok || !o.out) return { ok: false, reason: `session ${sid} finished without output`, sessionId: sid };
  return { ok: true, via: "spawn", reply: o.out, sessionId: sid };
}

async function deliver(t, question, { via, waitMin }) {
  let mode = via;
  if (mode === "auto") mode = (await gatewayReachable()) ? "openclaw" : "spawn";
  if (mode === "openclaw") {
    const r = await askOpenClaw(t, brief(t, question, { replay: false }));
    if (r.ok || via !== "auto") return r;
    process.stderr.write(`  openclaw: ${r.reason} — falling back to spawn\n`);
  }
  return askSpawn(t, brief(t, question, { replay: true }), { waitMin });
}

function parseArgs(argv) {
  const out = { positional: [], via: "auto", waitMin: 20, json: false, from: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--via") out.via = argv[++i];
    else if (a === "--from") out.from = argv[++i];
    else if (a === "--wait-min") out.waitMin = Math.max(1, Number(argv[++i]) || 20);
    else out.positional.push(a);
  }
  if (!["auto", "openclaw", "spawn"].includes(out.via)) throw new Error(`unknown --via ${out.via} (auto|openclaw|spawn)`);
  return out;
}

async function ask(t, question, args) {
  process.stderr.write(`→ asking ${label(t.to)} (thread ${t.id}) — waiting for the reply…\n`);
  // Agent graph: one edge per question (thread + turn), sent now, closed on reply.
  const edgeId = `consult:${t.id}.${(t.turns || []).length}`;
  await recordEdge({
    edgeId,
    kind: "consult",
    from: t.from?.id,
    to: t.to?.id,
    ref: t.id,
    title: String(question || "").replace(/\s+/g, " ").slice(0, 120),
  });
  const r = await deliver(t, question, args);
  await closeEdge(edgeId, r.ok ? "answered" : "failed");
  if (!r.ok) {
    if (args.json) console.log(JSON.stringify({ ok: false, thread: t.id, to: t.to, reason: r.reason }));
    else console.error(`consult ${t.id}: no reply from ${label(t.to)} — ${r.reason}`);
    process.exit(1);
  }
  t.turns.push({ q: question, a: r.reply, via: r.via, sessionId: r.sessionId || null, at: new Date().toISOString() });
  t.updatedAt = new Date().toISOString();
  saveThread(t);
  if (args.json) {
    console.log(JSON.stringify({ ok: true, thread: t.id, to: t.to, via: r.via, reply: r.reply }));
    return;
  }
  console.log(r.reply);
  console.log(`\n— consult ${t.id} · ${label(t.to)} via ${r.via} · follow up: ./scripts/gotchibot consult followup ${t.id} "…"`);
}

function usage() {
  console.error(`usage:
  gotchibot consult <role|n|id|name> "question" [--from <hero>] [--via auto|openclaw|spawn] [--wait-min 20] [--json]
  gotchibot consult followup <thread> "question" [--via …] [--json]
  gotchibot consult show <thread> [--json]
  gotchibot consult list [--json]`);
  process.exit(2);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "-h" || cmd === "--help") usage();
  const args = parseArgs(rest);

  if (cmd === "list") {
    const threads = existsSync(STORE)
      ? readdirSync(STORE).filter((f) => f.endsWith(".json")).map((f) => readJson(`${STORE}/${f}`)).filter(Boolean)
      : [];
    threads.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    if (args.json) return console.log(JSON.stringify(threads.map(({ turns, ...t }) => ({ ...t, turns: turns.length }))));
    if (!threads.length) return console.log("no consult threads yet");
    for (const t of threads.slice(0, 20)) {
      console.log(`${t.id}  ${label(t.from)} → ${label(t.to)}  ${t.turns.length} turn(s)  ${truncate(t.turns[0]?.q, 60)}`);
    }
    return;
  }

  if (cmd === "show") {
    const t = loadThread(args.positional[0]);
    if (args.json) return console.log(JSON.stringify(t, null, 2));
    console.log(`consult ${t.id}: ${label(t.from)} → ${label(t.to)}`);
    for (const turn of t.turns) console.log(`\nQ (${turn.at}): ${turn.q}\nA (${turn.via}): ${turn.a}`);
    return;
  }

  if (cmd === "followup") {
    const [id, ...q] = args.positional;
    const question = q.join(" ").trim();
    if (!id || !question) usage();
    return ask(loadThread(id), question, args);
  }

  const question = args.positional.join(" ").trim();
  if (!question) usage();
  const to = await resolveWho(cmd);
  const fromId = args.from || process.env.GOTCHIBOT_HERO_ID || orchestratorHeroId() || "orchestrator";
  const from = args.from ? await resolveWho(args.from) : hero(fromId);
  if (from.id === to.id) throw new Error(`${label(to)} cannot consult itself — pick another desk`);
  const id = `q${stamp()}-${process.pid}`;
  const t = {
    id,
    from,
    to,
    sessionKey: `consult:${id}:${heroToAgentId(to.id)}`,
    // The project this consult belongs to: the asked gotchi answers in its role there.
    project: currentProjectSlug() || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    turns: [],
  };
  return ask(t, question, args);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`consult: ${e.message || e}`);
    process.exit(1);
  });
}
