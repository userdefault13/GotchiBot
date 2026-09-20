#!/usr/bin/env node
/**
 * Colabo — in an open meeting, one user prompt → every agent responds.
 *
 *   node scripts/colabo.mjs "How should we ship X?"
 *   node scripts/colabo.mjs --prompt "…" [--ring design] [--timeout SEC] [--json]
 *
 * Prefer: ./scripts/gotchibot meet colabo "…"
 * Models: config/model-policy.json scope=colabo (working models only).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const RINGS_PATH = join(ROOT, "config", "colabo-rings.json");
const ROLES_PATH = join(ROOT, "config", "agent-roles.json");

function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function loadRings() {
  return loadJson(RINGS_PATH, { rings: {} });
}

function heroesForRoles(roleSpecs) {
  const roles = loadJson(ROLES_PATH, {});
  const byRole = new Map();
  for (const [hero, roleId] of Object.entries(roles)) {
    if (!byRole.has(roleId)) byRole.set(roleId, []);
    byRole.get(roleId).push(hero);
  }
  const required = [];
  const optional = [];
  const missingRequired = [];
  for (const spec of roleSpecs || []) {
    const roleId = typeof spec === "string" ? spec : spec.roleId;
    const req = typeof spec === "string" ? true : spec.required !== false;
    const heroes = byRole.get(roleId) || [];
    if (!heroes.length) {
      if (req) missingRequired.push(roleId);
      continue;
    }
    const pick = heroes[0];
    if (req) required.push({ roleId, hero: pick });
    else optional.push({ roleId, hero: pick });
  }
  return { required, optional, missingRequired };
}

async function inviteRing(m, ringId) {
  const cfg = loadRings();
  const ring = cfg.rings?.[ringId];
  if (!ring) {
    const known = Object.keys(cfg.rings || {}).join(", ") || "(none)";
    throw new Error("unknown colabo ring \"" + ringId + "\" — known: " + known);
  }
  const { required, optional, missingRequired } = heroesForRoles(ring.roles || []);
  if (missingRequired.length) {
    throw new Error(
      "ring \"" + ringId + "\" missing required role(s): " + missingRequired.join(", ") +
      ". Seat with: gotchibot templates apply <role> --hero <available> --yes",
    );
  }
  const targets = [...required, ...optional];
  const invited = [];
  const skipped = [];
  const errors = [];
  const prevQuiet = process.env.GOTCHIBOT_MEET_INVITE_QUIET;
  process.env.GOTCHIBOT_MEET_INVITE_QUIET = "1";
  try {
    for (const t of targets) {
      try {
        await m.inviteParticipant(t.hero);
        invited.push(t);
      } catch (e) {
        const msg = String(e?.message || e);
        if (/already/i.test(msg)) skipped.push(t);
        else errors.push({ ...t, error: msg });
      }
    }
  } finally {
    if (prevQuiet === undefined) delete process.env.GOTCHIBOT_MEET_INVITE_QUIET;
    else process.env.GOTCHIBOT_MEET_INVITE_QUIET = prevQuiet;
  }
  if (errors.length && !invited.length && !skipped.length) {
    throw new Error(
      "ring \"" + ringId + "\" invite failed: " +
        errors.map((e) => e.hero + ": " + e.error).join("; "),
    );
  }
  return { ringId, ring, invited, skipped, errors };
}

async function meetMod() {
  return import("./gotchi-meet.mjs");
}

function agentIds(meeting) {
  return (meeting.participants || [])
    .filter((p) => p.role === "agent")
    .map((p) => p.id);
}

async function runAgent(agentId, message, timeoutS) {
  const { completeWithPolicy, openclawAllowed } = await import("./model-policy.mjs");
  const { isModelLimitError } = await import("./model-fallback.mjs");
  const { spawnSync } = await import("node:child_process");

  const prompt = [
    `You are ${agentId} in a GotchiBot Colabo round.`,
    "Answer concisely (≤120 words). Plain text only.",
    "",
    "User prompt:",
    message,
  ].join("\n");

  const hasKeys = !!(
    process.env.NVIDIA_API_KEY ||
    process.env.OPENROUTER_API_KEY ||
    process.env.DEEPSEEK_API_KEY ||
    process.env.OPENCODE_API_KEY ||
    process.env.OPENCODE_ZEN_API_KEY
  );

  const policyHit = await completeWithPolicy(
    "colabo",
    async (model, opts) => {
      const args = ["run", "-m", model, "--dir", ROOT, "--auto", prompt];
      const r = hasKeys
        ? spawnSync("opencode", args, {
            cwd: ROOT,
            encoding: "utf8",
            timeout: opts?.timeoutMs || timeoutS * 1000,
            maxBuffer: 4 << 20,
          })
        : spawnSync("abra", ["run", "gotchibot", "--", "opencode", ...args], {
            cwd: ROOT,
            encoding: "utf8",
            timeout: opts?.timeoutMs || timeoutS * 1000,
            maxBuffer: 4 << 20,
          });
      const blob = `${r.stdout || ""}\n${r.stderr || ""}`;
      if (r.status === 0 && String(r.stdout || "").trim()) {
        return { ok: true, text: String(r.stdout || "").trim() };
      }
      if (isModelLimitError(blob) || /402|429|payment required/i.test(blob)) {
        return { ok: false, reason: "model-limit", stdout: blob.slice(0, 400) };
      }
      return { ok: false, reason: "opencode-failed", stdout: blob.slice(0, 400) };
    },
    { timeoutMs: timeoutS * 1000 },
  );

  if (policyHit.ok) {
    return { ok: true, text: policyHit.text, via: policyHit.via };
  }

  if (openclawAllowed("colabo") === "never") {
    return {
      ok: false,
      text: `(colabo failed: ${policyHit.reason || "policy-exhausted"})`,
      via: "none",
    };
  }

  const { chatViaOpenClaw } = await import("./openclaw-fleet.mjs");
  const r = await chatViaOpenClaw(agentId, message, {
    sessionKey: `meet-colabo:${agentId}`,
  });
  if (r.ok) return { ok: true, text: String(r.stdout || "").trim(), via: r.via };
  return { ok: false, text: `(colabo failed: ${r.reason || "models-exhausted"})`, via: "none" };
}

export async function colabo(prompt, { timeoutS = 90, resumeFrom = null, ring = null } = {}) {
  const text = String(
    (resumeFrom && resumeFrom.originalUserText) || prompt || "",
  ).trim();
  if (!text) throw new Error('usage: colabo.mjs "prompt"');

  const m = await meetMod();
  const {
    writePardonStack,
    readPardonRequest,
    clearPardonRequest,
    clearPardonStack,
    hasPardonStack,
    PARDON_PAUSE_MARKER,
  } = await import("./lib/meet-pardon.mjs");

  const meeting = (await m.ensureRoom?.()) || m.loadCurrentMeeting();
  if (!meeting) throw new Error("no open room — run: gotchibot meet open");

  if (ring) {
    await inviteRing(m, ring);
  } else {
    const agents = agentIds(meeting);
    if (!agents.length) {
      await m.inviteAllParticipants();
    }
  }
  const meeting2 = m.loadCurrentMeeting();
  const mid = meeting2.id;
  let list = agentIds(meeting2);
  if (ring) {
    const cfg = loadRings();
    const ringDef = cfg.rings?.[ring];
    const { required, optional } = heroesForRoles(ringDef?.roles || []);
    const allow = new Set([...required, ...optional].map((t) => t.hero));
    list = list.filter((id) => allow.has(id));
  }
  if (!list.length) {
    throw new Error(
      ring
        ? ("ring \"" + ring + "\" has no agent participants in the room")
        : "no agent participants",
    );
  }

  const spokenIds = Array.isArray(resumeFrom?.spokenIds)
    ? [...resumeFrom.spokenIds]
    : [];
  if (resumeFrom?.remainingSpeakerIds?.length) {
    list = [...resumeFrom.remainingSpeakerIds];
  } else {
    // Fresh colabo clears any leftover park from a prior round.
    clearPardonStack(mid);
    clearPardonRequest(mid);
    await m.sayTurn(
      "[colabo · " + (ring ? "ring:" + ring : "everyone") + "] Julius asks:\n\n" + text,
      { keepStack: true },
    );
  }

  const replies = [];
  let paused = false;

  const parkRemaining = (remaining, reason) => {
    if (!remaining.length) return;
    writePardonStack(mid, {
      kind: "colabo",
      originalUserText: text,
      remainingSpeakerIds: remaining,
      spokenIds,
      speakers: [...spokenIds, ...remaining],
      pickNote: "colabo",
      ring: ring || null,
      reason: reason || "pardon",
      timeoutS,
    });
  };

  // If prompter SIGTERMs us mid-agent, park whoever is left (best-effort).
  const onSignal = () => {
    const idx = spokenIds.length;
    // remaining ≈ list slice from current — approximate via replies length
    const done = new Set(spokenIds);
    const remaining = list.filter((id) => !done.has(id));
    parkRemaining(remaining, "signal");
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  try {
    // Sequential to keep transcript readable (parallel would race transcript locks)
    for (let i = 0; i < list.length; i++) {
      const id = list[i];
      // Cooperative pause: honor pardon.request between agents.
      const req = readPardonRequest(mid);
      if (req) {
        const remaining = list.slice(i);
        parkRemaining(remaining, "pardon");
        clearPardonRequest(mid);
        // Room note only — do not wake the chair LLM for the pause marker.
        try {
          const { appendFileSync, mkdirSync, writeFileSync } = await import("node:fs");
          const { join } = await import("node:path");
          const dir = join(ROOT, "sessions/meetings", mid);
          mkdirSync(dir, { recursive: true });
          appendFileSync(
            join(dir, "transcript.jsonl"),
            JSON.stringify({
              ts: new Date().toISOString(),
              speaker: meeting2.chairId || "system",
              role: "system",
              text: PARDON_PAUSE_MARKER,
            }) + "\n",
          );
          writeFileSync(
            join(ROOT, "sessions/.meet-channel.stamp"),
            new Date().toISOString() + "\n",
          );
        } catch {
          /* room note best-effort */
        }
        paused = true;
        break;
      }

      const r = await runAgent(id, text, timeoutS);
      replies.push({ id, ...r });
      spokenIds.push(id);
      await m.sayTurn(`[colabo · ${id}]\n\n${(r.text || "").slice(0, 2500)}`, {
        keepStack: true,
      });
    }

    if (!paused) {
      clearPardonStack(mid);
      clearPardonRequest(mid);
      await m.sayTurn(
        `[colabo] Done — ${replies.filter((x) => x.ok).length}/${list.length} agents replied.`,
        { keepStack: true },
      );
    }
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }

  return {
    meetingId: mid,
    prompt: text,
    replies,
    paused,
    parked: paused ? hasPardonStack(mid) : false,
  };
}

/** Resume a parked colabo round (/continue). */
export async function resumeColabo(stack) {
  if (!stack || stack.kind !== "colabo") {
    throw new Error("resumeColabo: not a colabo stack");
  }
  return colabo(stack.originalUserText || "", {
    timeoutS: Number(stack.timeoutS) || 90,
    resumeFrom: stack,
    ring: stack.ring || null,
  });
}

function usage() {
  const cfg = loadRings();
  const known = Object.keys(cfg.rings || {}).join(", ") || "(none yet)";
  console.error([
    "usage:",
    '  colabo.mjs "prompt" [--ring design] [--timeout SEC] [--json]',
    '  colabo.mjs --prompt "..." [--ring design] [--timeout SEC] [--json]',
    "",
    "rings (config/colabo-rings.json): " + known,
    "  design — CoS chairs; architect required; infra-monitor optional",
    "Prefer --ring for CoS rounds. Bare colabo still invites all if the room is empty.",
  ].join("\n"));
  process.exit(2);
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === "-h" || argv[0] === "--help") usage();
  let prompt = "";
  let timeoutS = 90;
  let json = false;
  let ring = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--prompt") prompt = argv[++i] || "";
    else if (a === "--timeout") timeoutS = Number(argv[++i]) || timeoutS;
    else if (a === "--ring") ring = String(argv[++i] || "").trim() || null;
    else if (a === "--json") json = true;
    else if (!a.startsWith("--") && !prompt) prompt = a;
    else if (!a.startsWith("--")) prompt = `${prompt} ${a}`.trim();
  }
  const r = await colabo(prompt, { timeoutS, ring });
  if (json) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`colabo ${r.meetingId}`);
    for (const x of r.replies) {
      console.log(`  ${x.ok ? "✓" : "✗"} ${x.id} (${x.via})`);
    }
  }
}

if (process.argv[1]?.endsWith("colabo.mjs")) {
  main().catch((e) => {
    console.error(e?.message || e);
    process.exit(1);
  });
}
