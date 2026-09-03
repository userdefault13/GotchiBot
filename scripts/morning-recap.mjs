#!/usr/bin/env node
/**
 * Morning meeting recap — wake agents, collect reports, chair-led present loop.
 *
 *   node scripts/morning-recap.mjs tasks [--hero id] [--json]
 *   node scripts/morning-recap.mjs collect [--host imac|local|auto] [--timeout SEC]
 *   node scripts/morning-recap.mjs present
 *   node scripts/morning-recap.mjs next
 *   node scripts/morning-recap.mjs finish
 *   node scripts/morning-recap.mjs status [--json]
 *
 * Prefer: ./scripts/gotchibot meet morning …
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CFG_PATH = join(ROOT, "config/morning-recap.json");

function loadCfg() {
  try {
    return JSON.parse(readFileSync(CFG_PATH, "utf8"));
  } catch {
    return {
      title: "Morning recap",
      defaultTasks: [
        "What did you finish yesterday?",
        "What is blocked?",
        "What will you do today by default?",
      ],
      byHero: {},
      reportMaxWords: 180,
    };
  }
}

function tasksFor(heroId, roleId) {
  const cfg = loadCfg();
  if (heroId && cfg.byHero?.[heroId]?.length) return cfg.byHero[heroId];
  if (roleId && cfg.byRole?.[roleId]?.length) return cfg.byRole[roleId];
  return cfg.defaultTasks || [];
}

async function meet() {
  return import("./gotchi-meet.mjs");
}

function recapDir(meetingId) {
  const d = join(ROOT, "sessions/meetings", meetingId, "recaps");
  mkdirSync(d, { recursive: true });
  return d;
}

function statePath(meetingId) {
  return join(ROOT, "sessions/meetings", meetingId, "morning-recap-state.json");
}

function loadState(meetingId) {
  const p = statePath(meetingId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function saveState(meetingId, st) {
  writeFileSync(statePath(meetingId), JSON.stringify(st, null, 2) + "\n");
}

function agentParticipants(meeting) {
  return (meeting.participants || []).filter((p) => p.role === "agent");
}

function buildAgentPrompt(heroId, meeting, cfg) {
  const tasks = tasksFor(heroId, null);
  const max = cfg.reportMaxWords || 180;
  const list = tasks.map((t, i) => `${i + 1}. ${t}`).join("\n");
  return `You are ${heroId} in morning meeting ${meeting.id} (topic: ${meeting.topic}).
Run a MORNING RECAP. Answer each task briefly. Max ~${max} words total.

Tasks:
${list}

Write the full report to output.md as markdown with heading "# Morning recap — ${heroId}".
Do not become orch. Prefer Hub Claude via: node ./scripts/claudemode-submit.mjs "…" for hard reasoning, then note the job id in output.md.
Stay on big-pickle for your own turns; Claude is a tool.`;
}

function spawnAgent({ heroId, host, prompt, model }) {
  const env = {
    ...process.env,
    GOTCHIBOT_HERO_ID: heroId,
  };
  const args = [
    join(ROOT, "scripts/gotchi-orchestrate.mjs"),
    "spawn",
    "--host",
    host,
    "--model",
    model || "sub",
    prompt,
  ];
  // Prefer abra when spawning to imac from Desk
  const useAbra =
    host !== "local" &&
    spawnSync("which", ["abra"], { encoding: "utf8" }).status === 0 &&
    !(process.env.SSH_PRIVATE_KEY && process.env.REMOTE_HOST);

  let r;
  if (useAbra) {
    r = spawnSync(
      "abra",
      ["run", "gotchibot", "--", "node", ...args],
      { cwd: ROOT, encoding: "utf8", env, timeout: 120_000, maxBuffer: 4 << 20 },
    );
  } else {
    r = spawnSync(process.execPath, args, {
      cwd: ROOT,
      encoding: "utf8",
      env,
      timeout: 120_000,
      maxBuffer: 4 << 20,
    });
  }
  const out = `${r.stdout || ""}\n${r.stderr || ""}`;
  const m = out.match(/\b(s\d{8}-\d{6}-\d+)\b/);
  return {
    ok: r.status === 0 && Boolean(m),
    sessionId: m ? m[1] : null,
    raw: out.slice(0, 500),
  };
}

function waitSession({ sessionId, host, timeoutSec }) {
  const args = [
    join(ROOT, "scripts/gotchi-orchestrate.mjs"),
    "wait",
    "--host",
    host,
    sessionId,
    "--timeout",
    String(timeoutSec || 180),
  ];
  const useAbra =
    host !== "local" &&
    spawnSync("which", ["abra"], { encoding: "utf8" }).status === 0 &&
    !(process.env.SSH_PRIVATE_KEY && process.env.REMOTE_HOST);
  if (useAbra) {
    return spawnSync("abra", ["run", "gotchibot", "--", "node", ...args], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: (Number(timeoutSec) + 60) * 1000,
      maxBuffer: 8 << 20,
    });
  }
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: (Number(timeoutSec) + 60) * 1000,
    maxBuffer: 8 << 20,
  });
}

function readSessionOutput({ sessionId, host }) {
  const args = [
    join(ROOT, "scripts/gotchi-orchestrate.mjs"),
    "output",
    "--host",
    host,
    sessionId,
  ];
  const useAbra =
    host !== "local" &&
    spawnSync("which", ["abra"], { encoding: "utf8" }).status === 0 &&
    !(process.env.SSH_PRIVATE_KEY && process.env.REMOTE_HOST);
  const r = useAbra
    ? spawnSync("abra", ["run", "gotchibot", "--", "node", ...args], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 8 << 20,
      })
    : spawnSync(process.execPath, args, {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 8 << 20,
      });
  return String(r.stdout || r.stderr || "").trim();
}

export async function collectRecaps({
  host = "auto",
  timeoutSec = 180,
  model = "sub",
} = {}) {
  const m = await meet();
  let meeting = m.loadCurrentMeeting();
  if (!meeting) throw new Error("no open meeting — start morning recap first");
  if (meeting.kind && meeting.kind !== "morning-recap" && meeting.kind !== "meeting") {
    /* allow either */
  }

  const cfg = loadCfg();
  let agents = agentParticipants(meeting);
  if (!agents.length) {
    await m.inviteAllParticipants();
    meeting = m.loadCurrentMeeting();
    agents = agentParticipants(meeting);
  }
  if (!agents.length) throw new Error("no agent participants — invite heroes first");

  const dir = recapDir(meeting.id);
  const results = [];

  // Fan-out spawns in parallel
  const spawns = agents.map((a) => {
    const prompt = buildAgentPrompt(a.id, meeting, cfg);
    const s = spawnAgent({ heroId: a.id, host, prompt, model });
    return { heroId: a.id, ...s };
  });

  for (const s of spawns) {
    if (!s.ok || !s.sessionId) {
      const fallback = `# Morning recap — ${s.heroId}\n\n(spawn failed)\n\n\`\`\`\n${s.raw}\n\`\`\`\n`;
      writeFileSync(join(dir, `${s.heroId}.md`), fallback);
      results.push({ heroId: s.heroId, ok: false, error: "spawn-failed" });
      continue;
    }
    waitSession({ sessionId: s.sessionId, host, timeoutSec });
    const out = readSessionOutput({ sessionId: s.sessionId, host });
    const body =
      out.trim() ||
      `# Morning recap — ${s.heroId}\n\n(empty output.md — session ${s.sessionId})\n`;
    writeFileSync(join(dir, `${s.heroId}.md`), body.endsWith("\n") ? body : `${body}\n`);
    results.push({ heroId: s.heroId, ok: true, sessionId: s.sessionId });
  }

  const order = agents.map((a) => a.id);
  saveState(meeting.id, {
    phase: "collected",
    order,
    index: 0,
    results,
    updatedAt: new Date().toISOString(),
  });

  // Chair announce
  await m.sayTurn(
    `[morning-recap] Collected ${results.filter((r) => r.ok).length}/${results.length} agent reports. Chair will present each summary — ask questions per agent, then /next.`,
  );

  return { meetingId: meeting.id, results, dir };
}

export async function presentCurrent() {
  const m = await meet();
  const meeting = m.loadCurrentMeeting();
  if (!meeting) throw new Error("no open meeting");
  const st = loadState(meeting.id) || {
    order: agentParticipants(meeting).map((p) => p.id),
    index: 0,
  };
  const heroId = st.order[st.index];
  if (!heroId) {
    return finishGoalsReady();
  }
  const path = join(recapDir(meeting.id), `${heroId}.md`);
  const body = existsSync(path)
    ? readFileSync(path, "utf8")
    : `(no recap file for ${heroId})`;
  const cfg = loadCfg();
  const hint = cfg.presentPauseHint || "Questions? Then /next";

  await m.sayTurn(
    `[morning-recap] Presenting **${heroId}** (${st.index + 1}/${st.order.length}).\n\n${body.slice(0, 3500)}\n\n_${hint}_`,
  );

  st.phase = "presenting";
  st.currentHero = heroId;
  st.updatedAt = new Date().toISOString();
  saveState(meeting.id, st);
  return { meetingId: meeting.id, heroId, index: st.index, total: st.order.length };
}

export async function presentNext() {
  const m = await meet();
  const meeting = m.loadCurrentMeeting();
  if (!meeting) throw new Error("no open meeting");
  const st = loadState(meeting.id);
  if (!st?.order?.length) throw new Error("no morning-recap state — run collect first");
  st.index = Number(st.index || 0) + 1;
  saveState(meeting.id, st);
  if (st.index >= st.order.length) {
    return finishGoalsReady();
  }
  return presentCurrent();
}

export async function finishGoalsReady() {
  const m = await meet();
  const meeting = m.loadCurrentMeeting();
  if (!meeting) throw new Error("no open meeting");
  const st = loadState(meeting.id) || {};
  st.phase = "goals";
  st.updatedAt = new Date().toISOString();
  saveState(meeting.id, st);
  await m.sayTurn(
    `[morning-recap] All agents presented. **Agents are ready to take down today's goals.** Tell the chair what to work on today — or use Colabo (\`/colabo …\` / \`gotchibot meet colabo "…"\`) to hear from everyone.`,
  );
  return { meetingId: meeting.id, phase: "goals" };
}

function usage() {
  console.error(`usage:
  morning-recap.mjs tasks [--hero id] [--json]
  morning-recap.mjs collect [--host imac|local|auto] [--timeout SEC]
  morning-recap.mjs present | next | finish
  morning-recap.mjs status [--json]`);
  process.exit(2);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || "status";
  const json = argv.includes("--json");
  let host = "auto";
  let timeout = 180;
  let hero = "";
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--host") host = argv[++i] || host;
    else if (argv[i] === "--timeout") timeout = Number(argv[++i]) || timeout;
    else if (argv[i] === "--hero") hero = argv[++i] || "";
  }

  if (cmd === "tasks") {
    const cfg = loadCfg();
    const tasks = tasksFor(hero || null, null);
    if (json) console.log(JSON.stringify({ hero: hero || null, tasks, cfg: { title: cfg.title } }, null, 2));
    else {
      console.log(cfg.title || "Morning recap");
      if (hero) console.log(`hero ${hero}`);
      tasks.forEach((t, i) => console.log(`${i + 1}. ${t}`));
      console.log(`\nedit: ${CFG_PATH}`);
    }
    return;
  }

  if (cmd === "collect") {
    const r = await collectRecaps({ host, timeoutSec: timeout });
    if (json) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(`collected ${r.results.filter((x) => x.ok).length}/${r.results.length} → ${r.dir}`);
      console.log("next: ./scripts/morning-recap.mjs present");
    }
    return;
  }

  if (cmd === "present") {
    const r = await presentCurrent();
    console.log(json ? JSON.stringify(r, null, 2) : `presenting ${r.heroId} (${r.index + 1}/${r.total})`);
    return;
  }

  if (cmd === "next") {
    const r = await presentNext();
    console.log(json ? JSON.stringify(r, null, 2) : r.phase === "goals" ? "goals-ready" : `presenting ${r.heroId}`);
    return;
  }

  if (cmd === "finish") {
    const r = await finishGoalsReady();
    console.log(json ? JSON.stringify(r, null, 2) : "goals-ready");
    return;
  }

  if (cmd === "status") {
    const m = await meet();
    const meeting = m.loadCurrentMeeting();
    const st = meeting ? loadState(meeting.id) : null;
    const files = meeting && existsSync(recapDir(meeting.id))
      ? readdirSync(recapDir(meeting.id)).filter((f) => f.endsWith(".md"))
      : [];
    const payload = {
      meetingId: meeting?.id || null,
      kind: meeting?.kind || null,
      state: st,
      recaps: files,
    };
    if (json) console.log(JSON.stringify(payload, null, 2));
    else console.log(JSON.stringify(payload, null, 2));
    return;
  }

  usage();
}

if (process.argv[1]?.endsWith("morning-recap.mjs")) {
  main().catch((e) => {
    console.error(e?.message || e);
    process.exit(1);
  });
}
