#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = `${ROOT}/sessions`;

function parseArgs(argv) {
  const args = { spawn: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--spawn") args.spawn = argv[++i] ?? "";
    else if (a === "--max-chars") args.maxChars = parseInt(argv[++i], 10);
    else if (!args.oldId) args.oldId = a;
  }
  return args;
}

function status(dir) {
  try {
    const m = {};
    for (const line of readFileSync(`${dir}/state.env`, "utf8").split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) m[line.slice(0, i)] = line.slice(i + 1);
    }
    return m;
  } catch { return {}; }
}

function pickSession(explicit) {
  if (explicit) return explicit;
  const entries = readdirSync(SESSIONS)
    .filter((n) => /^s\d{8}-\d{6}-/.test(n) && statSync(join(SESSIONS, n)).isDirectory())
    .sort();
  const finished = entries.filter((n) => {
    const s = status(`${SESSIONS}/${n}`);
    return s.status === "done" || s.status === "failed";
  });
  return finished.at(-1) ?? entries.at(-1);
}

function truncate(s, max) {
  s = s.trim();
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated]`;
}

const args = parseArgs(process.argv.slice(2));
const maxChars = args.maxChars ?? 12000;
const oldId = pickSession(args.oldId);

if (!oldId || !existsSync(`${SESSIONS}/${oldId}`)) {
  console.error("no prior session found to hand off from");
  process.exit(1);
}

const dir = `${SESSIONS}/${oldId}`;
const st = status(dir);
let prompt = "";
let output = "";
try { prompt = readFileSync(`${dir}/prompt.txt`, "utf8"); } catch {}
try { output = readFileSync(`${dir}/output.md`, "utf8"); } catch {}

const budget = Math.max(2000, maxChars - prompt.length - output.length - 3000);
let knowledge = "";
if (existsSync(`${ROOT}/KNOWLEDGE.md`)) {
  knowledge = truncate(readFileSync(`${ROOT}/KNOWLEDGE.md`, "utf8"), budget);
}

const handoff = `# HANDOFF — ${new Date().toISOString()}

## Prior session: ${oldId} (${st.model ?? "?"}, ${st.status ?? "?"})

### Original task
${truncate(prompt, 2000)}

### Result
${truncate(output, Math.floor(maxChars * 0.5))}

## Project knowledge
${knowledge || "(no KNOWLEDGE.md yet)"}

## Instructions
You are continuing work from a previous GotchiBot session. Use the context
above. Do not redo completed work; verify results before building on them.
`;

writeFileSync(`${SESSIONS}/HANDOFF.md`, handoff);
console.log(`handoff written: sessions/HANDOFF.md (from ${oldId})`);

if (args.spawn !== null) {
  const seed = `${args.spawn ? `Task: ${args.spawn}\n\n` : ""}${handoff}`;
  const id = execFileSync(
    "/bin/bash",
    [`${ROOT}/scripts/opencode-dispatch.sh`, "new", seed],
    { encoding: "utf8" },
  ).trim();
  console.log(`spawned continuation session: ${id}`);
}
