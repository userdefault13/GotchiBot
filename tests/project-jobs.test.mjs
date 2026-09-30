/**
 * Job stage machine: who may move a stage, and the limbo / all-done signals
 * kanban's digest writes onto the job. No project room is touched.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LIMBO_MS,
  actorRole,
  applyJobSignals,
  assertJobMove,
  isTicketLimbo,
  jobSignals,
} from "../scripts/project-tickets.mjs";

const roles = {
  "owned-22899": "orchestrator",
  "owned-954": "architect",
  "owned-23336": "project-manager",
  "owned-14338": "kanban-manager",
  "owned-23965": "chief-of-staff",
};

describe("job moves", () => {
  it("lets each gate cross only its own edges", () => {
    assert.doesNotThrow(() => assertJobMove("intake", "design", "orchestrator"));
    assert.doesNotThrow(() => assertJobMove("design", "plan", "architect"));
    assert.doesNotThrow(() => assertJobMove("plan", "approval", "project-manager"));
    assert.doesNotThrow(() => assertJobMove("approval", "staff", "orchestrator"));
    assert.doesNotThrow(() => assertJobMove("approval", "plan", "orchestrator"));
    assert.doesNotThrow(() => assertJobMove("staff", "assigned", "project-manager"));
    assert.doesNotThrow(() => assertJobMove("doing", "review", "kanban-manager"));
    assert.doesNotThrow(() => assertJobMove("review", "rework", "chief-of-staff"));
    assert.doesNotThrow(() => assertJobMove("review", "verify", "kanban-manager"));
    assert.doesNotThrow(() => assertJobMove("verify", "approved", "chief-of-staff"));
    assert.doesNotThrow(() => assertJobMove("verify", "rework", "project-manager"));
    assert.doesNotThrow(() => assertJobMove("approved", "reported", "orchestrator"));
  });

  it("rejects a role that does not own the edge", () => {
    assert.throws(() => assertJobMove("intake", "design", "project-manager"), /cannot move/);
    assert.throws(() => assertJobMove("review", "rework", "kanban-manager"), /cannot move/);
    assert.throws(() => assertJobMove("doing", "reported", "orchestrator"), /not allowed/);
  });

  it("resolves a hero id or an alias to the role", () => {
    assert.equal(actorRole("owned-22899", roles), "orchestrator");
    assert.equal(actorRole("pm", roles), "project-manager");
    assert.equal(actorRole("cos", roles), "chief-of-staff");
    assert.equal(actorRole("architect", roles), "architect");
    assert.equal(actorRole("nobody", roles), null);
  });
});

describe("job signals", () => {
  const now = Date.parse("2026-09-30T17:00:00.000Z");

  function ticket(id, status, ageMs) {
    return { id, status, jobId: "j1", updatedAt: new Date(now - ageMs).toISOString() };
  }

  it("marks an open or claimed ticket limbo after 30 minutes", () => {
    assert.equal(isTicketLimbo(ticket("a", "open", LIMBO_MS), now), true);
    assert.equal(isTicketLimbo(ticket("b", "claimed", LIMBO_MS + 1), now), true);
    assert.equal(isTicketLimbo(ticket("c", "open", LIMBO_MS - 1), now), false);
    assert.equal(isTicketLimbo(ticket("d", "submitted", LIMBO_MS * 2), now), false);
  });

  it("derives limbo from the job's children only", () => {
    const job = { id: "j1", tickets: ["a"] };
    const sig = jobSignals(
      job,
      [ticket("a", "open", LIMBO_MS), { ...ticket("z", "open", LIMBO_MS * 2), jobId: "other" }],
      now,
    );
    assert.deepEqual(sig.limboTickets, ["a"]);
    assert.equal(sig.limbo, true);
  });

  it("consults PM once per limbo set, then once when every child is accepted", () => {
    const job = { id: "j1", tickets: ["a", "b"], limboNotifiedKey: "", allDoneNotifiedAt: null };
    const stale = [ticket("a", "open", LIMBO_MS), ticket("b", "claimed", LIMBO_MS)];
    const first = applyJobSignals(job, stale, { now, notify: true });
    assert.equal(first.consultPmLimbo, true);
    assert.equal(job.limbo, true);
    const again = applyJobSignals(job, stale, { now, notify: true });
    assert.equal(again.consultPmLimbo, false);

    const fresh = [ticket("a", "open", 1000), ticket("b", "claimed", 1000)];
    applyJobSignals(job, fresh, { now, notify: true });
    assert.equal(job.limbo, false);
    assert.equal(job.limboNotifiedKey, "");

    const done = [
      { id: "a", status: "accepted", jobId: "j1", updatedAt: new Date(now).toISOString() },
      { id: "b", status: "closed", jobId: "j1", updatedAt: new Date(now).toISOString() },
    ];
    const ping = applyJobSignals(job, done, { now, notify: true });
    assert.equal(ping.consultPmAllDone, true);
    assert.ok(job.allDoneNotifiedAt);
    const quiet = applyJobSignals(job, done, { now, notify: true });
    assert.equal(quiet.consultPmAllDone, false);

    const reopened = [
      { id: "a", status: "rework", jobId: "j1", updatedAt: new Date(now).toISOString() },
      { id: "b", status: "closed", jobId: "j1", updatedAt: new Date(now).toISOString() },
    ];
    applyJobSignals(job, reopened, { now, notify: true });
    assert.equal(job.allDoneNotifiedAt, null);
  });

  it("does not stamp a consult when notify is off", () => {
    const job = { id: "j1", tickets: ["a"], limboNotifiedKey: "", allDoneNotifiedAt: null };
    const hints = applyJobSignals(job, [ticket("a", "open", LIMBO_MS)], { now, notify: false });
    assert.equal(hints.consultPmLimbo, false);
    assert.equal(job.limbo, true);
    assert.equal(job.limboNotifiedKey, "");
  });
});
