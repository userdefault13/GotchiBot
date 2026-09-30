/**
 * Agent-tree sync: the snapshot allow-list and the cross-desk merge the Factory
 * Tree view renders.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeTrees, validateTreeSnapshot } from "../services/gotchibot-api/tree.mjs";

const NOW = Date.now();

function localTree() {
  return {
    orch: { id: "owned-22899", name: "User0xDefault", model: "opencode-go/glm-5.3" },
    runs: [
      { kind: "cursor", status: "done", started: NOW - 3600_000 },
      { kind: "dispatch", status: "running", started: NOW - 60_000 },
    ],
    subModel: "opencode-go/glm-5.3",
    claudeCalls: 4,
    advisor: { model: "opencode-go/glm-5.3", calls: 1, day: 1, lastAt: new Date(NOW - 3600_000).toISOString(), lastOk: true, lastText: "old", reportsTo: "orchestrator" },
    jev: { forks: 2, sharp: 2, split: 0, top: [], byId: [{ id: "route", n: 2, sum: 1.8, known: 2 }] },
  };
}

function localFactory() {
  return {
    slug: "alpha",
    bots: [
      { id: "owned-954", name: "UNI", role: "architect", state: "working", op: null, focus: null },
      { id: "owned-3033", name: "AAVE", role: "art-director", state: "idle", op: null, focus: null },
    ],
  };
}

describe("tree snapshot", () => {
  it("validation keeps only allow-listed fields and caps lists", () => {
    const out = validateTreeSnapshot({
      secret: "nope",
      orch: { id: "owned-1", model: "m", token: "x" },
      runs: [{ kind: "cursor", status: "running", started: 5, prompt: "p" }, { kind: "shell", status: "done", started: 1 }],
      advisor: { calls: 3, lastText: "t".repeat(400), lastOk: "yes" },
      jev: { byId: [{ id: "q", n: 1, sum: 0.9, known: 1, raw: [1] }, { n: 2 }] },
      bots: [{ id: "owned-1", state: "dancing", focus: "f".repeat(300) }, { name: "no id" }],
    });
    assert.equal(out.secret, undefined);
    assert.equal(out.orch.token, undefined);
    assert.deepEqual(out.runs, [{ kind: "cursor", status: "running", started: 5 }]);
    assert.equal(out.advisor.lastText.length, 200);
    assert.equal(out.advisor.lastOk, null);
    assert.deepEqual(out.jev.byId, [{ id: "q", n: 1, sum: 0.9, known: 1 }]);
    assert.equal(out.bots.length, 1);
    assert.equal(out.bots[0].state, "idle");
    assert.equal(out.bots[0].focus.length, 120);
    assert.throws(() => validateTreeSnapshot(null), /tree object required/);
    assert.throws(() => validateTreeSnapshot([]), /tree object required/);
  });

  it("merges other desks' runs, advisor, jev and bots into the local tree", () => {
    const hub = {
      deskId: "d-hub",
      deskName: "Hub terminal",
      pushedAt: new Date(NOW).toISOString(),
      tree: validateTreeSnapshot({
        runs: [{ kind: "cursor", status: "running", started: NOW - 30_000 }],
        claudeCalls: 2,
        advisor: { calls: 2, day: 2, lastAt: new Date(NOW).toISOString(), lastOk: true, lastText: "new", reportsTo: "owned-954" },
        jev: { byId: [{ id: "route", n: 2, sum: 0.6, known: 2 }, { id: "gate", n: 1, sum: 0.9, known: 1 }] },
        bots: [
          { id: "owned-954", name: "UNI", role: "architect", state: "working" },
          { id: "owned-5402", name: "AAVE", role: "customer-support", state: "review", op: "u-1" },
        ],
      }),
    };
    const { tree, bots, desks } = mergeTrees(localTree(), localFactory(), [hub]);
    assert.equal(tree.runs.filter((r) => r.kind === "cursor").length, 2);
    assert.equal(tree.runs.find((r) => r.desk === "Hub terminal").status, "running");
    assert.equal(tree.claudeCalls, 6);
    assert.equal(tree.advisor.calls, 3);
    assert.equal(tree.advisor.lastText, "new");
    assert.equal(tree.advisor.reportsTo, "owned-954");
    assert.equal(tree.jev.forks, 5);
    // route averages 0.6 across desks → split; gate 0.9 → sharp.
    assert.equal(tree.jev.sharp, 1);
    assert.equal(tree.jev.split, 4);
    assert.equal(bots.filter((b) => b.id === "owned-954").length, 1, "a bot working on both desks shows once");
    const remote = bots.find((b) => b.id === "owned-5402");
    assert.equal(remote.desk, "Hub terminal");
    assert.deepEqual(remote.op, { id: "u-1" });
    assert.deepEqual(desks, [{ name: "Hub terminal", pushedAt: hub.pushedAt, runs: 1, bots: 2 }]);
  });

  it("without remotes the local tree passes through unchanged", () => {
    const t = localTree();
    const { tree, bots, desks } = mergeTrees(t, localFactory(), []);
    assert.equal(tree.runs.length, 2);
    assert.equal(tree.claudeCalls, 4);
    assert.equal(tree.jev.sharp, 2);
    assert.equal(bots.length, 2);
    assert.deepEqual(desks, []);
  });
});
