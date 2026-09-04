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
import { homedir } from "node:os";

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
    console.error("docker not available — install Docker Desktop on this host (iMac)");
    process.exit(3);
  }
}

function cmdEnsureImage() {
  requireDocker();
  if (!existsSync(DOCKERFILE)) {
    console.error(`missing ${DOCKERFILE}`);
    process.exit(1);
  }
  console.error(`[sandbox] building ${IMAGE}…`);
  const r = docker(["build", "-t", IMAGE, "-f", DOCKERFILE, `${ROOT}/docker/sandbox`], {
    stdio: "inherit",
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
  console.error(`[sandbox] image ready: ${IMAGE}`);
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
