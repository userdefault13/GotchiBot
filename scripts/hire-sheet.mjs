#!/usr/bin/env node
/**
 * Hire sheets — treat a gotchi like a new hire, not a prompt.
 *
 * Each role (config/agent-role-playbooks.json → `hire`, mirrored into the
 * marketplace pack.json) says what job it owns, what "done" means, who it
 * reports to, and how trust ramps: a newly assigned gotchi starts on
 * probation (read, report, draft — no writes outside its session, no money,
 * posts, deletes, or secrets) and a trial task; UserDefault promotes it to
 * trusted. Trust is per hero, stored with its assignment in
 * sessions/.pack-wearables.json.
 *
 *   node scripts/hire-sheet.mjs show <roleId|heroId>     # print the rendered sheet
 *   node scripts/hire-sheet.mjs trust <heroId>           # print probation | trusted
 *   node scripts/hire-sheet.mjs probation [--json]       # who is on probation + their finished work (CoS review)
 *   node scripts/hire-sheet.mjs seed [--write] [--force] # add default hire to playbooks (--force: regenerate all)
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLAYBOOKS = join(ROOT, "config", "agent-role-playbooks.json");
const ROLES = join(ROOT, "config", "agent-roles.json");
const WEARABLES = join(ROOT, "sessions", ".pack-wearables.json");

export const TRUST_LEVELS = ["probation", "trusted"];

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function firstSentence(text) {
  const s = String(text || "").trim();
  const m = s.match(/^[\s\S]*?[.!?](?=\s|$)/);
  return (m ? m[0] : s).trim();
}

/** A sensible hire sheet from what the playbook already says. */
export function defaultHire(roleId, playbook = {}) {
  // Summaries are one or two sentences; the first alone can be just "Design only."
  const job = String(playbook.summary || "").trim() || `Do the ${roleId} job.`;
  const owns = firstSentence(playbook.autonomy) || job;
  return {
    job,
    owns,
    definitionOfDone: [
      "The deliverable is written where my brief says (default sessions/<id>/output.md) — not just described in chat.",
      "It says what I checked and how (a command, a file, a source). No guessed numbers.",
      "Anything unfinished or blocked is listed with the next step and who owns it.",
    ],
    reportsTo: "orchestrator",
    cadence: playbook.scheduleCmd
      ? "After each scheduled run, and whenever I am blocked: one line to the orchestrator."
      : "When the job is done or blocked: one line to the orchestrator.",
    probation: {
      allowed: [
        "Read the repo and my workspace.",
        "Run status, list, and report commands.",
        "Draft changes as a proposal in my session output for review.",
      ],
      notYet: [
        "Edit or write files outside my session directory.",
        "Spend, sign, or move funds; create orders or transactions.",
        "Post publicly or message anyone outside the desk.",
        "Delete anything.",
        "Use abra secrets.",
      ],
      trialTask: "Dry run of my job: the first three concrete steps I would take, what I would need, and how I would show it is done. Change nothing.",
      promoteWhen:
        "UserDefault reviews my trial work and runs `./scripts/gotchibot pack-wearable trust <my id> trusted`.",
    },
    trusted: {
      allowed: [
        "My role skills and the work tools (Cursor → Codex → Claude).",
        "Edits that my job needs, inside the repo.",
      ],
      stillNever: "Everything on the Never list below still applies: money, public posts, and deletes need UserDefault's yes in this conversation.",
    },
  };
}

/** Playbook hire merged over the default, so a role can override any part. */
export function hireFor(roleId, playbook = {}) {
  const base = defaultHire(roleId, playbook);
  const own = playbook?.hire || {};
  return {
    ...base,
    ...own,
    probation: { ...base.probation, ...(own.probation || {}) },
    trusted: { ...base.trusted, ...(own.trusted || {}) },
  };
}

/**
 * Trust for a hero. Assignments made before hire sheets existed carry no trust
 * field — those gotchis were already working, so they count as trusted.
 */
export function heroTrust(heroId, { wearables = readJson(WEARABLES, {}) } = {}) {
  const eq = wearables?.equipped?.[String(heroId)];
  if (!eq) return "trusted";
  return TRUST_LEVELS.includes(eq.trust) ? eq.trust : "trusted";
}

/** Markdown section for a hero's AGENTS.md (the {{HIRE}} slot in AGENTS.common.md). */
export function renderHireSheet({ roleId, playbook, trust = "trusted", isOrchestrator = false, orchId = "" } = {}) {
  if (!roleId) return "";
  const h = hireFor(roleId, playbook || {});
  const boss = isOrchestrator ? "UserDefault" : h.reportsTo === "orchestrator" ? `the orchestrator${orchId ? ` (${orchId})` : ""}` : h.reportsTo;
  const level = isOrchestrator ? "trusted" : trust;
  const lines = [
    "## My job (hire sheet)",
    "",
    `- **Job:** ${h.job}`,
    `- **I own:** ${h.owns}`,
    `- **I report to:** ${boss}. ${h.cadence}`,
    "- **Done means:**",
    ...h.definitionOfDone.map((d) => `  - ${d}`),
    "",
  ];
  if (level === "probation") {
    lines.push(
      "**Trust: probation.** I was hired recently. Until I am promoted:",
      "",
      "- I may:",
      ...h.probation.allowed.map((d) => `  - ${d}`),
      "- Not yet:",
      ...h.probation.notYet.map((d) => `  - ${d}`),
      `- **Trial task:** ${h.probation.trialTask}`,
      `- **Promotion:** ${h.probation.promoteWhen}`,
      "",
      "If a request needs something on the not-yet list, I say so and draft it for review instead.",
    );
  } else {
    lines.push(
      "**Trust: trusted.**",
      "",
      "- I may:",
      ...h.trusted.allowed.map((d) => `  - ${d}`),
      `- ${h.trusted.stillNever}`,
    );
  }
  return lines.join("\n");
}

function readStateEnv(path) {
  const out = {};
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^([a-z_]+)=(.*)$/);
      if (m) out[m[1]] = m[2];
    }
  } catch {
    /* no state */
  }
  return out;
}

/**
 * Probation review evidence for the chief of staff: each gotchi on probation,
 * its role, how long it has been on probation, and the sessions it ran since
 * it was hired (status + output path). `signal` is a starting point, not a
 * verdict — the CoS reads the outputs and recommends; UserDefault promotes.
 */
export function probationReview({ root = ROOT, now = Date.now() } = {}) {
  const wearables = readJson(join(root, "sessions", ".pack-wearables.json"), {}) || {};
  const sessionsDir = join(root, "sessions");
  let sessionIds = [];
  try {
    sessionIds = readdirSync(sessionsDir).filter((d) => /^s\d/.test(d));
  } catch {
    sessionIds = [];
  }
  const sessions = sessionIds.map((id) => ({ id, ...readStateEnv(join(sessionsDir, id, "state.env")) }));
  const out = [];
  for (const [hero, eq] of Object.entries(wearables.equipped || {})) {
    if (eq?.trust !== "probation") continue;
    const hiredAt = eq.hiredAt || eq.equippedAt || null;
    const since = hiredAt ? Date.parse(hiredAt) : 0;
    const mine = sessions
      .filter((s) => s.hero === hero && (!since || Date.parse(s.started || "") >= since))
      .map((s) => {
        const output = join("sessions", s.id, "output.md");
        return {
          id: s.id,
          status: s.status || "unknown",
          started: s.started || null,
          ended: s.ended || null,
          output: existsSync(join(root, output)) ? output : null,
        };
      })
      .sort((a, b) => String(b.started).localeCompare(String(a.started)));
    const done = mine.filter((s) => s.status === "done" && s.output).length;
    const failed = mine.filter((s) => s.status === "failed" || s.status === "error").length;
    const days = since ? Math.floor((now - since) / 86400000) : null;
    let signal = "no finished work yet";
    if (failed > 0 && done === 0) signal = "only failed sessions — needs attention";
    else if (done >= 1 && failed === 0) signal = "finished work to review";
    else if (done >= 1) signal = "mixed — review the failures too";
    out.push({ hero, role: eq.packId, hiredAt, daysOnProbation: days, sessions: mine, done, failed, signal });
  }
  return out.sort((a, b) => (b.daysOnProbation ?? 0) - (a.daysOnProbation ?? 0));
}

function loadPlaybooks() {
  return readJson(PLAYBOOKS, {}) || {};
}

function main(argv) {
  const [cmd, arg] = argv;
  const write = argv.includes("--write");
  const force = argv.includes("--force");
  if (cmd === "show") {
    if (!arg) throw new Error("usage: hire-sheet.mjs show <roleId|heroId>");
    const playbooks = loadPlaybooks();
    const roles = readJson(ROLES, {}) || {};
    const roleId = playbooks[arg] ? arg : roles[arg];
    if (!roleId) throw new Error(`no role or hero "${arg}"`);
    const heroId = playbooks[arg] ? null : arg;
    console.log(
      renderHireSheet({
        roleId,
        playbook: playbooks[roleId],
        trust: heroId ? heroTrust(heroId) : "probation",
        isOrchestrator: roleId === "orchestrator",
      }),
    );
    return;
  }
  if (cmd === "trust") {
    if (!arg) throw new Error("usage: hire-sheet.mjs trust <heroId>");
    console.log(heroTrust(arg));
    return;
  }
  if (cmd === "probation") {
    const rows = probationReview();
    if (argv.includes("--json")) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    if (!rows.length) {
      console.log("no gotchis on probation");
      return;
    }
    for (const r of rows) {
      const age = r.daysOnProbation == null ? "?" : `${r.daysOnProbation}d`;
      console.log(`${r.hero}  ${r.role}  on probation ${age}  done ${r.done} · failed ${r.failed}  → ${r.signal}`);
      for (const s of r.sessions.slice(0, 5)) {
        console.log(`  ${s.id}  ${s.status}${s.output ? `  ${s.output}` : ""}`);
      }
    }
    return;
  }
  if (cmd === "seed") {
    const playbooks = loadPlaybooks();
    const added = [];
    for (const [roleId, pb] of Object.entries(playbooks)) {
      if (!pb || typeof pb !== "object" || (pb.hire && !force)) continue;
      pb.hire = defaultHire(roleId, pb);
      added.push(roleId);
    }
    if (write && added.length) writeFileSync(PLAYBOOKS, `${JSON.stringify(playbooks, null, 2)}\n`);
    console.log(`${write ? "seeded" : "would seed"} ${added.length} role(s)${added.length ? `: ${added.join(", ")}` : ""}`);
    return;
  }
  console.error("usage: hire-sheet.mjs show <roleId|heroId> | trust <heroId> | probation [--json] | seed [--write] [--force]");
  process.exit(2);
}

if (isMainModule(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
}
