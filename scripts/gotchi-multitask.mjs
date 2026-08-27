#!/usr/bin/env node
/**
 * Cursor-style /multitask — decompose a request and spawn parallel sub-agents.
 *
 * usage:
 *   gotchi-multitask.mjs run [--model nim] [--wait] [--merge] "compound request"
 *   gotchi-multitask.mjs run --tasks "task one" "task two"
 *   gotchi-multitask.mjs status <groupId>
 *   gotchi-multitask.mjs wait <groupId>
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSpawnGate } from "./wallet-gate.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DISPATCH = `${ROOT}/scripts/opencode-dispatch.sh`;
const SESSIONS = `${ROOT}/sessions`;
const GROUPS = `${SESSIONS}/.multitask`;

function usage() {
  console.error(`usage:
  gotchi-multitask.mjs run [--model nim|pro|local] [--wait] [--merge] [--max N] "request"
  gotchi-multitask.mjs run --tasks "task one" "task two" [--model nim]
  gotchi-multitask.mjs status <groupId>
  gotchi-multitask.mjs wait <groupId>`);
  process.exit(2);
}

function dispatch(args, { capture = false } = {}) {
  const r = spawnSync(DISPATCH, args, { cwd: ROOT, encoding: "utf8" });
  if (!capture && r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) process.exit(r.status ?? 1);
  return (r.stdout || "").trim();
}

function sessionStatus(id) {
  const env = `${SESSIONS}/${id}/state.env`;
  if (!existsSync(env)) return "?";
  const m = readFileSync(env, "utf8").match(/^status=(.+)$/m);
  return m?.[1] ?? "?";
}

function groupPath(id) {
  return `${GROUPS}/${id}.json`;
}

function loadGroup(id) {
  const p = groupPath(id);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

function saveGroup(group) {
  mkdirSync(GROUPS, { recursive: true });
  writeFileSync(groupPath(group.id), `${JSON.stringify(group, null, 2)}\n`);
}

function splitHeuristic(text) {
  const parts = text
    .split(/\n\s*(?:[-*]|\d+[.)])\s+/)
    .flatMap((chunk) => chunk.split(/\s*;\s*/))
    .flatMap((chunk) => chunk.split(/\s+and then\s+/i))
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : [text.trim()];
}

function decomposeViaOpencode(text, max) {
  const system = `Break this compound dev request into ${max} or fewer parallel sub-agent tasks.
Reply with ONLY valid JSON (no markdown):
{"tasks":[{"prompt":"self-contained task with definition of done","model":"nim|pro|local"}]}
Use pro only for architecture/hard bugs; local for private/offline. Default nim.
If one coherent task, return a single-element array.`;
  const r = spawnSync(
    "opencode",
    [
      "run",
      "-m",
      "opencode/hy3-free",
      "--title",
      "gotchibot:multitask",
      `${system}\n\nRequest:\n${text}`,
    ],
    { cwd: ROOT, encoding: "utf8", timeout: 45_000 },
  );
  if (r.status !== 0) return null;
  const raw = (r.stdout || "").trim();
  const jsonStart = raw.indexOf("{");
  const jsonEnd = raw.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd <= jsonStart) return null;
  try {
    const data = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
    const tasks = Array.isArray(data?.tasks) ? data.tasks : null;
    if (!tasks?.length) return null;
    return tasks.slice(0, max).map((t) => ({
      prompt: String(t.prompt || t.task || "").trim(),
      model: ["nim", "pro", "local"].includes(t.model) ? t.model : "nim",
    })).filter((t) => t.prompt);
  } catch {
    return null;
  }
}

async function resolveTasks(argv) {
  let model = "nim";
  let max = 5;
  let explicit = false;
  const tasks = [];
  const rest = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model" && argv[i + 1]) {
      model = argv[++i];
    } else if (a === "--max" && argv[i + 1]) {
      max = Math.min(8, Math.max(1, Number(argv[++i]) || 5));
    } else if (a === "--tasks") {
      explicit = true;
      while (argv[i + 1] && !argv[i + 1].startsWith("--")) {
        tasks.push({ prompt: argv[++i], model });
      }
    } else if (a.startsWith("--")) {
      continue;
    } else {
      rest.push(a);
    }
  }

  if (explicit) {
    return tasks.filter((t) => t.prompt);
  }

  const request = rest.join(" ").trim();
  if (!request) usage();

  let decomposed =
    process.env.GOTCHIBOT_MULTITASK_OFFLINE === "1" ? null : decomposeViaOpencode(request, max);
  if (!decomposed?.length) {
    decomposed = splitHeuristic(request).slice(0, max).map((prompt) => ({ prompt, model }));
  }
  return decomposed;
}

async function cmdRun(argv) {
  const wait = argv.includes("--wait");
  const merge = argv.includes("--merge");
  const jsonOut = argv.includes("--json");
  const filtered = argv.filter((a) => !["--wait", "--merge", "--json"].includes(a));

  const gate = await checkSpawnGate();
  if (!gate.ok) {
    console.error(`multitask blocked (${gate.code}): ${gate.message}`);
    if (gate.fix) console.error(`fix: ${gate.fix}`);
    process.exit(gate.code === "wallet" ? 10 : gate.code === "cartridge" ? 11 : 12);
  }

  const tasks = await resolveTasks(filtered);
  if (!tasks.length) {
    console.error("no tasks to spawn");
    process.exit(1);
  }

  const groupId = `m${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
  const sessions = [];

  spawnSync("node", [`${ROOT}/scripts/tts.mjs`, "speak", `Multitask: spawning ${tasks.length} sub-agents.`, "--force"], {
    stdio: "ignore",
  });

  for (const task of tasks) {
    const id = dispatch(["new", "--model", task.model, task.prompt], { capture: true });
    sessions.push({ id, model: task.model, prompt: task.prompt, status: "running" });
    if (!jsonOut) {
      console.log(`  → ${id} (${task.model})`);
    }
  }

  const group = {
    id: groupId,
    created: new Date().toISOString(),
    sessions,
  };
  saveGroup(group);

  if (!jsonOut) {
    console.log(`\nmultitask ${groupId}: ${sessions.length} sub-agents running`);
    console.log(`  list:    ./scripts/gotchibot list`);
    console.log(`  wait:    ./scripts/gotchibot multitask wait ${groupId}`);
    console.log(`  status:  ./scripts/gotchibot multitask status ${groupId}`);
  } else {
    console.log(JSON.stringify({ ok: true, groupId, sessions: sessions.map((s) => s.id) }, null, 2));
  }

  if (wait) {
    dispatch(["wait", ...sessions.map((s) => s.id)]);
    cmdStatus([groupId], { merge, quiet: !merge && !jsonOut });
  }
}

function cmdStatus(args, { merge = false, quiet = false } = {}) {
  const id = args[0];
  if (!id) usage();
  const group = loadGroup(id);
  if (!group) {
    console.error(`unknown multitask group: ${id}`);
    process.exit(1);
  }

  let running = 0;
  let done = 0;
  let failed = 0;
  for (const s of group.sessions) {
    s.status = sessionStatus(s.id);
    if (s.status === "running") running++;
    else if (s.status === "done") done++;
    else if (s.status === "failed") failed++;
  }
  saveGroup(group);

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ ...group, running, done, failed }, null, 2));
    return;
  }

  console.log(`multitask ${id}: ${done} done, ${running} running, ${failed} failed`);
  for (const s of group.sessions) {
    console.log(`  ${s.id}  ${s.status.padEnd(8)}  ${s.model}  ${s.prompt.slice(0, 60)}${s.prompt.length > 60 ? "…" : ""}`);
  }

  if (merge) {
    console.log("\n--- merged output ---\n");
    for (const s of group.sessions) {
      const out = `${SESSIONS}/${s.id}/output.md`;
      if (!existsSync(out)) continue;
      console.log(`## ${s.id}\n`);
      console.log(readFileSync(out, "utf8").trim());
      console.log("\n");
    }
  } else if (!quiet && done > 0) {
    console.log(`\nMerge outputs: ./scripts/gotchibot multitask status ${id} --merge`);
  }
}

function cmdWait(args) {
  const id = args[0];
  if (!id) usage();
  const group = loadGroup(id);
  if (!group) {
    console.error(`unknown multitask group: ${id}`);
    process.exit(1);
  }
  dispatch(["wait", ...group.sessions.map((s) => s.id)]);
  cmdStatus([id], { merge: args.includes("--merge") });
}

const cmd = process.argv[2];
const rest = process.argv.slice(3);

switch (cmd) {
  case "run":
    await cmdRun(rest);
    break;
  case "status":
    cmdStatus(rest, { merge: rest.includes("--merge") });
    break;
  case "wait":
    cmdWait(rest.filter((a) => a !== "--merge"));
    break;
  default:
    usage();
}
