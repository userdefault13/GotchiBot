/**
 * Agent graph: declared edges, the Hub edge log, the report, and the kanban → PM watch.
 *   node --test tests/agent-graph.test.mjs
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";

import {
  buildGraph,
  isDeclared,
  recordEdge,
  closeEdge,
  flushOutbox,
  readOutbox,
  mergeEdges,
  graphReport,
  fireReason,
  watchEdges,
  roleOf,
  DEFAULT_BUDGETS,
} from "../scripts/agent-graph.mjs";
import { validateEdges } from "../services/gotchibot-api/graph.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A scratch root with the real role config, so roles resolve like production. */
function scratch(t) {
  const root = mkdtempSync(path.join(tmpdir(), "gb-graph-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "config"), { recursive: true });
  mkdirSync(path.join(root, "sessions"), { recursive: true });
  for (const f of ["agent-roles.json", "agent-role-playbooks.json"]) {
    copyFileSync(path.join(repo, "config", f), path.join(root, "config", f));
  }
  writeFileSync(path.join(root, "sessions", ".onboarding.json"), JSON.stringify({ orchestratorHeroId: "owned-22899" }));
  return root;
}

const graph = {
  budgets: DEFAULT_BUDGETS,
  edges: [
    { from: "*", to: "orchestrator", kinds: ["consult", "passoff", "inbox"] },
    { from: "project-manager", to: "kanban-manager", kinds: ["ticket", "passoff"] },
  ],
  extra: [{ from: "architect", to: "accountant", kinds: ["consult"] }],
};

describe("declared graph", () => {
  it("builds report and job edges from hire sheets and job moves, keeping extra", async (t) => {
    const root = scratch(t);
    writeFileSync(path.join(root, "config", "agent-graph.json"), JSON.stringify({ extra: [{ from: "a", to: "b", kinds: ["consult"] }] }));
    const g = await buildGraph({ root });
    assert.ok(g.edges.some((e) => e.from === "accountant" && e.to === "orchestrator"), "reportsTo edge");
    assert.ok(g.edges.some((e) => e.from === "architect" && e.to === "project-manager" && e.kinds.includes("job")), "design→plan job edge");
    assert.deepEqual(g.extra, [{ from: "a", to: "b", kinds: ["consult"] }]);
    assert.equal(JSON.parse(readFileSync(path.join(root, "config", "agent-graph.json"), "utf8")).edges.length, g.edges.length);
  });

  it("matches wildcards, kinds, and extra edges", () => {
    assert.equal(isDeclared("accountant", "orchestrator", "consult", graph), true);
    assert.equal(isDeclared("accountant", "orchestrator", "job", graph), false);
    assert.equal(isDeclared("architect", "accountant", "consult", graph), true);
    assert.equal(isDeclared("worker", "chief-of-staff", "consult", graph), false);
    assert.equal(isDeclared(null, "orchestrator", "consult", graph), false);
  });

  it("resolves roles from hero ids, the orchestrator, and role names", (t) => {
    const root = scratch(t);
    assert.equal(roleOf("owned-22899", { root }), "orchestrator");
    assert.equal(roleOf("userdefault", { root }), "userdefault");
    assert.equal(roleOf("owned-8532", { root }), "accountant");
    assert.equal(roleOf("project-manager", { root }), "project-manager");
  });
});

describe("edge log", () => {
  it("queues to the outbox, flushes to the Hub, and keeps edges the Hub did not take", async (t) => {
    const root = scratch(t);
    writeFileSync(path.join(root, "config", "agent-graph.json"), JSON.stringify(graph));
    const posted = [];
    let up = false;
    const hubRequest = async (method, p, { body }) => {
      if (!up) throw new Error("fetch failed");
      posted.push(...body.edges);
      return { ok: true };
    };
    const warnings = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s) => (warnings.push(String(s)), true);
    try {
      await recordEdge({ edgeId: "consult:q1.0", kind: "consult", from: "owned-8532", to: "owned-22899", ref: "q1" }, { root, hubRequest });
      await recordEdge({ edgeId: "consult:q2.0", kind: "consult", from: "owned-8532", to: "owned-23965", ref: "q2" }, { root, hubRequest });
    } finally {
      process.stderr.write = origWrite;
    }
    assert.equal(readOutbox(root).length, 2, "Hub down: both queued");
    assert.match(warnings.join(""), /accountant → chief-of-staff \(consult\) is not a declared edge/);
    up = true;
    await closeEdge("consult:q1.0", "answered", { root, hubRequest });
    assert.equal(readOutbox(root).length, 0, "drained");
    const merged = mergeEdges(posted);
    const q1 = merged.find((e) => e.edgeId === "consult:q1.0");
    assert.equal(q1.fromRole, "accountant");
    assert.equal(q1.toRole, "orchestrator");
    assert.equal(q1.declared, true);
    assert.equal(q1.outcome, "answered");
    assert.equal(merged.find((e) => e.edgeId === "consult:q2.0").declared, false);
  });

  it("never throws into the caller", async (t) => {
    const root = scratch(t);
    const r = await recordEdge({ kind: "consult", from: "x", to: "y" }, { root, hubRequest: async () => { throw new Error("boom"); } });
    assert.ok(r && r.edgeId.startsWith("consult:"));
  });
});

describe("report", () => {
  const now = Date.parse("2026-10-05T12:00:00Z");
  const at = (min) => new Date(now - min * 60000).toISOString();
  const edges = [
    { edgeId: "a", kind: "consult", fromRole: "worker", toRole: "orchestrator", sentAt: at(60), answeredAt: at(58), outcome: "answered", declared: true },
    { edgeId: "b", kind: "consult", fromRole: "worker", toRole: "orchestrator", sentAt: at(30), answeredAt: at(20), outcome: "answered", declared: true },
    { edgeId: "c", kind: "consult", fromRole: "worker", toRole: "orchestrator", sentAt: at(25), declared: true },
    { edgeId: "t.0", kind: "ticket", ref: "T1", fromRole: "project-manager", toRole: "worker", sentAt: at(300), answeredAt: at(200), outcome: "rework" },
    { edgeId: "t.1", kind: "ticket", ref: "T1", fromRole: "chief-of-staff", toRole: "worker", sentAt: at(200), answeredAt: at(100), outcome: "rework" },
    { edgeId: "x", kind: "inbox", fromRole: "worker", toRole: "accountant", sentAt: at(5), answeredAt: at(5), outcome: "done", declared: false },
  ];

  it("computes flows, stalled, rework loops, and off-graph", () => {
    const r = graphReport(edges, { now, graph });
    const flow = r.flows.find((f) => f.pair === "worker → orchestrator");
    assert.equal(flow.count, 3);
    assert.equal(flow.open, 1);
    assert.equal(flow.medianMin, 10);
    assert.deepEqual(r.stalled.map((e) => e.edgeId), ["c"], "consult budget is 10m");
    assert.deepEqual(r.rework, [{ ref: "T1", reworks: 2 }]);
    assert.deepEqual(r.offGraph.map((e) => e.edgeId), ["x"]);
    assert.equal(r.open.length, 1);
  });

  it("fires on failed/dropped/rework outcomes and on open past budget", () => {
    assert.match(fireReason({ kind: "passoff", outcome: "dropped" }, { now, graph }), /dropped/);
    assert.equal(fireReason({ kind: "passoff", sentAt: at(60) }, { now, graph }), null);
    assert.match(fireReason({ kind: "passoff", sentAt: at(200) }, { now, graph }), /open 200m \(budget 120m\)/);
  });
});

describe("kanban → PM watch", () => {
  const now = Date.parse("2026-10-05T12:00:00Z");
  const stalled = { edgeId: "passoff:p1", kind: "passoff", fromRole: "architect", toRole: "worker", ref: "p1", title: "build it", sentAt: new Date(now - 300 * 60000).toISOString() };

  it("fires a stalled edge once: PM alert, Handoffs card, marked alerted", async (t) => {
    const root = scratch(t);
    const sent = [];
    const cards = [];
    const marks = [];
    const r = await watchEdges({
      root,
      now,
      edges: [stalled, { ...stalled, edgeId: "passoff:p2", alertedAt: "2026-10-05T11:00:00Z" }],
      send: (m) => sent.push(m),
      addHandoffCard: async (e) => (cards.push(e.edgeId), "card1"),
      mark: async (e, reason, at) => marks.push({ id: e.edgeId, reason, at }),
    });
    assert.equal(r.fired.length, 1, "already-alerted edge is skipped");
    assert.equal(sent[0].to, "project-manager");
    assert.equal(sent[0].kind, "alert");
    assert.match(sent[0].body, /re-route/);
    assert.deepEqual(cards, ["passoff:p1"]);
    assert.equal(marks[0].id, "passoff:p1");
    assert.equal(r.fired[0].alerted, "project-manager");
  });

  it("falls back to the orchestrator when no PM is seated", async (t) => {
    const root = scratch(t);
    const sent = [];
    await watchEdges({
      root,
      now,
      edges: [stalled],
      send: (m) => {
        if (m.to === "project-manager") throw new Error("no hero seated as project-manager");
        sent.push(m);
      },
      addHandoffCard: async () => null,
      mark: async () => {},
    });
    assert.equal(sent[0].to, "orch");
  });
});

describe("Hub edge validation", () => {
  it("allow-lists fields and rejects bad input", () => {
    const [e] = validateEdges({ edges: [{ edgeId: "consult:q1.0", kind: "consult", from: "a", to: "b", sentAt: "2026-10-05T00:00:00Z", junk: "x", declared: false }] });
    assert.equal(e.junk, undefined);
    assert.equal(e.declared, false);
    assert.throws(() => validateEdges({ edges: [{ edgeId: "bad id!" }] }), /edgeId/);
    assert.throws(() => validateEdges({ edges: [{ edgeId: "x", kind: "nope" }] }), /unknown kind/);
    assert.throws(() => validateEdges({}), /array required/);
  });
});

async function mongoReachable(uri, ms = 1500) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: ms, connectTimeoutMS: ms });
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    return true;
  } catch {
    return false;
  } finally {
    await client.close().catch(() => {});
  }
}

describe("Hub edge API", async () => {
  const uri = process.env.GOTCHIBOT_TEST_MONGODB_URI || "mongodb://127.0.0.1:27017";
  if (!(await mongoReachable(uri))) {
    it("skips when Mongo unreachable", { skip: "Mongo not reachable within 1.5s" }, () => {});
    return;
  }
  const { connectStore } = await import("../services/gotchibot-api/store.mjs");
  const { createApiServer } = await import("../services/gotchibot-api/server.mjs");
  const dbName = `gotchibot_test_${randomBytes(6).toString("hex")}`;
  let store;
  let server;
  let port;
  let token;
  const call = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { "X-GotchiBot-Desk-Token": token, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  };
  before(async () => {
    store = await connectStore({ mongoUri: uri, dbName });
    await store.ensureIndexes();
    server = createApiServer({ store, config: { host: "127.0.0.1", port: 0, ownerLogin: "owner@example.com" } });
    port = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
    const { code } = await store.mintPairingCode({ name: "desk", kind: "desk" });
    const claim = await fetch(`http://127.0.0.1:${port}/api/gotchibot/hub/pair/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, name: "desk" }),
    });
    token = (await claim.json()).deskToken;
  });
  after(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (store) {
      await store.db.dropDatabase().catch(() => {});
      await store.close();
    }
  });

  it("round-trips edges and updates one edge in place", async () => {
    assert.ok(token, "desk token");
    let r = await call("POST", "/api/gotchibot/graph/edges", { edges: [{ edgeId: "consult:q9.0", kind: "consult", from: "a", to: "b", sentAt: new Date().toISOString() }] });
    assert.equal(r.status, 200);
    r = await call("POST", "/api/gotchibot/graph/edges", { edges: [{ edgeId: "consult:q9.0", answeredAt: new Date().toISOString(), outcome: "answered" }] });
    assert.equal(r.status, 200);
    r = await call("GET", "/api/gotchibot/graph/edges");
    const e = r.data.edges.find((x) => x.edgeId === "consult:q9.0");
    assert.equal(e.kind, "consult");
    assert.equal(e.outcome, "answered");
    assert.equal(r.data.edges.filter((x) => x.edgeId === "consult:q9.0").length, 1);
  });
});
