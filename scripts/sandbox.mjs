#!/usr/bin/env node
/**
 * GotchiBot Docker sandbox for new-build sub-agents.
 *
 *   node scripts/sandbox.mjs ensure-image
 *   node scripts/sandbox.mjs up <sessionId> [--json]
 *   node scripts/sandbox.mjs exec <sessionId> -- <cmd...>
 *   node scripts/sandbox.mjs status [sessionId]
 *   node scripts/sandbox.mjs promote <sessionId> <destDir>
 *   node scripts/sandbox.mjs rm <sessionId> [--purge]
 *
 * Isolation: /work (rw), /session (rw), AGENTS.md + skills/registry.json (ro).
 * No ~/Dev, no docker.sock, no ~/.abra mount. Abra via host.docker.internal + ABRA_KEY only.
 */
import { spawnSync } from "node:child_process";
import {
  symlinkSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  cpSync,
  readdirSync,
} from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, hostname } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IMAGE = process.env.GOTCHIBOT_SANDBOX_IMAGE || "gotchibot-sandbox:local";
const DOCKERFILE = `${ROOT}/docker/sandbox/Dockerfile`;
const SANDBOXES = `${ROOT}/sandboxes`;

const FORWARD_ENV = [
  "NVIDIA_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENCODE_API_KEY",
  "OPENCODE_ZEN_API_KEY",
  "AARCADE_GOTCHIBOT_SERVICE_SECRET",
  "GOTCHIBOT_OWNER",
  "ABRA_KEY",
  "ABRA_PROJECT",
];

function usage() {
  console.error(`usage:
  sandbox.mjs ensure-image
  sandbox.mjs up <sessionId> [--json]
  sandbox.mjs exec <sessionId> -- <cmd...>
  sandbox.mjs status [sessionId]
  sandbox.mjs promote <sessionId> <destDir>
  sandbox.mjs rm <sessionId> [--purge]
  sandbox.mjs container-name <sessionId>`);
  process.exit(2);
}

function safeId(id) {
  const s = String(id || "").replace(/[^a-zA-Z0-9._-]/g, "");
  if (!s) throw new Error("invalid sessionId");
  return s;
}

function containerName(id) {
  return `gotchibot-sandbox-${safeId(id)}`;
}

function workDir(id) {
  return `${SANDBOXES}/${safeId(id)}/work`;
}

function metaPath(id) {
  return `${SANDBOXES}/${safeId(id)}/meta.json`;
}

function sessionDir(id) {
  return `${ROOT}/sessions/${safeId(id)}`;
}

function docker(args, opts = {}) {
  const r = spawnSync("docker", args, {
    encoding: "utf8",
    cwd: ROOT,
    ...opts,
  });
  return r;
}

function requireDocker() {
  const r = docker(["info"], { stdio: "pipe" });
  if (r.status !== 0) {
    // Name the machine we are actually on. This used to say "(iMac)" wherever
    // it ran, which sent people to fix the wrong desk.
    const here = hostname().replace(/\.local$/, "");
    const missing = /not found|ENOENT/i.test(`${r.error?.message || ""}${r.stderr || ""}`);
    console.error(
      missing
        ? `docker CLI not found on ${here} — install Docker Desktop here, or run the sandbox on a desk that has it (./scripts/gotchibot hub roster)`
        : `docker is installed on ${here} but not responding — start Docker Desktop (docker info failed)`,
    );
    process.exit(3);
  }
}

const BUILD_LOCK = `${SANDBOXES}/.image-build.lock`;
/** A cold build is ~4 minutes; anything older than this is a corpse. */
const BUILD_LOCK_STALE_MS = 30 * 60_000;
/** Hard ceiling for one build — a wedged builder must not hang the caller. */
const BUILD_TIMEOUT_MS = Number(process.env.GOTCHIBOT_SANDBOX_BUILD_TIMEOUT_MS || 20 * 60_000);

/** Who else is building this image right now, if anyone. */
function readBuildLock() {
  try {
    const lock = JSON.parse(readFileSync(BUILD_LOCK, "utf8"));
    if (Date.now() - new Date(lock.at).getTime() > BUILD_LOCK_STALE_MS) return null;
    try {
      process.kill(lock.pid, 0);
    } catch {
      return null; // holder is gone
    }
    return lock;
  } catch {
    return null;
  }
}

/**
 * On macOS, `docker build` in a non-interactive SSH session dies in the
 * credential helper: "keychain cannot be accessed because the current session
 * does not allow user interaction". The base image is public and needs no
 * credentials at all, so retry with a config that has no credsStore rather than
 * asking someone to unlock a keychain over SSH.
 */
function looksLikeKeychainLock(text) {
  return /keychain cannot be accessed|error getting credentials/i.test(String(text || ""));
}

/**
 * A credential-helper-free DOCKER_CONFIG that still finds buildx.
 *
 * CLI plugins live *inside* the config directory, so pointing DOCKER_CONFIG at
 * a bare `{}` silently drops buildx and downgrades the build to the deprecated
 * legacy builder — which then rejects flags like --progress. Copy the real
 * config minus the credential entries, and link the plugins back in.
 */
function dockerConfigWithoutCreds() {
  const src = process.env.DOCKER_CONFIG || `${homedir()}/.docker`;
  const dir = `${SANDBOXES}/.docker-nocreds`;
  mkdirSync(dir, { recursive: true });

  let cfg = {};
  try {
    cfg = JSON.parse(readFileSync(`${src}/config.json`, "utf8")) || {};
  } catch {
    cfg = {};
  }
  // credsStore/credHelpers are what reach for the keychain; `auths` holds
  // base64 credentials we have no business duplicating onto disk.
  delete cfg.credsStore;
  delete cfg.credHelpers;
  delete cfg.auths;
  writeFileSync(`${dir}/config.json`, `${JSON.stringify(cfg, null, 2)}\n`);

  const plugins = `${src}/cli-plugins`;
  const link = `${dir}/cli-plugins`;
  try {
    if (existsSync(plugins)) {
      rmSync(link, { force: true, recursive: false });
      symlinkSync(plugins, link);
    }
  } catch {
    /* no plugins to link — legacy builder still works */
  }
  return dir;
}

function buildxAvailable(env) {
  return docker(["buildx", "version"], { stdio: "pipe", env }).status === 0;
}

/** Builds of this image left behind by a caller that died (killed ssh, OOM). */
function orphanBuildPids() {
  const r = spawnSync("pgrep", ["-f", `docker build -t ${IMAGE}`], { encoding: "utf8" });
  return String(r.stdout || "")
    .split("\n")
    .map((n) => Number(n.trim()))
    .filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid);
}

/**
 * A `docker build` outlives the ssh session that started it. Two of them on the
 * same tag then deadlock on the shared build context at 0% CPU, with no
 * timeout and nothing to notice — which is exactly how this wedged the first
 * time. Clear the corpses before starting, and never wait forever.
 */
function clearOrphanBuilds() {
  const pids = orphanBuildPids();
  if (!pids.length) return 0;
  console.error(`[sandbox] found ${pids.length} orphaned build(s) for ${IMAGE} (${pids.join(", ")}) — clearing before rebuild`);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  return pids.length;
}

function runImageBuild(env) {
  return docker(["build", "-t", IMAGE, "-f", DOCKERFILE, `${ROOT}/docker/sandbox`], {
    stdio: ["ignore", "inherit", "pipe"],
    env,
    timeout: BUILD_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
}

function timedOut(r) {
  return r?.error?.code === "ETIMEDOUT" || r?.signal === "SIGKILL";
}

function cmdEnsureImage() {
  requireDocker();
  if (!existsSync(DOCKERFILE)) {
    console.error(`missing ${DOCKERFILE}`);
    process.exit(1);
  }

  const held = readBuildLock();
  if (held) {
    console.error(
      `[sandbox] another build is already running (pid ${held.pid}, started ${held.at}) — waiting for it instead of racing`,
    );
    process.exit(4);
  }
  mkdirSync(SANDBOXES, { recursive: true });
  clearOrphanBuilds();
  writeFileSync(BUILD_LOCK, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() }, null, 2)}\n`);

  try {
    console.error(`[sandbox] building ${IMAGE}…`);
    let r = runImageBuild(process.env);
    if (r.status !== 0 && !timedOut(r) && looksLikeKeychainLock(r.stderr)) {
      const cfgDir = dockerConfigWithoutCreds();
      const env = { ...process.env, DOCKER_CONFIG: cfgDir };
      console.error(
        `[sandbox] docker credential helper needs an interactive keychain; retrying without it (base image is public)` +
          `${buildxAvailable(env) ? "" : " — buildx not found under the fallback config, using the legacy builder"}`,
      );
      r = runImageBuild(env);
    }
    if (timedOut(r)) {
      console.error(
        `[sandbox] build exceeded ${Math.round(BUILD_TIMEOUT_MS / 60000)}m and was killed. ` +
          `A builder that stalls at 0% CPU is usually two builds sharing one context — ` +
          `check: pgrep -fl "docker build -t ${IMAGE}", then retry.`,
      );
      process.exit(5);
    }
    if (r.status !== 0) {
      if (r.stderr) process.stderr.write(r.stderr);
      process.exit(r.status ?? 1);
    }
    console.error(`[sandbox] image ready: ${IMAGE}`);
  } finally {
    try {
      rmSync(BUILD_LOCK, { force: true });
    } catch {
      /* best effort */
    }
  }
}

function imageExists() {
  const r = docker(["image", "inspect", IMAGE], { stdio: "pipe" });
  return r.status === 0;
}

function containerRunning(name) {
  const r = docker(["inspect", "-f", "{{.State.Running}}", name], { stdio: "pipe" });
  return r.status === 0 && String(r.stdout || "").trim() === "true";
}

function containerExists(name) {
  const r = docker(["inspect", name], { stdio: "pipe" });
  return r.status === 0;
}

function cmdUp(id, { json = false } = {}) {
  requireDocker();
  const sid = safeId(id);
  const name = containerName(sid);
  const work = workDir(sid);
  const sess = sessionDir(sid);

  mkdirSync(work, { recursive: true });
  mkdirSync(sess, { recursive: true });
  mkdirSync(`${SANDBOXES}/${sid}`, { recursive: true });

  if (!imageExists()) cmdEnsureImage();

  if (containerRunning(name)) {
    const meta = { sessionId: sid, container: name, work, status: "running" };
    writeFileSync(metaPath(sid), `${JSON.stringify(meta, null, 2)}\n`);
    if (json) console.log(JSON.stringify({ ok: true, ...meta }, null, 2));
    else console.log(name);
    return;
  }

  if (containerExists(name)) {
    docker(["rm", "-f", name], { stdio: "pipe" });
  }

  const agentsMd = `${ROOT}/AGENTS.md`;
  const registry = `${ROOT}/skills/registry.json`;
  const args = [
    "run",
    "-d",
    "--name",
    name,
    "--label",
    "gotchibot.sandbox=1",
    "--label",
    `gotchibot.session=${sid}`,
    "--security-opt",
    "no-new-privileges:true",
    "--network",
    "bridge",
    "--add-host",
    "host.docker.internal:host-gateway",
    "-v",
    `${work}:/work`,
    "-v",
    `${sess}:/session`,
  ];
  if (existsSync(agentsMd)) args.push("-v", `${agentsMd}:/rules/AGENTS.md:ro`);
  if (existsSync(registry)) args.push("-v", `${registry}:/rules/skills-registry.json:ro`);

  args.push("-e", "GOTCHIBOT_SANDBOX=1", "-e", "GOTCHIBOT_SKIP_ABRA=1", "-e", "ABRA_HOST=host.docker.internal");
  for (const k of FORWARD_ENV) {
    if (process.env[k]) args.push("-e", `${k}=${process.env[k]}`);
  }
  args.push(IMAGE);

  const r = docker(args, { stdio: "pipe" });
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout || "docker run failed");
    process.exit(r.status ?? 1);
  }

  const meta = {
    sessionId: sid,
    container: name,
    work,
    session: sess,
    image: IMAGE,
    startedAt: new Date().toISOString(),
    status: "running",
  };
  writeFileSync(metaPath(sid), `${JSON.stringify(meta, null, 2)}\n`);
  if (json) console.log(JSON.stringify({ ok: true, ...meta }, null, 2));
  else {
    console.log(name);
    console.error(`[sandbox] up ${name} work=${work}`);
  }
}

function cmdExec(id, cmdArgs) {
  requireDocker();
  const sid = safeId(id);
  const name = containerName(sid);
  if (!containerRunning(name)) {
    console.error(`sandbox not running: ${name} — run: node scripts/sandbox.mjs up ${sid}`);
    process.exit(1);
  }
  if (!cmdArgs.length) usage();
  const r = docker(["exec", "-w", "/work", name, ...cmdArgs], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

function cmdStatus(id) {
  requireDocker();
  if (!id) {
    mkdirSync(SANDBOXES, { recursive: true });
    const rows = [];
    for (const ent of readdirSync(SANDBOXES, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const sid = ent.name;
      const name = containerName(sid);
      const running = containerRunning(name);
      rows.push({ sessionId: sid, container: name, running, work: workDir(sid) });
    }
    console.log(JSON.stringify({ ok: true, sandboxes: rows }, null, 2));
    return;
  }
  const sid = safeId(id);
  const name = containerName(sid);
  const running = containerRunning(name);
  let meta = {};
  try {
    meta = JSON.parse(readFileSync(metaPath(sid), "utf8"));
  } catch {}
  console.log(
    JSON.stringify(
      {
        ok: true,
        sessionId: sid,
        container: name,
        running,
        work: workDir(sid),
        ...meta,
      },
      null,
      2,
    ),
  );
}

function cmdPromote(id, dest) {
  const sid = safeId(id);
  const work = workDir(sid);
  if (!existsSync(work)) {
    console.error(`no work dir: ${work}`);
    process.exit(1);
  }
  if (!dest) {
    console.error("promote requires destDir (e.g. ~/Dev/my-new-app)");
    process.exit(2);
  }
  const destAbs = resolve(dest.startsWith("~") ? dest.replace(/^~/, homedir()) : dest);
  mkdirSync(dirname(destAbs), { recursive: true });
  if (existsSync(destAbs) && readdirSync(destAbs).length) {
    console.error(`dest not empty: ${destAbs}`);
    process.exit(1);
  }
  mkdirSync(destAbs, { recursive: true });
  cpSync(work, destAbs, { recursive: true });
  console.log(destAbs);
  console.error(`[sandbox] promoted ${sid} → ${destAbs}`);
}

function cmdRm(id, { purge = false } = {}) {
  requireDocker();
  const sid = safeId(id);
  const name = containerName(sid);
  if (containerExists(name)) {
    docker(["rm", "-f", name], { stdio: "pipe" });
    console.error(`[sandbox] stopped ${name}`);
  }
  if (purge) {
    const dir = `${SANDBOXES}/${sid}`;
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      console.error(`[sandbox] purged ${dir}`);
    }
  } else {
    console.error(`[sandbox] kept ${workDir(sid)} (use --purge to delete)`);
  }
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) usage();

  if (cmd === "ensure-image") {
    cmdEnsureImage();
    return;
  }
  if (cmd === "container-name") {
    if (!rest[0]) usage();
    console.log(containerName(rest[0]));
    return;
  }
  if (cmd === "up") {
    const id = rest[0];
    if (!id) usage();
    cmdUp(id, { json: rest.includes("--json") });
    return;
  }
  if (cmd === "exec") {
    const id = rest[0];
    const dash = rest.indexOf("--");
    const cmdArgs = dash >= 0 ? rest.slice(dash + 1) : rest.slice(1);
    if (!id || !cmdArgs.length) usage();
    cmdExec(id, cmdArgs);
    return;
  }
  if (cmd === "status") {
    cmdStatus(rest[0] || null);
    return;
  }
  if (cmd === "promote") {
    if (!rest[0] || !rest[1]) usage();
    cmdPromote(rest[0], rest[1]);
    return;
  }
  if (cmd === "rm") {
    if (!rest[0]) usage();
    cmdRm(rest[0], { purge: rest.includes("--purge") });
    return;
  }
  usage();
}

main();
