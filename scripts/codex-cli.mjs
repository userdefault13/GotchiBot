#!/usr/bin/env node
/**
 * Codex CLI bridge — gotchi talks on big-pickle/Nemotron/Hy3; Codex executes work.
 * Mirrors cursor-cli.mjs but thinner.
 *
 * usage:
 *   codex-cli.mjs run "prompt" [--cwd path] [--model id] [--json] [--dry-run]
 *   codex-cli.mjs resume [sessionId] "follow-up"   # trivial via: codex exec resume --last
 *   codex-cli.mjs status                           # binary path + version (no secrets)
 *
 * Headless run invokes: codex exec --sandbox workspace-write -C <cwd> [-m model] <prompt>
 * Never pass --api-key. Resume is trivial via `codex exec resume --last`.
 */
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = `${ROOT}/sessions`;

function usage() {
  console.error(`usage:
  codex-cli.mjs run "prompt" [--cwd path] [--model id] [--json] [--dry-run]
  codex-cli.mjs resume [sessionId] "follow-up"
  codex-cli.mjs status`);
  process.exit(2);
}

function childEnv() {
  const env = { ...process.env };
  delete env.CODEX_API_KEY;
  return env;
}

function resolveCodex() {
  const envBin = (process.env.CODEX_BIN || "").trim();
  if (envBin && existsSync(envBin)) return envBin;
  const r = spawnSync("command", ["-v", "codex"], {
    shell: true,
    encoding: "utf8",
    env: childEnv(),
  });
  const found = (r.stdout || "").trim().split("\n")[0];
  if (found && existsSync(found)) return found;
  return null;
}

function requireBin() {
  const bin = resolveCodex();
  if (!bin) {
    console.error(
      "codex not found. Expected $CODEX_BIN or `codex` on PATH (codex-cli). Install via the official Codex CLI installer. Do not invent a second install path.",
    );
    process.exit(1);
  }
  return bin;
}

function readStdin() {
  if (process.stdin.isTTY) return "";
  try {
    return readFileSync(0, "utf8").trim();
  } catch {
    return "";
  }
}

function makeRunDir() {
  const id = `x${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
  const dir = join(SESSIONS, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "state.env"),
    `status=running\nstarted=${new Date().toISOString()}\nprovider=codex-cli\n`,
  );
  return dir;
}

function finishRunDir(dir, ok, output) {
  const status = ok ? "done" : "failed";
  writeFileSync(join(dir, "output.md"), output || "");
  const base = readFileSync(join(dir, "state.env"), "utf8");
  writeFileSync(
    join(dir, "state.env"),
    `${base.replace(/^status=.*$/m, `status=${status}`)}ended=${new Date().toISOString()}\n`,
  );
  return dir.split("/").pop();
}

function parseRunArgs(argv) {
  const opts = {
    model: null,
    json: false,
    cwd: ROOT,
    dryRun: false,
    resume: null,
  };
  const parts = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--api-key" || a.startsWith("--api-key=")) {
      console.error("never pass --api-key; use the logged-in Codex account / CODEX_BIN");
      process.exit(2);
    } else if (a === "--model" && argv[i + 1]) opts.model = argv[++i];
    else if ((a === "--cwd" || a === "--workspace") && argv[i + 1]) opts.cwd = resolve(argv[++i]);
    else if (a === "--json") opts.json = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--resume" && argv[i + 1]) opts.resume = argv[++i];
    else if (a.startsWith("--")) continue;
    else parts.push(a);
  }
  const prompt = parts.join(" ").trim() || readStdin();
  return { prompt, opts };
}

function buildExecArgs(opts, prompt) {
  const args = ["exec", "--sandbox", "workspace-write", "-C", opts.cwd || ROOT];
  if (opts.model) args.push("-m", opts.model);
  args.push(prompt);
  return args;
}

function buildResumeArgs(opts, sessionId, followUp) {
  const args = ["exec", "resume", "--sandbox", "workspace-write", "-C", opts.cwd || ROOT];
  if (sessionId) args.push(sessionId);
  else args.push("--last");
  args.push(followUp);
  return args;
}

function spawnCodex(bin, args, cwd) {
  return spawnSync(bin, args, {
    cwd,
    encoding: "utf8",
    env: childEnv(),
    timeout: Number(process.env.GOTCHIBOT_CODEX_TIMEOUT_MS ?? 600_000),
    maxBuffer: 20 * 1024 * 1024,
  });
}

function cmdStatus() {
  const bin = requireBin();
  console.log(`bin: ${bin}`);
  const r = spawnSync(bin, ["--version"], {
    encoding: "utf8",
    cwd: ROOT,
    env: childEnv(),
  });
  const out = ((r.stdout || r.stderr || "").trim());
  if (out) console.log(out);
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function cmdRun(argv) {
  const bin = requireBin();
  const { prompt, opts } = parseRunArgs(argv);
  if (!prompt) usage();

  const args = buildExecArgs(opts, prompt);

  if (opts.dryRun) {
    const shown = args.map((a, i) =>
      i === args.length - 1 ? `<prompt ${prompt.length} chars>` : a,
    );
    console.log(JSON.stringify({ bin, cwd: opts.cwd, args: shown }, null, 2));
    return;
  }

  const runDir = makeRunDir();
  writeFileSync(join(runDir, "prompt.txt"), prompt);

  const r = spawnCodex(bin, args, opts.cwd);
  const output = (r.stdout || "").trim();
  const err = (r.stderr || "").trim();
  const ok = r.status === 0;
  const sessionId = finishRunDir(runDir, ok, output || err);

  if (opts.json) {
    console.log(
      JSON.stringify(
        { ok, exitCode: r.status, output: output || err },
        null,
        2,
      ),
    );
  } else {
    if (output) console.log(output);
    if (!ok && err) console.error(err);
  }
  console.error(`codex session: ${sessionId}`);
  if (!ok) process.exit(r.status ?? 1);
}

function cmdResume(argv) {
  const bin = requireBin();
  const opts = {
    model: null,
    json: false,
    cwd: ROOT,
    dryRun: false,
  };
  let sessionId = null;
  const promptParts = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--api-key" || a.startsWith("--api-key=")) {
      console.error("never pass --api-key");
      process.exit(2);
    } else if ((a === "--cwd" || a === "--workspace") && argv[i + 1]) {
      opts.cwd = resolve(argv[++i]);
    } else if (a === "--model" && argv[i + 1]) {
      opts.model = argv[++i];
    } else if (a === "--json") {
      opts.json = true;
    } else if (a === "--dry-run") {
      opts.dryRun = true;
    } else if (a.startsWith("--")) {
      continue;
    } else {
      promptParts.push(a);
    }
  }

  // resume [sessionId] "follow-up" — first token is sessionId only when a second remains
  if (promptParts.length >= 2) {
    sessionId = promptParts.shift();
  }
  const followUp = promptParts.join(" ").trim() || readStdin();
  if (!followUp) usage();

  const args = buildResumeArgs(opts, sessionId, followUp);

  if (opts.dryRun) {
    const shown = args.map((a, i) =>
      i === args.length - 1 ? `<prompt ${followUp.length} chars>` : a,
    );
    console.log(JSON.stringify({ bin, cwd: opts.cwd, args: shown }, null, 2));
    return;
  }

  const runDir = makeRunDir();
  writeFileSync(join(runDir, "prompt.txt"), followUp);

  const r = spawnCodex(bin, args, opts.cwd);
  const output = (r.stdout || "").trim();
  const err = (r.stderr || "").trim();
  const ok = r.status === 0;
  const sid = finishRunDir(runDir, ok, output || err);

  if (opts.json) {
    console.log(
      JSON.stringify({ ok, exitCode: r.status, output: output || err }, null, 2),
    );
  } else {
    if (output) console.log(output);
    if (!ok && err) console.error(err);
  }
  console.error(`codex session: ${sid}`);
  if (!ok) process.exit(r.status ?? 1);
}

const cmd = process.argv[2];
const rest = process.argv.slice(3);

switch (cmd) {
  case "run":
    cmdRun(rest);
    break;
  case "resume":
    cmdResume(rest);
    break;
  case "status":
    cmdStatus();
    break;
  default:
    usage();
}
