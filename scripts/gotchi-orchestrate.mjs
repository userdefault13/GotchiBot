#!/usr/bin/env node
/**
 * Gotchi orchestrator shell bridge — wallet gate + opencode-dispatch spawn.
 * Used by the gotchi OpenCode agent and OpenClaw bot tools.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSpawnGate } from "./wallet-gate.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DISPATCH = `${ROOT}/scripts/opencode-dispatch.sh`;

function usage() {
  console.error(`usage:
  gotchi-orchestrate.mjs gate [--json]
  gotchi-orchestrate.mjs spawn [--model nim|pro|local|<provider/model>] "PROMPT"
  gotchi-orchestrate.mjs list
  gotchi-orchestrate.mjs wait [<id>...]
  gotchi-orchestrate.mjs output <id>`);
  process.exit(2);
}

function runDispatch(args, { capture = false } = {}) {
  const r = spawnSync(DISPATCH, args, { cwd: ROOT, encoding: "utf8" });
  if (!capture && r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) process.exit(r.status ?? 1);
  return (r.stdout || "").trim();
}

async function cmdGate() {
  const gate = await checkSpawnGate();
  if (!gate.ok) {
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify(gate, null, 2));
    } else {
      console.error(`blocked: ${gate.message}`);
      if (gate.fix) console.error(`fix: ${gate.fix}`);
    }
    process.exit(gate.code === "wallet" ? 10 : gate.code === "cartridge" ? 11 : 12);
  }
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(gate, null, 2));
  } else {
    console.log(`ok owner=${gate.owner} cartridge=${gate.cartridgeId} heroes=${gate.heroCount}`);
  }
}

async function cmdSpawn(argv) {
  const gate = await checkSpawnGate();
  if (!gate.ok) {
    console.error(`spawn blocked (${gate.code}): ${gate.message}`);
    if (gate.fix) console.error(`fix: ${gate.fix}`);
    process.exit(gate.code === "wallet" ? 10 : gate.code === "cartridge" ? 11 : 12);
  }

  let model = "nim";
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--model" && argv[i + 1]) {
      model = argv[++i];
    } else {
      rest.push(argv[i]);
    }
  }
  const prompt = rest.join(" ").trim();
  if (!prompt) usage();

  const id = runDispatch(["new", "--model", model, prompt], { capture: true });
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ ok: true, sessionId: id, model, gate }, null, 2));
  } else {
    console.log(id);
    console.error(`spawned ${id} (model=${model}, hero=${gate.activeHeroId ?? "roster"})`);
  }
}

const cmd = process.argv[2];
const rest = process.argv.slice(3);

switch (cmd) {
  case "gate":
    await cmdGate();
    break;
  case "spawn":
    await cmdSpawn(rest);
    break;
  case "list":
    runDispatch(["list"]);
    break;
  case "wait":
    runDispatch(["wait", ...rest]);
    break;
  case "output":
    if (!rest[0]) usage();
    runDispatch(["output", rest[0]]);
    break;
  default:
    usage();
}
