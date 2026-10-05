/**
 * Agent graph edges — every handoff between gotchis (passoff, consult, job
 * stage, ticket, inbox ask, sub session), stored on the Hub so every desk and
 * phone sees one graph.
 *
 * A desk POSTs batches to /api/gotchibot/graph/edges. One edge per handoff,
 * keyed by edgeId: opening it sets sentAt; answering it later sets answeredAt
 * and outcome; the kanban watch sets alertedAt. Only the fields sent are
 * written, so each step is an idempotent upsert.
 */
export const EDGE_KINDS = new Set(["passoff", "consult", "job", "ticket", "inbox", "spawn"]);
export const EDGE_OUTCOMES = new Set(["answered", "accepted", "failed", "dropped", "rework", "done"]);
export const EDGES_MAX_PER_PUSH = 200;

function edgeError(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function str(v, max = 80) {
  if (v == null) return null;
  const s = String(v).replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

function iso(v) {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** One edge, allow-listed. Unknown fields are dropped; null fields are omitted. */
export function validateEdge(e) {
  const edgeId = str(e?.edgeId, 100);
  if (!edgeId || !/^[A-Za-z0-9_.:-]+$/.test(edgeId)) throw edgeError("edge: edgeId required ([A-Za-z0-9_.:-])");
  const kind = e?.kind == null ? null : str(e.kind, 16);
  if (kind && !EDGE_KINDS.has(kind)) throw edgeError(`edge ${edgeId}: unknown kind "${kind}"`);
  const outcome = e?.outcome == null ? null : str(e.outcome, 16);
  if (outcome && !EDGE_OUTCOMES.has(outcome)) throw edgeError(`edge ${edgeId}: unknown outcome "${outcome}"`);
  const out = {
    edgeId,
    kind,
    from: str(e?.from, 64),
    fromRole: str(e?.fromRole, 64),
    to: str(e?.to, 64),
    toRole: str(e?.toRole, 64),
    ref: str(e?.ref, 120),
    title: str(e?.title, 160),
    project: str(e?.project, 64),
    sentAt: iso(e?.sentAt),
    answeredAt: iso(e?.answeredAt),
    outcome,
    alertedAt: iso(e?.alertedAt),
    alertReason: str(e?.alertReason, 160),
  };
  if (typeof e?.declared === "boolean") out.declared = e.declared;
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return out;
}

/** Body of POST /graph/edges → validated edges. */
export function validateEdges(body) {
  const edges = Array.isArray(body?.edges) ? body.edges : null;
  if (!edges) throw edgeError("edges: array required");
  if (edges.length > EDGES_MAX_PER_PUSH) throw edgeError(`edges: at most ${EDGES_MAX_PER_PUSH} per push`);
  return edges.map(validateEdge);
}
