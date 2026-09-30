/**
 * Agent-tree snapshot — the Factory pane's Tree view, synced across desks.
 *
 * Each desk pushes its own tree (orchestrator, work-tool runs, on-call advisor,
 * Jev forks, working bots) to POST /api/gotchibot/tree/push; the Hub keeps one
 * doc per desk. Every desk and phone reads all of them from GET
 * /api/gotchibot/tree and merges, so the tree looks the same on every device.
 */
import { join } from "node:path";

export const TREE_MAX_BYTES = 192 * 1024;
const MAX_RUNS = 500;
const MAX_JEV_IDS = 30;
const MAX_BOTS = 60;
const RUN_KINDS = new Set(["cursor", "codex", "dispatch"]);
const BOT_STATES = new Set(["rework", "working", "review", "queued", "idle"]);
/** Keep two weeks of run history plus anything still marked running. */
const RUN_WINDOW_MS = 14 * 86400_000;

function treeError(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function str(v, max = 80) {
  if (v == null) return null;
  const s = String(v).replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function iso(v) {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function list(v, max) {
  return Array.isArray(v) ? v.slice(0, max) : [];
}

function run(r) {
  const kind = RUN_KINDS.has(r?.kind) ? r.kind : null;
  return { kind, status: str(r?.status, 16) || "?", started: num(r?.started) || 0 };
}

function bot(b) {
  return {
    id: str(b?.id, 64),
    name: str(b?.name, 64),
    role: str(b?.role, 64),
    state: BOT_STATES.has(b?.state) ? b.state : "idle",
    op: str(b?.op, 64),
    opStale: b?.opStale === true,
    focus: str(b?.focus, 120),
  };
}

/**
 * Keep only the allow-listed tree fields; unknown keys are dropped.
 */
export function validateTreeSnapshot(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw treeError("tree object required");
  const o = body;
  const orch = o.orch && typeof o.orch === "object" ? o.orch : {};
  const adv = o.advisor && typeof o.advisor === "object" ? o.advisor : {};
  const jev = o.jev && typeof o.jev === "object" ? o.jev : {};
  const out = {
    collectedAt: iso(o.collectedAt),
    project: str(o.project, 64),
    orch: { id: str(orch.id, 64), name: str(orch.name, 64), model: str(orch.model, 80) },
    subModel: str(o.subModel, 80),
    claudeCalls: num(o.claudeCalls) ?? 0,
    runs: list(o.runs, MAX_RUNS).map(run).filter((r) => r.kind),
    advisor: {
      model: str(adv.model, 80),
      calls: num(adv.calls) ?? 0,
      day: num(adv.day) ?? 0,
      lastAt: iso(adv.lastAt),
      lastOk: adv.lastOk === true ? true : adv.lastOk === false ? false : null,
      lastText: str(adv.lastText, 200),
      reportsTo: str(adv.reportsTo, 64),
    },
    jev: {
      byId: list(jev.byId, MAX_JEV_IDS)
        .map((x) => ({ id: str(x?.id, 64), n: num(x?.n) ?? 0, sum: num(x?.sum) ?? 0, known: num(x?.known) ?? 0 }))
        .filter((x) => x.id),
    },
    bots: list(o.bots, MAX_BOTS).map(bot).filter((b) => b.id),
  };
  if (Buffer.byteLength(JSON.stringify(out), "utf8") > TREE_MAX_BYTES) throw treeError("tree snapshot too large");
  return out;
}

/** Desk side: the Factory pane's tree + factory models → a pushable snapshot. */
export function treeSnapshotFrom(tree, factory) {
  const now = Date.now();
  const runs = (tree?.runs || [])
    .filter((r) => r.status === "running" || now - r.started < RUN_WINDOW_MS)
    .sort((a, b) => b.started - a.started);
  return validateTreeSnapshot({
    collectedAt: new Date().toISOString(),
    project: factory?.slug || null,
    orch: tree?.orch,
    subModel: tree?.subModel,
    claudeCalls: tree?.claudeCalls,
    runs,
    advisor: tree?.advisor,
    jev: { byId: tree?.jev?.byId || [] },
    bots: (factory?.slug ? factory.bots : [])
      .filter((b) => b.state !== "idle")
      .map((b) => ({ id: b.id, name: b.name, role: b.role, state: b.state, op: b.op?.id, opStale: b.opStale, focus: b.focus?.title })),
  });
}

/** Desk side without the pane: build the same snapshot from disk. */
export async function collectTreeSnapshot({ root }) {
  const fw = await import(join(root, "scripts", "factory-window.mjs"));
  return treeSnapshotFrom(fw.buildTree(), fw.buildFactory());
}

/**
 * Merge the local tree/factory with other desks' snapshots.
 * @param {object} tree local buildTree() result
 * @param {object} factory local buildFactory() result
 * @param {Array<{deskId,deskName,pushedAt,tree}>} remotes other desks (self already excluded)
 * @returns {{ tree: object, bots: object[], desks: object[] }}
 */
export function mergeTrees(tree, factory, remotes, { sharp = 0.75 } = {}) {
  const runs = (tree.runs || []).map((r) => ({ ...r, desk: null }));
  let claudeCalls = tree.claudeCalls || 0;
  const adv = { ...tree.advisor };
  const jevById = new Map((tree.jev?.byId || []).map((x) => [x.id, { ...x }]));
  const localIds = new Set((factory?.slug ? factory.bots : []).filter((b) => b.state !== "idle").map((b) => b.id));
  const extraBots = [];
  const desks = [];

  for (const r of remotes || []) {
    const t = r.tree || {};
    const name = r.deskName || r.deskId;
    const tr = t.runs || [];
    desks.push({ name, pushedAt: r.pushedAt, runs: tr.length, bots: (t.bots || []).length });
    for (const x of tr) runs.push({ ...x, desk: name });
    claudeCalls += t.claudeCalls || 0;
    const a = t.advisor || {};
    adv.calls = (adv.calls || 0) + (a.calls || 0);
    adv.day = (adv.day || 0) + (a.day || 0);
    if (a.lastAt && (!adv.lastAt || Date.parse(a.lastAt) > Date.parse(adv.lastAt))) {
      Object.assign(adv, { lastAt: a.lastAt, lastOk: a.lastOk, lastText: a.lastText, reportsTo: a.reportsTo });
    }
    for (const x of t.jev?.byId || []) {
      const cur = jevById.get(x.id) || { id: x.id, n: 0, sum: 0, known: 0 };
      cur.n += x.n;
      cur.sum += x.sum;
      cur.known += x.known;
      jevById.set(x.id, cur);
    }
    for (const b of t.bots || []) {
      if (localIds.has(b.id) || extraBots.some((e) => e.id === b.id)) continue;
      extraBots.push({
        id: b.id,
        name: b.name,
        role: b.role,
        state: b.state,
        op: b.op ? { id: b.op } : null,
        opStale: b.opStale,
        focus: b.focus ? { title: b.focus } : null,
        desk: name,
      });
    }
  }

  const byId = [...jevById.values()];
  let forks = 0;
  let sharpN = 0;
  for (const x of byId) forks += x.n;
  // Per-fork confidences are not synced; count a question's forks as sharp when its average is.
  for (const x of byId) if (x.known && x.sum / x.known >= sharp) sharpN += x.n;
  const localSharp = tree.jev?.sharp ?? 0;
  const merged = {
    ...tree,
    runs,
    claudeCalls,
    advisor: adv,
    jev: {
      forks,
      sharp: remotes?.length ? sharpN : localSharp,
      split: forks - (remotes?.length ? sharpN : localSharp),
      top: byId.sort((a, b) => b.n - a.n).slice(0, 3).map((x) => ({ id: x.id, n: x.n, avg: x.known ? x.sum / x.known : null })),
      byId,
    },
  };
  return { tree: merged, bots: [...(factory?.slug ? factory.bots : []), ...extraBots], desks };
}
