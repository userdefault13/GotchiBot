#!/usr/bin/env node
/**
 * Gotchi orchestrator shell bridge — wallet gate + opencode-dispatch spawn.
 * Used by the gotchi OpenCode agent and OpenClaw bot tools.
 *
 * Host selection (gotchi mode prefers Tailscale iMac when reachable):
 *   --host local|imac|auto   (default: auto → imac if REMOTE_* SSH works)
 *   GOTCHIBOT_SPAWN_HOST=local|imac|auto
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSpawnGate } from "./wallet-gate.mjs";
import { getTopology } from "./topology.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DISPATCH = `${ROOT}/scripts/opencode-dispatch.sh`;
const REMOTE_SPAWN = `${ROOT}/scripts/remote-spawn.mjs`;

function usage() {
  console.error(`usage:
  gotchi-orchestrate.mjs gate [--json]
  gotchi-orchestrate.mjs spawn [--host local|imac|auto] [--model sub|nim|pro|local|<provider/model>] "PROMPT"
  gotchi-orchestrate.mjs list
  gotchi-orchestrate.mjs wait [--host local|imac] [<id>...]
  gotchi-orchestrate.mjs output [--host local|imac] <id>`);
  process.exit(2);
}

function runDispatch(args, { capture = false } = {}) {
  const r = spawnSync(DISPATCH, args, { cwd: ROOT, encoding: "utf8" });
  if (!capture && r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) process.exit(r.status ?? 1);
  return (r.stdout || "").trim();
}

async function probeRemote() {
  const host = process.env.REMOTE_HOST || process.env.GOTCHIBOT_REMOTE_HOST || "";
  const user = process.env.REMOTE_USER || process.env.GOTCHIBOT_REMOTE_USER || "";
  const key = process.env.SSH_PRIVATE_KEY || "";
  if (!host || !user || !key) return false;
  const { assertRemoteReady, materializeKey, runSsh } = await import("./remote-lib.mjs");
  try {
    const cfg = assertRemoteReady();
    const mat = materializeKey(cfg.key);
    try {
      const r = runSsh(cfg, mat.path, "echo ok", { stdio: "pipe" });
      return r.status === 0 && String(r.stdout || "").includes("ok");
    } finally {
      mat.dispose();
    }
  } catch {
    return false;
  }
}

function parseHostAndRest(argv) {
  let host = (process.env.GOTCHIBOT_SPAWN_HOST || "auto").toLowerCase();
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--host" && argv[i + 1]) {
      host = String(argv[++i]).toLowerCase();
    } else {
      rest.push(argv[i]);
    }
  }
  if (!["local", "imac", "auto", "remote"].includes(host)) {
    console.error(`unknown --host ${host} (use local|imac|auto)`);
    process.exit(2);
  }
  if (host === "remote") host = "imac";
  return { host, rest };
}

async function resolveHost(want) {
  if (want === "local") return "local";
  const topology = getTopology();
  // Explicit --host imac always probes (power users / tests). Solo only
  // changes the `auto` default so we don't break intentional remote spawns.
  if (want === "imac") {
    const ok = await probeRemote();
    if (!ok) {
      console.error(
        "remote iMac not reachable over Tailscale SSH — set REMOTE_HOST/USER + SSH key via abra, or use --host local",
      );
      process.exit(3);
    }
    return "imac";
  }
  // auto: solo → local; legacy/fleet → prefer remote when reachable
  if (topology.mode === "solo") return "local";
  return (await probeRemote()) ? "imac" : "local";
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
  const { host: wantHost, rest: argv2 } = parseHostAndRest(argv);
  const host = await resolveHost(wantHost);

  if (host === "imac") {
    const args = [...argv2];
    if (process.argv.includes("--json") && !args.includes("--json")) args.push("--json");
    const r = spawnSync(process.execPath, [REMOTE_SPAWN, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: process.env,
    });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    process.exit(r.status ?? 1);
  }

  const gate = await checkSpawnGate();
  if (!gate.ok) {
    console.error(`spawn blocked (${gate.code}): ${gate.message}`);
    if (gate.fix) console.error(`fix: ${gate.fix}`);
    process.exit(gate.code === "wallet" ? 10 : gate.code === "cartridge" ? 11 : 12);
  }

  let model = "sub";
  const rest = [];
  for (let i = 0; i < argv2.length; i++) {
    if (argv2[i] === "--model" && argv2[i + 1]) {
      model = argv2[++i];
    } else if (argv2[i] === "--json") {
      // handled below
    } else {
      rest.push(argv2[i]);
    }
  }
  const prompt = rest.join(" ").trim();
  if (!prompt) usage();

  // If model is explicitly set to a non-chain value (e.g. nim, pro, local, or a full model id),
  // use it directly and skip the subagent chain.
  const explicitModel = model !== "sub" && model !== "auto";

  let resolvedModel;
  let route;

  if (!explicitModel) {
    // Policy: working-models-only (spawn scope → subagentPrefer chain)
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync(
      "node",
      ["scripts/model-policy.mjs", "pick", "spawn", "--json"],
      { cwd: ROOT, encoding: "utf8" },
    );
    let result = {};
    try {
      result = JSON.parse(String(r.stdout || "").trim() || "{}");
    } catch {
      result = {};
    }
    if (!result.model && result.route !== "cursor-cli") {
      // Fallback to raw subagent picker if policy CLI shape differs
      const r2 = spawnSync("node", ["scripts/model-auto.mjs", "subagent", "--json"], {
        cwd: ROOT,
        encoding: "utf8",
      });
      try {
        result = JSON.parse(String(r2.stdout || r2.stderr || "").trim() || "{}");
      } catch {
        result = { model: "opencode/big-pickle", route: "spawn" };
      }
    }
    route = result.route || "spawn";
    resolvedModel = result.model;
  } else {
    explicitModel = model; // keep the explicit model id
    resolvedModel = model;
    route = "spawn"; // will dispatch with explicit model
  }

  let id;
  if (route === "spawn") {
    id = runDispatch(["new", "--model", resolvedModel, prompt], { capture: true });
  } else if (route === "cursor-cli") {
    // Run the cursor-cli skill: pass the prompt to cursor-agent and work off its output.
    // cursor-cli.mjs run spawns cursor-agent with the prompt and creates a session dir.
    const { spawnSync } = await import("node:child_process");
    const cr = spawnSync("node", ["scripts/cursor-cli.mjs", prompt, "--cwd", ROOT], {
      encoding: "utf8",
      cwd: ROOT,
      timeout: 600_000,
    });
    const cursorOutput = (cr.stdout || "").trim();
    const cursorErr = (cr.stderr || "").trim();
    const cursorOk = cr.status === 0;
    // Write a minimal output.md capturing the cursor agent's result, and note the chat id.
    // cursor-cli creates its own session; we create a marker here for orchestrator tracking.
    const cursorChatId = cursorOk ? String(cr.exitCode || "").trim() : "";
    // Store cursor result in a session-visible way: write to a temp file or the prompt dir.
    // Since we don't have a session dir for cursor, write to the output log and note the chat.
    // For now, just include the output in the JSON report.
    // Skip poke-avatar: no cAavegotchi hero bound to this session.
    id = `cursor-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  } else {
    // fallback: should not happen, but dispatch with the explicit model
    id = runDispatch(["new", "--model", resolvedModel, prompt], { capture: true });
  }

  spawnSync("bash", [`${ROOT}/scripts/poke-avatar.sh`], { stdio: "ignore" });
  if (process.argv.includes("--json") || argv2.includes("--json")) {
    const base = { ok: true, host: "local", sessionId: id, model: resolvedModel, gate };
    if (route === "cursor-cli") {
      Object.assign(base, {
        route: "cursor-cli",
        cursorOutput,
        cursorOk,
      });
    }
    console.log(JSON.stringify(base, null, 2));
  } else {
    console.log(id);
    console.error(`spawned ${id} on local (model=${resolvedModel}, hero=${gate.activeHeroId ?? "roster"})${route === "cursor-cli" ? ` (cursor-agent)` : ""}`);
  }
}

async function cmdWait(argv) {
  const { host: wantHost, rest } = parseHostAndRest(argv);
  const host = wantHost === "auto" ? "local" : wantHost;
  if (host === "imac") {
    const r = spawnSync(process.execPath, [REMOTE_SPAWN, "wait", ...rest], {
      cwd: ROOT,
      encoding: "utf8",
      env: process.env,
    });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    process.exit(r.status ?? 1);
  }
  runDispatch(["wait", ...rest]);
}

async function cmdOutput(argv) {
  const { host: wantHost, rest } = parseHostAndRest(argv);
  const host = wantHost === "auto" ? "local" : wantHost;
  if (!rest[0]) usage();
  if (host === "imac") {
    const r = spawnSync(process.execPath, [REMOTE_SPAWN, "output", rest[0]], {
      cwd: ROOT,
      encoding: "utf8",
      env: process.env,
    });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    process.exit(r.status ?? 1);
  }
  runDispatch(["output", rest[0]]);
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
    await cmdWait(rest);
    break;
  case "output":
    await cmdOutput(rest);
    break;
  default:
    usage();
}
