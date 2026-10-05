import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWondrStackRows, render } from "../scripts/pstack-window.mjs";
import {
  connectWondrStack,
  disconnectWondrStack,
  loadWondrStack,
  syncWondrStackGoals,
} from "../scripts/pstack-wondrstack.mjs";

describe("project WondrStack dossier", () => {
  const status = (slug) => ({ workspace: { slug, business_name: "Acme", app_url: "https://acme.example", code_repository: "https://github.com/acme/app" } });
  it("shows a tab only for a linked project and rejects another workspace's goals", () => {
    const root = mkdtempSync(join(tmpdir(), "gb-wondrstack-"));
    try {
      assert.equal(loadWondrStack("client-a", { root }), null);
      assert.throws(() => connectWondrStack({ root, project: "client-a", status: status("other"), expectedWorkspace: "acme" }), /does not match/);
      connectWondrStack({ root, project: "client-a", status: status("acme"), expectedWorkspace: "acme" });
      assert.equal(loadWondrStack("client-b", { root }), null);
      assert.throws(() => syncWondrStackGoals({ root, project: "client-a", input: { workspace: "other", goals: [] } }), /does not match/);

      const synced = syncWondrStackGoals({
        root,
        project: "client-a",
        input: { workspace: "acme", goals: [{
          _id: "g1", title: "Reach $50,000 monthly", metric: "gross_revenue", currency: "USD",
          targetCents: 5_000_000, periodStart: "2026-10-01", periodEnd: "2026-10-31", status: "active",
          plan: { route: "existing_feature" },
          latestActual: { amountCents: 1_200_000, source: "owner_reported", periodEnd: "2026-10-07" },
        }] },
      });
      assert.equal(synced.goals.length, 1);
      const rows = buildWondrStackRows(synced).join("\n");
      assert.match(rows, /WONDRSTACK/);
      assert.match(rows, /USD 50,000\.00/);
      assert.match(rows, /owner_reported/);
      assert.equal(loadWondrStack("client-b", { root }), null);

      let screen = "";
      const write = process.stdout.write;
      process.stdout.write = (chunk) => { screen += String(chunk); return true; };
      try {
        render({
          slug: "client-a", dossier: { fields: { title: "Acme" }, status: "ready" }, empty: false,
          units: [], desks: [], ledger: [], decisions: [], roster: [], gridHeroes: [],
          gridLabel: "project", cronAgents: [], inboxMessages: [], milestones: [],
          wondrstack: synced, detailTab: "wondrstack", sel: 0, page: 0, detailScroll: 0,
          term: { cols: 120, rows: 42 },
        });
      } finally {
        process.stdout.write = write;
      }
      assert.match(screen, /\[w WondrStack\]/);
      assert.match(screen, /MONETARY GOALS/);

      connectWondrStack({ root, project: "client-a", status: status("different"), expectedWorkspace: "different" });
      assert.equal(loadWondrStack("client-a", { root }).goals, undefined);
      disconnectWondrStack({ root, project: "client-a" });
      assert.equal(loadWondrStack("client-a", { root }), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts MCP text content and strips terminal control characters", () => {
    const root = mkdtempSync(join(tmpdir(), "gb-wondrstack-"));
    try {
      connectWondrStack({ root, project: "client-a", status: { content: [{ type: "text", text: JSON.stringify(status("acme")) }] }, expectedWorkspace: "acme" });
      const result = syncWondrStackGoals({ root, project: "client-a", input: {
        content: [{ type: "text", text: JSON.stringify({ workspace: "acme", goals: [{
          title: "\u001b[31mGoal", currency: "USD", targetCents: 100,
        }] }) }],
      } });
      assert.doesNotMatch(result.goals[0].title, /\u001b/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
