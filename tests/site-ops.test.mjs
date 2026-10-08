/**
 * Site Ops: the WondrStack watch (alerts, auto-redeploy) and the role pieces.
 *   node --test tests/site-ops.test.mjs
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { siteConditions, watchProject, scheduleSiteOps } from "../scripts/wondrstack.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(path.join(tmpdir(), "site-ops-"));
after(() => rmSync(root, { recursive: true, force: true }));

const ws = (over = {}) => ({ workspace: { slug: "gotchibot", app_url: "https://gotchibot.vercel.app", provisioning: "repo_created", hosting: { status: "live" }, ...over } });
const up = async (url) => ({ url, ok: true, status: 200, ms: 5 });
const down = async (url) => ({ url, ok: false, status: 503 });

describe("site ops watch", () => {
  it("names each problem from get_status and the site check", () => {
    assert.deepEqual(siteConditions(ws(), { ok: true }), {});
    assert.match(siteConditions(ws({ hosting: { status: "failed", error: "build exited 1" } }), null).deploy_failed, /build exited 1/);
    assert.ok(siteConditions(ws({ provisioning: "failed", hosting: null }), null).repo_failed);
    assert.ok(siteConditions(ws({ hosting: null }), null).no_hosting);
    assert.match(siteConditions(ws(), { url: "https://x", ok: false, status: 503 }).site_down, /503/);
    assert.deepEqual(siteConditions({ workspace: null }, null), {}, "no workspace yet is not an alert");
  });

  it("alerts the PM once per problem, and once when it clears", async () => {
    const sent = [];
    const opts = { root, send: async (m) => sent.push(m), from: "owned-1" };
    await watchProject("p1", { ...opts, call: async () => ws(), siteCheck: down });
    await watchProject("p1", { ...opts, call: async () => ws(), siteCheck: down });
    assert.equal(sent.length, 1, "a lasting problem alerts once");
    assert.match(sent[0].subject, /Site Ops · p1: .*not answering/);
    assert.equal(sent[0].project, "p1");
    await watchProject("p1", { ...opts, call: async () => ws(), siteCheck: up });
    assert.equal(sent.length, 2);
    assert.match(sent[1].subject, /back to normal/);
  });

  it("no hosting only alerts after a day", async () => {
    const sent = [];
    const opts = { root, send: async (m) => sent.push(m), call: async () => ws({ hosting: null, app_url: null }), siteCheck: async () => null };
    const t0 = Date.parse("2026-10-08T00:00:00Z");
    await watchProject("p2", { ...opts, now: t0 });
    await watchProject("p2", { ...opts, now: t0 + 3600_000 });
    assert.equal(sent.length, 0);
    await watchProject("p2", { ...opts, now: t0 + 25 * 3600_000 });
    assert.equal(sent.length, 1);
    assert.match(sent[0].body, /no host is connected/);
  });

  it("a trusted Site Ops redeploys a failed deploy once; on probation it never does", async () => {
    const failed = ws({ hosting: { status: "failed", error: "build exited 1" } });
    const calls = [];
    const call = async (tool) => (calls.push(tool), tool === "get_status" ? failed : { deploying: true });
    const base = { root, send: async () => {}, call, siteCheck: async () => null };
    await watchProject("p3", { ...base, trusted: false });
    assert.equal(calls.includes("deploy_app"), false, "probation: propose only");
    const r1 = await watchProject("p4", { ...base, trusted: true });
    const r2 = await watchProject("p4", { ...base, trusted: true });
    assert.equal(calls.filter((c) => c === "deploy_app").length, 1, "one automatic retry per failure");
    assert.deepEqual(r1.notes, ["redeployed once automatically"]);
    assert.deepEqual(r2.notes, []);
  });

  it("the schedule is a Hub (Linux) timer", () => {
    if (process.platform === "linux") return;
    assert.match(scheduleSiteOps("status").message, /runs on the Hub/);
  });
});

describe("site ops role", () => {
  it("has a playbook, hire sheet, template, skill, pack and a deferred wake", () => {
    const pb = JSON.parse(readFileSync(path.join(repo, "config/agent-role-playbooks.json"), "utf8"))["site-ops"];
    assert.equal(pb.title, "Site Ops");
    assert.deepEqual(pb.skills, ["wondrstack"]);
    assert.equal(pb.cycleCmd, "./scripts/gotchibot wondrstack watch --all");
    assert.equal(pb.hire.reportsTo, "orchestrator");
    assert.match(pb.autonomy, /redeploy a failed deploy once by itself/);
    assert.match(pb.autonomy, /Never: archive/);
    const tpl = readFileSync(path.join(repo, "config/openclaw/templates/AGENTS.site-ops.md"), "utf8");
    assert.match(tpl, /\{\{REPORT_CMD\}\}/);
    assert.match(tpl, /never curl or browse the site myself/i);
    assert.ok(existsSync(path.join(repo, ".opencode/skills/wondrstack/SKILL.md")));
    assert.ok(existsSync(path.join(repo, "templates/marketplace/packs/site-ops/pack.json")));
    const wake = JSON.parse(readFileSync(path.join(repo, "config/desk-wakes.json"), "utf8")).roles["site-ops"];
    assert.equal(wake.mode, "defer");
    assert.match(wake.scheduleCmd, /wondrstack schedule status/);
  });
});
