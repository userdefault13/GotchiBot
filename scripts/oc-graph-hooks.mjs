/**
 * OpenClaw → agent graph: turns gateway hook events into graph edges.
 *
 * Loaded by the gotchibot-graph OpenClaw plugin (openclaw-plugins/gotchibot-graph)
 * inside a gateway. Observation only — never blocks or rewrites a run.
 *
 *   run    one edge per bot run (agent_end): trigger → agent, duration, outcome,
 *          and the tokens llm_output reported for that run
 *   spawn  one edge per native sub-agent (subagent_spawned → subagent_ended):
 *          parent agent → child agent, outcome, and the child's tokens
 *
 * Bot-to-bot messages already go through GotchiBot scripts (passoff, consult,
 * inbox), which record their own edges; OpenClaw's agentToAgent is off.
 */
import { hostname } from "node:os";
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_TRACKED = 500;
// Module-relative root. Inside a gateway this is NOT the repo: OpenClaw runs a
// linked plugin from a capture copy (~/.openclaw/tmp/plugin-captures/…), so the
// plugin passes the real repo root from its config (plugins.entries.gotchibot-graph.config.root).
const HERE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tracePath = (root) => join(root, "sessions", "graph", "plugin.log");
const TRACE = tracePath(HERE_ROOT);
const TRACE_MAX = 512 * 1024;

/**
 * One line per hook call (which ids were present — never prompt/reply text) and
 * every record error, so a run that leaves no edge can be explained. Capped.
 */
export function traceLine(path = TRACE) {
  return (msg) => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      let size = 0;
      try {
        size = statSync(path).size;
      } catch {}
      if (size < TRACE_MAX) appendFileSync(path, `${new Date().toISOString()} ${msg}\n`);
    } catch {
      /* tracing must never break a run */
    }
  };
}

function slug(s) {
  return String(s || "").replace(/[^A-Za-z0-9_.:-]+/g, "-").slice(0, 70);
}

/** `agent:<agentId>:…` → agentId. */
export function agentOfSessionKey(key) {
  const m = /^agent:([^:]+):/.exec(String(key || ""));
  return m ? m[1] : null;
}

/** Who started a run: chat (a message from UserDefault or a script), cron, heartbeat, … */
export function runSource(ctx = {}) {
  const t = String(ctx.trigger || "").toLowerCase();
  if (!t || t === "user" || t === "manual") return "chat";
  return slug(t) || "chat";
}

function addUsage(into, u) {
  if (!u) return into;
  const out = into || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  for (const k of ["input", "output", "cacheRead", "cacheWrite"]) out[k] += Number(u[k]) || 0;
  out.total += Number(u.total) || (Number(u.input) || 0) + (Number(u.output) || 0);
  return out;
}

const SUB_OUTCOME = { ok: "done", error: "failed", timeout: "failed", killed: "dropped", reset: "dropped", deleted: "dropped" };

/** Bounded Map: drop the oldest entry past MAX_TRACKED (a run whose agent_end never came). */
function remember(map, key, value) {
  map.set(key, value);
  if (map.size > MAX_TRACKED) map.delete(map.keys().next().value);
}

/**
 * Handlers keyed by OpenClaw hook name. `record(edge)` writes an edge (default:
 * recordEdge from agent-graph.mjs, fire-and-forget).
 */
export function createGraphHooks({ record, host = hostname(), now = () => Date.now(), trace = () => {} } = {}) {
  const gw = slug(host.split(".")[0]) || "gw";
  const runTokens = new Map(); // runId → usage
  const runModel = new Map(); // runId → provider/model
  const spawns = new Map(); // childSessionKey → { edgeId, tokens }
  const ended = new Map(); // runId → edgeId, for usage that arrives after agent_end
  const runEdgeId = (runId) => `run:${gw}.${slug(runId)}`;

  const write = (edge) => {
    const fail = (e) => trace(`record-error ${edge.edgeId}: ${String(e?.message || e).slice(0, 200)}`);
    try {
      const p = record(edge);
      if (p && typeof p.then === "function") p.then((r) => (r == null ? trace(`record-null ${edge.edgeId}`) : null), fail);
    } catch (e) {
      fail(e);
    }
  };
  const seen = (hook, ids) => trace(`${hook} ${Object.entries(ids).map(([k, v]) => `${k}=${v ? "y" : "-"}`).join(" ")}`);

  return {
    llm_output(event = {}, ctx = {}) {
      const runId = event.runId || ctx.runId;
      seen("llm_output", { runId, usage: event.usage });
      if (!runId) return;
      const tokens = addUsage(runTokens.get(runId), event.usage);
      remember(runTokens, runId, tokens);
      const model = event.resolvedRef || [event.provider, event.model].filter(Boolean).join("/");
      if (model) remember(runModel, runId, model);
      // A native sub-agent's usage rolls up into its spawn edge (closed at subagent_ended).
      const sub = ctx.sessionKey && spawns.get(ctx.sessionKey);
      if (sub && event.usage) sub.tokens = addUsage(sub.tokens, event.usage);
      // OpenClaw can fire agent_end before the run's last llm_output: update the
      // already-written run edge (same edgeId) with the running total.
      if (ended.has(runId) && event.usage) write({ edgeId: ended.get(runId), tokens, ...(model ? { model } : {}) });
    },

    agent_end(event = {}, ctx = {}) {
      const runId = event.runId || ctx.runId;
      const agent = ctx.agentId || agentOfSessionKey(ctx.sessionKey);
      seen("agent_end", { runId, agentId: ctx.agentId, sessionKey: ctx.sessionKey, trigger: ctx.trigger });
      if (!runId || !agent) return;
      const tokens = runTokens.get(runId);
      const model = runModel.get(runId) || [ctx.modelProviderId, ctx.modelId].filter(Boolean).join("/") || undefined;
      remember(ended, runId, runEdgeId(runId));
      const end = now();
      const ms = Number(event.durationMs) || 0;
      write({
        edgeId: runEdgeId(runId),
        kind: "run",
        from: runSource(ctx),
        fromRole: runSource(ctx),
        to: agent,
        ref: ctx.sessionKey ? slug(ctx.sessionKey) : undefined,
        title: event.success === false && event.error ? String(event.error).slice(0, 120) : undefined,
        sentAt: new Date(end - ms).toISOString(),
        answeredAt: new Date(end).toISOString(),
        outcome: event.success === false ? "failed" : "done",
        declared: true,
        tokens,
        model,
      });
    },

    subagent_spawned(event = {}, ctx = {}) {
      const child = event.childSessionKey || ctx.childSessionKey;
      seen("subagent_spawned", { child, agentId: event.agentId });
      if (!child || !event.agentId) return;
      const parent = agentOfSessionKey(ctx.requesterSessionKey) || "chat";
      const edgeId = `spawn:${gw}.${slug(child)}`;
      remember(spawns, child, { edgeId, tokens: null });
      write({
        edgeId,
        kind: "spawn",
        from: parent,
        to: event.agentId,
        ref: slug(child),
        title: event.label ? String(event.label).slice(0, 120) : undefined,
        sentAt: new Date(now()).toISOString(),
        model: event.resolvedModel,
      });
    },

    subagent_ended(event = {}) {
      const child = event.targetSessionKey;
      if (!child) return;
      const sub = spawns.get(child);
      spawns.delete(child);
      write({
        edgeId: sub?.edgeId || `spawn:${gw}.${slug(child)}`,
        answeredAt: new Date(event.endedAt || now()).toISOString(),
        outcome: SUB_OUTCOME[event.outcome] || (event.error ? "failed" : "done"),
        tokens: sub?.tokens || undefined,
      });
    },
  };
}

/**
 * Plugin wiring: register every handler on the OpenClaw plugin api. Synchronous
 * (register() is not awaited); agent-graph.mjs loads on the first edge — from the
 * live repo at `root` (absolute path), never from the gateway's capture copy.
 */
export function registerGraphHooks(api, opts = {}) {
  const root = opts.root || api?.pluginConfig?.root || null;
  let graph;
  const load = () => (graph ||= import(root ? pathToFileURL(join(root, "scripts", "agent-graph.mjs")).href : "./agent-graph.mjs"));
  const record = opts.record || ((edge) => load().then((m) => m.recordEdge(edge, { warn: false, ...(root ? { root } : {}) })));
  // Tests inject their own recorder; only a real gateway traces to <root>/sessions/graph/plugin.log.
  const trace = opts.trace || (opts.record ? () => {} : traceLine(root ? tracePath(root) : TRACE));
  const hooks = createGraphHooks({ ...opts, record, trace });
  trace(root ? `registered root=${root}` : "registered WITHOUT config.root — edges land in the capture copy; run: gotchibot graph plugin install");
  for (const [name, fn] of Object.entries(hooks)) api.on(name, fn, { timeoutMs: 2000 });
  return hooks;
}
