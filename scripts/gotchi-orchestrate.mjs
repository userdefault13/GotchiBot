#!/usr/bin/env node
/**
 * Gotchi orchestrator shell bridge — wallet gate + opencode-dispatch spawn.
 * Used by the gotchi OpenCode agent and OpenClaw bot tools.
 *
 * Host selection (gotchi mode prefers Tailscale iMac when reachable):
 *   --host local|imac|auto   (default: auto → imac if REMOTE_* SSH works)
 *   GOTCHIBOT_SPAWN_HOST=local|imac|auto
 * Sandbox (new projects):
 *   --sandbox | GOTCHIBOT_SANDBOX=1
 *   Requires GOTCHIBOT_HERO_ID with status === available. Never auto-mint.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSpawnGate } from "./wallet-gate.mjs";
import { getTopology } from "./topology.mjs";
import { assertSandboxHeroAvailable } from "./hero-agent-state.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DISPATCH = `${ROOT}/scripts/opencode-dispatch.sh`;
const REMOTE_SPAWN = `${ROOT}/scripts/remote-spawn.mjs`;

function usage() {
  console.error(`usage:
  gotchi-orchestrate.mjs gate [--json]
  gotchi-orchestrate.mjs spawn [--host local|imac|auto] [--sandbox] [--model sub|nim|pro|local|<provider/model>] "PROMPT"
  gotchi-orchestrate.mjs list
  gotchi-orchestrate.mjs wait [--host local|imac] [<id>...]
  gotchi-orchestrate.mjs output [--host local|imac] <id>`);
  process.exit(2);
}

function runDispatch(args, { capture = false, env = process.env } = {}) {
  const r = spawnSync(DISPATCH, args, { cwd: ROOT, encoding: "utf8", env });
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
  let sandbox = process.env.GOTCHIBOT_SANDBOX === "1";
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--host" && argv[i + 1]) {
      host = String(argv[++i]).toLowerCase();
    } else if (argv[i] === "--sandbox") {
      sandbox = true;
    } else {
      rest.push(argv[i]);
    }
  }
  if (!["local", "imac", "auto", "remote"].includes(host)) {
    console.error(`unknown --host ${host} (use local|imac|auto)`);
    process.exit(2);
  }
  if (host === "remote") host = "imac";
  return { host, sandbox, rest };
}

async function resolveHost(want) {
  if (want === "local") return "local";
  const topology = getTopology();
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
  const { host: wantHost, sandbox, rest: argv2 } = parseHostAndRest(argv);
  const host = await resolveHost(wantHost);

  if (sandbox) {
    const heroCheck = await assertSandboxHeroAvailable(process.env.GOTCHIBOT_HERO_ID || "");
    if (!heroCheck.ok) {
      console.error(`sandbox spawn blocked (${heroCheck.code}): ${heroCheck.message}`);
      if (heroCheck.fix) console.error(`fix: ${heroCheck.fix}`);
      console.error("Never auto-mint. Use /spawn overlay yourself if you need a new hero.");
      process.exit(13);
    }
  }

  if (host === "imac") {
    const args = [...argv2];
    if (sandbox && !args.includes("--sandbox")) args.unshift("--sandbox");
    if (process.argv.includes("--json") && !args.includes("--json")) args.push("--json");
    const r = spawnSync(process.execPath, [REMOTE_SPAWN, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, ...(sandbox ? { GOTCHIBOT_SANDBOX: "1" } : {}) },
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
    } else if (argv2[i] === "--json" || argv2[i] === "--sandbox") {
      // handled elsewhere
    } else {
      rest.push(argv2[i]);
    }
  }
  const prompt = rest.join(" ").trim();
  if (!prompt) usage();

  const useExplicit = model !== "sub" && model !== "auto";

  let resolvedModel;
  let route;

  if (!useExplicit) {
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
    resolvedModel = model;
    route = "spawn";
  }

  // Sandbox jobs never use host cursor-cli (escape hatch).
  if (sandbox && route === "cursor-cli") {
    route = "spawn";
    resolvedModel = resolvedModel || "opencode/big-pickle";
  }

  const env = { ...process.env };
  if (sandbox) env.GOTCHIBOT_SANDBOX = "1";

  let id;
  let cursorOutput = "";
  let cursorOk = false;
  if (route === "spawn") {
    const dArgs = ["new", "--model", resolvedModel];
    if (sandbox) dArgs.push("--sandbox");
    dArgs.push(prompt);
    id = runDispatch(dArgs, { capture: true, env });
  } else if (route === "cursor-cli") {
    const cr = spawnSync("node", ["scripts/cursor-cli.mjs", "run", prompt, "--cwd", ROOT], {
      encoding: "utf8",
      cwd: ROOT,
      timeout: 600_000,
    });
    cursorOutput = (cr.stdout || "").trim();
    cursorOk = cr.status === 0;
    id = `cursor-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  } else {
    const dArgs = ["new", "--model", resolvedModel];
    if (sandbox) dArgs.push("--sandbox");
    dArgs.push(prompt);
    id = runDispatch(dArgs, { capture: true, env });
  }

  spawnSync("bash", [`${ROOT}/scripts/poke-avatar.sh`], { stdio: "ignore" });
  if (process.argv.includes("--json") || argv2.includes("--json")) {
    const base = {
      ok: true,
      host: "local",
      sessionId: id,
      model: resolvedModel,
      sandbox: !!sandbox,
      gate,
    };
    if (route === "cursor-cli") {
      Object.assign(base, { route: "cursor-cli", cursorOutput, cursorOk });
    }
    console.log(JSON.stringify(base, null, 2));
  } else {
    console.log(id);
    console.error(
      `spawned ${id} on local (model=${resolvedModel}, hero=${gate.activeHeroId ?? process.env.GOTCHIBOT_HERO_ID ?? "roster"}${sandbox ? ", sandbox" : ""})`,
    );
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
