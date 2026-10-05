/**
 * Hire sheets: job, done, reporting, and the probation → trusted ramp.
 *   node --test tests/hire-sheet.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { defaultHire, hireFor, heroTrust, renderHireSheet } from "../scripts/hire-sheet.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const playbooks = JSON.parse(read("config/agent-role-playbooks.json"));

describe("hire sheet content", () => {
  it("every role playbook carries a hire sheet, and each pack mirrors it", () => {
    for (const [role, pb] of Object.entries(playbooks)) {
      assert.ok(pb.hire, `${role} has hire`);
      assert.ok(pb.hire.job && pb.hire.definitionOfDone?.length, `${role} job + done`);
    }
    const packs = path.join(root, "templates/marketplace/packs");
    for (const id of readdirSync(packs)) {
      const p = path.join(packs, id, "pack.json");
      if (!existsSync(p)) continue;
      const pack = JSON.parse(readFileSync(p, "utf8"));
      assert.deepEqual(pack.hire, playbooks[pack.roleId || id]?.hire, `${id} pack mirrors playbook hire`);
    }
  });

  it("defaults the job to the role summary and lets a playbook override parts", () => {
    const pb = { summary: "Design only. Return a design note.", autonomy: "Owns design. More text." };
    assert.equal(defaultHire("architect", pb).job, "Design only. Return a design note.");
    assert.equal(defaultHire("architect", pb).owns, "Owns design.");
    const h = hireFor("architect", { ...pb, hire: { reportsTo: "chief-of-staff", probation: { trialTask: "custom" } } });
    assert.equal(h.reportsTo, "chief-of-staff");
    assert.equal(h.probation.trialTask, "custom");
    assert.ok(h.probation.notYet.length > 0, "unset probation fields keep defaults");
  });
});

describe("trust ramp", () => {
  const wearables = {
    equipped: {
      newbie: { packId: "accountant", trust: "probation" },
      veteran: { packId: "accountant", trust: "trusted" },
      legacy: { packId: "accountant" },
    },
  };

  it("reads trust per hero; pre-hire-sheet assignments count as trusted", () => {
    assert.equal(heroTrust("newbie", { wearables }), "probation");
    assert.equal(heroTrust("veteran", { wearables }), "trusted");
    assert.equal(heroTrust("legacy", { wearables }), "trusted");
    assert.equal(heroTrust("nobody", { wearables }), "trusted");
  });

  it("renders limits and a trial task on probation, the full kit when trusted", () => {
    const pb = playbooks.accountant;
    const probation = renderHireSheet({ roleId: "accountant", playbook: pb, trust: "probation" });
    assert.match(probation, /## My job \(hire sheet\)/);
    assert.match(probation, /Trust: probation/);
    assert.match(probation, /Not yet:/);
    assert.match(probation, /Trial task:/);
    assert.match(probation, /pack-wearable trust <my id> trusted/);
    const trusted = renderHireSheet({ roleId: "accountant", playbook: pb, trust: "trusted" });
    assert.match(trusted, /Trust: trusted/);
    assert.doesNotMatch(trusted, /Trial task:/);
    assert.ok(trusted.length < 700, `trusted sheet stays compact (${trusted.length})`);
    const orch = renderHireSheet({ roleId: "orchestrator", playbook: playbooks.orchestrator, trust: "probation", isOrchestrator: true });
    assert.equal(orch, "", "the orchestrator has no hire sheet (never on probation, reports to UserDefault)");
  });

  it("starts new assignments on probation and keeps earned trust on a re-equip", () => {
    const src = read("scripts/pack-wearable.mjs");
    assert.match(src, /prior\?\.packId === id && prior\?\.trust \? prior\.trust : "probation"/);
    assert.match(src, /export function setTrust/);
    assert.match(src, /cmd === "trust"/);
  });

  it("renders into every hero's AGENTS.md through AGENTS.common.md", () => {
    assert.match(read("config/openclaw/templates/AGENTS.common.md"), /^\{\{HIRE\}\}/);
    const fleet = read("scripts/openclaw-fleet.mjs");
    assert.match(fleet, /vars\.HIRE = renderHireSheet\(/);
    assert.ok(fleet.indexOf("vars.HIRE") < fleet.indexOf('vars.COMMON = renderTemplate("AGENTS.common.md"'));
    assert.match(read("scripts/template-pack.mjs"), /playbook\.hire \? \{ hire: playbook\.hire \}/);
  });
});

describe("chief of staff probation review", () => {
  it("lists probation gotchis with only the work done since they were hired", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { probationReview } = await import("../scripts/hire-sheet.mjs");
    const dir = mkdtempSync(path.join(tmpdir(), "gb-hire-"));
    try {
      mkdirSync(path.join(dir, "sessions"), { recursive: true });
      writeFileSync(
        path.join(dir, "sessions", ".pack-wearables.json"),
        JSON.stringify({
          equipped: {
            newbie: { packId: "accountant", trust: "probation", hiredAt: "2026-10-01T00:00:00Z" },
            vet: { packId: "architect", trust: "trusted" },
          },
        }),
      );
      const sess = (id, hero, status, started, withOutput) => {
        mkdirSync(path.join(dir, "sessions", id), { recursive: true });
        writeFileSync(path.join(dir, "sessions", id, "state.env"), `hero=${hero}\nstatus=${status}\nstarted=${started}\n`);
        if (withOutput) writeFileSync(path.join(dir, "sessions", id, "output.md"), "done\n");
      };
      sess("s20260930-000000-1", "newbie", "done", "2026-09-30T00:00:00Z", true); // before hire
      sess("s20261002-000000-2", "newbie", "done", "2026-10-02T00:00:00Z", true);
      sess("s20261002-000000-3", "vet", "done", "2026-10-02T00:00:00Z", true);
      const rows = probationReview({ root: dir, now: Date.parse("2026-10-04T00:00:00Z") });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].hero, "newbie");
      assert.equal(rows[0].daysOnProbation, 3);
      assert.deepEqual(rows[0].sessions.map((s) => s.id), ["s20261002-000000-2"]);
      assert.equal(rows[0].signal, "finished work to review");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tells the chief of staff to recommend, never to promote", () => {
    const cos = read("config/openclaw/templates/AGENTS.chief-of-staff.md");
    assert.match(cos, /gotchibot hire probation/);
    assert.match(cos, /\*\*promote\*\*, \*\*hold\*\*/);
    assert.match(cos, /I recommend; UserDefault decides/);
    assert.match(cos, /I never run `pack-wearable trust`/);
  });
});

describe("AGENTS.md size", () => {
  it("every rendered hero AGENTS.md fits OpenClaw's 20000-char read", async () => {
    const { AGENTS_MD_LIMIT } = await import("../scripts/hire-sheet.mjs");
    const ws = path.join(root, "config/openclaw/workspaces");
    for (const id of readdirSync(ws)) {
      const f = path.join(ws, id, "AGENTS.md");
      if (!existsSync(f)) continue;
      const n = readFileSync(f, "utf8").length;
      assert.ok(n <= AGENTS_MD_LIMIT, `${id} AGENTS.md is ${n} chars (limit ${AGENTS_MD_LIMIT})`);
    }
  });

  it("puts the hard rules first in the shared section and skips the orchestrator's sheet", () => {
    const common = read("config/openclaw/templates/AGENTS.common.md");
    assert.ok(common.indexOf("## Never") < common.indexOf("## Memory"));
    assert.ok(common.indexOf("## Messaging policy") < common.indexOf("## Memory"));
    assert.equal(renderHireSheet({ roleId: "orchestrator", playbook: playbooks.orchestrator, isOrchestrator: true }), "");
    const compact = renderHireSheet({ roleId: "accountant", playbook: playbooks.accountant, trust: "probation", compact: true });
    assert.match(compact, /Trust: probation/);
    assert.ok(compact.length < 900, `compact probation is ${compact.length} chars`);
  });
});
