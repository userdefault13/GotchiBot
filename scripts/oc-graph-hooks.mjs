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

const MAX_TRACKED = 500;

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
export function createGraphHooks({ record, host = hostname(), now = () => Date.now() } = {}) {
  const gw = slug(host.split(".")[0]) || "gw";
  const runTokens = new Map(); // runId → usage
  const runModel = new Map(); // runId → provider/model
  const spawns = new Map(); // childSessionKey → { edgeId, tokens }

  const write = (edge) => {
    try {
      const p = record(edge);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      /* never break a run */
    }
  };

  return {
    llm_output(event = {}, ctx = {}) {
      const runId = event.runId || ctx.runId;
      if (!runId) return;
      remember(runTokens, runId, addUsage(runTokens.get(runId), event.usage));
      const model = event.resolvedRef || [event.provider, event.model].filter(Boolean).join("/");
      if (model) remember(runModel, runId, model);
    },

    agent_end(event = {}, ctx = {}) {
      const runId = event.runId || ctx.runId;
      const agent = ctx.agentId || agentOfSessionKey(ctx.sessionKey);
      if (!runId || !agent) return;
      const tokens = runTokens.get(runId);
      const model = runModel.get(runId) || [ctx.modelProviderId, ctx.modelId].filter(Boolean).join("/") || undefined;
      runTokens.delete(runId);
      runModel.delete(runId);
      const end = now();
      const ms = Number(event.durationMs) || 0;
      write({
        edgeId: `run:${gw}.${slug(runId)}`,
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
      // A native sub-agent's runs roll up into its spawn edge.
      const sub = ctx.sessionKey && spawns.get(ctx.sessionKey);
      if (sub && tokens) sub.tokens = addUsage(sub.tokens, tokens);
    },

    subagent_spawned(event = {}, ctx = {}) {
      const child = event.childSessionKey || ctx.childSessionKey;
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
 * (register() is not awaited); agent-graph.mjs loads on the first edge.
 */
export function registerGraphHooks(api, opts = {}) {
  let graph;
  const record =
    opts.record ||
    ((edge) => (graph ||= import("./agent-graph.mjs")).then((m) => m.recordEdge(edge, { warn: false })));
  const hooks = createGraphHooks({ ...opts, record });
  for (const [name, fn] of Object.entries(hooks)) api.on(name, fn, { timeoutMs: 2000 });
  return hooks;
}
