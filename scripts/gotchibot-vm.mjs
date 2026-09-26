#!/usr/bin/env node
/**
 * GotchiBot QEMU/KVM VM sandbox (2020 iMac only) — the VM twin of sandbox.mjs.
 *
 *   node scripts/gotchibot-vm.mjs ensure-image
 *   node scripts/gotchibot-vm.mjs up <id> [--json]
 *   node scripts/gotchibot-vm.mjs exec <id> -- <cmd...>
 *   node scripts/gotchibot-vm.mjs status [id]
 *   node scripts/gotchibot-vm.mjs models <id> [--check <model>] [--json]
 *   node scripts/gotchibot-vm.mjs promote <id> <destDir>
 *   node scripts/gotchibot-vm.mjs rm <id> [--purge]
 *
 * Isolation: own kernel, 2 vCPU / 2 GiB / 20G overlay on a read-only Debian 12 base.
 * User-mode NAT only: SSH on 127.0.0.1:<port>, host at 10.0.2.2. No bridge, no UFW rules.
 * /work is copied in and out over SSH; AGENTS.md + skills registry land root-owned 0444.
 * Design: docs/GOTCHIBOT-VM-2020.md. Proven flags: scripts/vm-phase1-test.sh.
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
  renameSync,
  statSync,
  chmodSync,
  accessSync,
  openSync,
  readSync,
  closeSync,
  constants as fsc,
} from "node:fs";
import { dirname, resolve, join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, hostname } from "node:os";
import { createHash } from "node:crypto";
import { createServer } from "node:net";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VMS = `${ROOT}/vms`;
const CACHE = `${homedir()}/.cache/gotchibot-vm`;
const KEY = `${homedir()}/.ssh/gotchibot-vm`;
const URL = "https://cloud.debian.org/images/cloud/bookworm/latest";
const GUEST_USER = "gotchi";
const GUEST_WORK = "/work";
const GUEST_SESSION = "/session";
const SANDBOX_ENV = "/etc/gotchibot/sandbox.env";

function envOr(name, fallback) {
  const v = process.env[name];
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

const IMAGE = envOr("GOTCHIBOT_VM_IMAGE", "debian-12-genericcloud-amd64.qcow2");
const BASE = `${CACHE}/${IMAGE}`;
const VM_CPUS = envOr("GOTCHIBOT_VM_CPUS", "2");
const VM_MEMORY_MB = envOr("GOTCHIBOT_VM_MEMORY_MB", "2048");
const VM_DISK = envOr("GOTCHIBOT_VM_DISK", "20G");
const VM_PORT = Number(envOr("GOTCHIBOT_VM_PORT", "2222"));
const PORT_SEARCH = 20;

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

const TOOLS = {
  "qemu-system-x86_64": "qemu-base",
  "qemu-img": "qemu-base",
  "cloud-localds": "cloud-image-utils",
};

function usage() {
  console.error(`usage:
  gotchibot-vm.mjs ensure-image
  gotchibot-vm.mjs up <id> [--json]
  gotchibot-vm.mjs exec <id> -- <cmd...>
  gotchibot-vm.mjs status [id]
  gotchibot-vm.mjs models <id> [--check <model>] [--json]
  gotchibot-vm.mjs promote <id> <destDir>
  gotchibot-vm.mjs rm <id> [--purge]`);
  process.exit(2);
}

function safeId(id) {
  const s = String(id || "").replace(/[^a-zA-Z0-9._-]/g, "");
  if (!s) throw new Error("invalid sessionId");
  return s;
}

const vmName = (id) => `gbvm-${safeId(id)}`;
const vmDir = (id) => `${VMS}/${safeId(id)}`;
const workDir = (id) => `${vmDir(id)}/work`;
const metaPath = (id) => `${vmDir(id)}/meta.json`;
const pidPath = (id) => `${vmDir(id)}/qemu.pid`;
const sessionDir = (id) => `${ROOT}/sessions/${safeId(id)}`;
const here = () => hostname().replace(/\.local$/, "");

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function hasTool(name) {
  return String(process.env.PATH || "")
    .split(delimiter)
    .some((d) => d && existsSync(join(d, name)));
}

function readMeta(id) {
  try {
    return JSON.parse(readFileSync(metaPath(id), "utf8"));
  } catch {
    return {};
  }
}

function writeMeta(id, meta) {
  writeFileSync(metaPath(id), `${JSON.stringify(meta, null, 2)}\n`);
}

function readPid(id) {
  try {
    const n = Number(readFileSync(pidPath(id), "utf8").trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * A pidfile can outlive its qemu (host reboot, OOM kill) and the number gets
 * reused. On Linux, check the pid is actually a qemu before calling it ours —
 * rm must never kill some unrelated process that inherited the number.
 */
function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    if (e.code !== "EPERM") return false;
  }
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("qemu");
  } catch {
    return true; // no /proc (macOS): trust kill(0)
  }
}

const vmRunning = (id) => pidAlive(readPid(id));

function requireKvm() {
  try {
    accessSync("/dev/kvm", fsc.R_OK | fsc.W_OK);
  } catch {
    // Name the machine we are actually on, same as requireDocker(): a VM
    // backend that "fails" on the MBP is working as designed.
    console.error(`no /dev/kvm on ${here()}; VMs run on the 2020 iMac`);
    process.exit(3);
  }
  for (const [tool, pkg] of Object.entries(TOOLS)) {
    if (!hasTool(tool)) {
      console.error(`${tool} not found on ${here()} — approved Arch package: ${pkg} (ask UserDefault; never auto-install)`);
      process.exit(3);
    }
  }
  ensureKey();
  try {
    accessSync(KEY, fsc.R_OK);
    accessSync(`${KEY}.pub`, fsc.R_OK);
  } catch {
    console.error(`guest SSH key not usable on ${here()}: ${KEY} (+ .pub)`);
    process.exit(3);
  }
}

function ensureKey() {
  if (existsSync(KEY)) return;
  mkdirSync(dirname(KEY), { recursive: true, mode: 0o700 });
  const r = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `gotchibot-vm@${hostname()}`, "-f", KEY], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`ssh-keygen failed: ${r.stderr || r.error?.message || "unknown"}`);
  console.error(`[vm] generated guest SSH key ${KEY}`);
}

function sha512File(path) {
  const h = createHash("sha512");
  const buf = Buffer.alloc(4 << 20);
  const fd = openSync(path, "r");
  try {
    let n;
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return h.digest("hex");
}

function curl(args, inherit) {
  return spawnSync("curl", args, { stdio: ["ignore", inherit ? "inherit" : "pipe", "inherit"], encoding: "utf8" });
}

function cmdEnsureImage() {
  requireKvm();
  mkdirSync(CACHE, { recursive: true });
  // The base was verified when it was downloaded and has been read-only since;
  // re-hashing ~400 MB on every `up` buys nothing.
  if (existsSync(BASE) && statSync(BASE).isFile() && statSync(BASE).size > 0) {
    console.error(`[vm] image ready: ${BASE}`);
    return;
  }
  const part = `${BASE}.part`;
  const sums = `${CACHE}/SHA512SUMS`;
  console.error(`[vm] downloading ${IMAGE} from ${URL}`);
  let r = curl(["-fL", "--progress-bar", "-o", part, `${URL}/${IMAGE}`], true);
  if (r.status !== 0) {
    rmSync(part, { force: true });
    throw new Error(`download failed (curl exit ${r.status ?? r.error?.message})`);
  }
  console.error(`[vm] downloaded ${(statSync(part).size / 2 ** 20).toFixed(1)} MiB`);
  r = curl(["-fsSL", "-o", sums, `${URL}/SHA512SUMS`], false);
  if (r.status !== 0) {
    rmSync(part, { force: true });
    throw new Error(`SHA512SUMS download failed (curl exit ${r.status ?? r.error?.message})`);
  }
  const want = readFileSync(sums, "utf8")
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .find(([, f]) => f === IMAGE)?.[0];
  const got = sha512File(part);
  if (!want || want !== got) {
    rmSync(part, { force: true });
    console.error(`[vm] checksum mismatch for ${IMAGE} (${want ? "hash differs" : "not listed in SHA512SUMS"})`);
    process.exit(1);
  }
  renameSync(part, BASE);
  // Every overlay backs onto this file; a write here corrupts all of them.
  chmodSync(BASE, statSync(BASE).mode & ~0o222);
  console.error(`[vm] checksum OK`);
  console.error(`[vm] image ready: ${BASE}`);
}

function sshOpts(id, port, portFlag = "-p") {
  return [
    "-i",
    KEY,
    portFlag,
    String(port),
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=5",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    `UserKnownHostsFile=${vmDir(id)}/known_hosts`,
  ];
}

const GUEST = `${GUEST_USER}@127.0.0.1`;

/** `remote` is joined by ssh and parsed by the guest shell — fixed strings only. */
function vmSsh(id, port, remote, opts = {}) {
  return spawnSync("ssh", [...sshOpts(id, port), GUEST, ...remote], { encoding: "utf8", stdio: "pipe", ...opts });
}

function mustSsh(id, port, remote, what, opts = {}) {
  const r = vmSsh(id, port, remote, opts);
  if (r.status !== 0) throw new Error(`${what} failed: ${String(r.stderr || r.error?.message || "").trim()}`);
  return r;
}

/** Quote one argument for a POSIX shell: 'it'\''s' */
function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function portFree(port) {
  return new Promise((res) => {
    const s = createServer();
    s.once("error", () => res(false));
    s.listen(port, "127.0.0.1", () => s.close(() => res(true)));
  });
}

async function pickPort(preferred) {
  if (preferred && (await portFree(preferred))) return preferred;
  for (let p = VM_PORT; p < VM_PORT + PORT_SEARCH; p++) {
    if (await portFree(p)) return p;
  }
  console.error(`[vm] no free SSH port in 127.0.0.1:${VM_PORT}-${VM_PORT + PORT_SEARCH - 1}`);
  process.exit(1);
}

/** rsync needs to exist on both ends; the genericcloud guest may not ship it. */
function useRsync(id, port) {
  return hasTool("rsync") && vmSsh(id, port, ["command -v rsync"]).status === 0;
}

function rsyncSsh(id, port) {
  return ["ssh", ...sshOpts(id, port)].map(shq).join(" ");
}

function pushWork(id, port) {
  const work = workDir(id);
  if (useRsync(id, port)) {
    console.error(`[vm] syncing ${work} → ${GUEST_WORK} (rsync)`);
    const r = spawnSync("rsync", ["-a", "--delete", "-e", rsyncSsh(id, port), `${work}/`, `${GUEST}:${GUEST_WORK}/`], {
      stdio: ["ignore", "ignore", "pipe"],
      encoding: "utf8",
    });
    if (r.status !== 0) throw new Error(`rsync push failed: ${r.stderr}`);
    return;
  }
  // scp has no --delete: copy to a fresh dir, then swap it in for /work.
  console.error(`[vm] syncing ${work} → ${GUEST_WORK} (scp)`);
  mustSsh(id, port, ["rm -rf /tmp/gbwork-push"], "guest cleanup");
  const r = spawnSync("scp", ["-q", "-r", ...sshOpts(id, port, "-P"), work, `${GUEST}:/tmp/gbwork-push`], {
    stdio: ["ignore", "ignore", "pipe"],
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`scp push failed: ${r.stderr}`);
  mustSsh(
    id,
    port,
    [`sudo rm -rf ${GUEST_WORK} && sudo mv /tmp/gbwork-push ${GUEST_WORK} && sudo chown -R ${GUEST_USER}:${GUEST_USER} ${GUEST_WORK}`],
    "guest /work swap",
  );
}

function pullWork(id, port) {
  const work = workDir(id);
  if (useRsync(id, port)) {
    console.error(`[vm] pulling ${GUEST_WORK} → ${work} (rsync)`);
    mkdirSync(work, { recursive: true });
    const r = spawnSync("rsync", ["-a", "-e", rsyncSsh(id, port), `${GUEST}:${GUEST_WORK}/`, `${work}/`], {
      stdio: ["ignore", "ignore", "pipe"],
      encoding: "utf8",
    });
    if (r.status !== 0) throw new Error(`rsync pull failed: ${r.stderr}`);
    return;
  }
  console.error(`[vm] pulling ${GUEST_WORK} → ${work} (scp)`);
  const tmp = `${vmDir(id)}/work.pull`;
  rmSync(tmp, { recursive: true, force: true });
  const r = spawnSync("scp", ["-q", "-r", ...sshOpts(id, port, "-P"), `${GUEST}:${GUEST_WORK}`, tmp], {
    stdio: ["ignore", "ignore", "pipe"],
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`scp pull failed: ${r.stderr}`);
  rmSync(work, { recursive: true, force: true });
  renameSync(tmp, work);
}

/** Write a guest file from stdin as root. Content never touches argv. */
function guestWrite(id, port, path, content, { owner, mode, umask = "022" }) {
  const script = `umask ${umask} && cat > ${path} && chown ${owner} ${path} && chmod ${mode} ${path}`;
  mustSsh(id, port, [`sudo sh -c ${shq(script)}`], `write ${path}`, { input: content });
}

function envLine(k, v) {
  return `${k}=${shq(v)}\n`;
}

/** One 2 GiB guest fits in 7.6 GiB alongside the Aarcade stack; two make it swap. */
function runningOther(sid) {
  if (!existsSync(VMS)) return null;
  for (const ent of readdirSync(VMS, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name === sid) continue;
    const pid = readPid(ent.name);
    if (pidAlive(pid)) return { id: ent.name, pid };
  }
  return null;
}

function printUp(meta, json) {
  if (json) console.log(JSON.stringify({ ok: true, ...meta }, null, 2));
  else {
    console.log(meta.name);
    console.error(`[vm] up ${meta.name} port=${meta.port} work=${meta.work}`);
  }
}

async function cmdUp(id, { json = false } = {}) {
  requireKvm();
  const sid = safeId(id);
  const name = vmName(sid);
  const dir = vmDir(sid);

  const other = runningOther(sid);
  if (other) {
    console.error(
      `[vm] refusing: ${vmName(other.id)} is already running (pid ${other.pid}) — only one VM fits in the 2020 iMac's RAM. ` +
        `Stop it first: node scripts/gotchibot-vm.mjs rm ${other.id}`,
    );
    process.exit(4);
  }
  if (vmRunning(sid)) {
    printUp({ ...readMeta(sid), id: sid, name, status: "running" }, json);
    return;
  }

  const work = workDir(sid);
  const sess = sessionDir(sid);
  mkdirSync(work, { recursive: true });
  mkdirSync(sess, { recursive: true });
  if (!existsSync(BASE)) cmdEnsureImage();

  const disk = `${dir}/disk.qcow2`;
  const seed = `${dir}/seed.iso`;
  if (!existsSync(disk)) {
    const r = spawnSync("qemu-img", ["create", "-q", "-f", "qcow2", "-F", "qcow2", "-b", BASE, disk, VM_DISK], {
      stdio: "pipe",
      encoding: "utf8",
    });
    if (r.status !== 0) throw new Error(`qemu-img create failed: ${r.stderr}`);
  }

  const pub = readFileSync(`${KEY}.pub`, "utf8").trim();
  writeFileSync(
    `${dir}/user-data`,
    `#cloud-config
hostname: ${name}
users:
  - name: ${GUEST_USER}
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - ${pub}
ssh_pwauth: false
`,
  );
  writeFileSync(`${dir}/meta-data`, `instance-id: ${name}\nlocal-hostname: ${name}\n`);
  let r = spawnSync("cloud-localds", [seed, `${dir}/user-data`, `${dir}/meta-data`], { stdio: "pipe", encoding: "utf8" });
  if (r.status !== 0) throw new Error(`cloud-localds failed: ${r.stderr}`);

  const port = await pickPort(readMeta(sid).port);
  rmSync(pidPath(sid), { force: true });
  r = spawnSync(
    "qemu-system-x86_64",
    [
      "-name", name,
      "-machine", "q35,accel=kvm",
      "-cpu", "host",
      "-smp", VM_CPUS,
      "-m", VM_MEMORY_MB,
      "-drive", `file=${disk},if=virtio,format=qcow2`,
      "-drive", `file=${seed},if=virtio,format=raw,readonly=on`,
      "-netdev", `user,id=n0,hostfwd=tcp:127.0.0.1:${port}-:22`,
      "-device", "virtio-net-pci,netdev=n0",
      "-display", "none",
      "-serial", `file:${dir}/serial.log`,
      "-pidfile", pidPath(sid),
      "-daemonize",
    ],
    { stdio: "pipe", encoding: "utf8" },
  );
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout || "qemu-system-x86_64 failed");
    process.exit(r.status ?? 1);
  }
  console.error(`[vm] booted ${name} (pid ${readPid(sid)})`);

  console.error(`[vm] waiting for SSH on 127.0.0.1:${port}`);
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    ready = vmSsh(sid, port, ["true"]).status === 0;
    if (!ready) sleep(3000);
  }
  if (!ready) {
    console.error(`[vm] SSH not ready after 180s; see ${dir}/serial.log`);
    process.exit(1);
  }
  console.error("[vm] SSH ready");

  mustSsh(
    sid,
    port,
    [
      `sudo mkdir -p ${GUEST_WORK} ${GUEST_SESSION} /rules ${dirname(SANDBOX_ENV)} && ` +
        `sudo chown ${GUEST_USER}:${GUEST_USER} ${GUEST_WORK} ${GUEST_SESSION}`,
    ],
    "guest setup",
  );
  pushWork(sid, port);

  // Rules are copied, not mounted: root-owned 0444 so the job can read, not edit.
  const rules = [
    [`${ROOT}/AGENTS.md`, "/rules/AGENTS.md"],
    [`${ROOT}/skills/registry.json`, "/rules/skills-registry.json"],
  ];
  for (const [src, dst] of rules) {
    if (existsSync(src)) guestWrite(sid, port, dst, readFileSync(src), { owner: "root:root", mode: "0444" });
  }

  // Secrets travel over SSH stdin into a 0600 file — never argv, meta.json,
  // logs or stdout. Only the NAMES are recorded, so a job that fails for lack
  // of a key is still distinguishable from a provider outage.
  const abraKey = process.env.ABRA_KEY || process.env.GOTCHIBOT_SANDBOX_ABRA_KEY || "";
  let env = "GOTCHIBOT_SANDBOX=1\nGOTCHIBOT_SKIP_ABRA=1\nABRA_HOST=10.0.2.2\n";
  const forwarded = [];
  if (abraKey) {
    env += envLine("ABRA_KEY", abraKey);
    forwarded.push("ABRA_KEY");
  }
  for (const k of FORWARD_ENV) {
    if (k === "ABRA_KEY" || !process.env[k]) continue;
    env += envLine(k, process.env[k]);
    forwarded.push(k);
  }
  guestWrite(sid, port, SANDBOX_ENV, env, { owner: `${GUEST_USER}:${GUEST_USER}`, mode: "600", umask: "077" });
  console.error(
    forwarded.length
      ? `[vm] forwarded credentials: ${forwarded.join(", ")}`
      : "[vm] WARNING: no credentials forwarded — model calls from this box will fail",
  );

  const meta = {
    id: sid,
    sessionId: sid,
    name,
    port,
    disk,
    seed,
    work,
    session: sess,
    cpus: VM_CPUS,
    memoryMb: VM_MEMORY_MB,
    image: BASE,
    startedAt: new Date().toISOString(),
    status: "running",
    forwardedEnv: forwarded,
  };
  writeMeta(sid, meta);
  printUp(meta, json);
}

function requireRunning(sid) {
  const port = readMeta(sid).port;
  if (!vmRunning(sid) || !port) {
    console.error(`vm not running: ${vmName(sid)} — run: node scripts/gotchibot-vm.mjs up ${sid}`);
    process.exit(1);
  }
  return port;
}

/** The job sees the forwarded env and starts in /work, like `docker exec -w /work`. */
function guestCommand(args) {
  return `set -a; . ${SANDBOX_ENV}; set +a; cd ${GUEST_WORK}; exec ${args.map(shq).join(" ")}`;
}

function cmdExec(id, cmdArgs) {
  const sid = safeId(id);
  const port = requireRunning(sid);
  if (!cmdArgs.length) usage();
  // One ssh argv element: the guest shell sees each user arg single-quoted,
  // so spaces, globs and `;` stay literal.
  const r = vmSsh(sid, port, [guestCommand(cmdArgs)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

function cmdStatus(id) {
  if (!id) {
    const rows = [];
    if (existsSync(VMS)) {
      for (const ent of readdirSync(VMS, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const sid = ent.name;
        const running = vmRunning(sid);
        rows.push({ id: sid, name: vmName(sid), running, port: running ? readMeta(sid).port ?? null : null, work: workDir(sid) });
      }
    }
    console.log(JSON.stringify({ ok: true, vms: rows }, null, 2));
    return;
  }
  const sid = safeId(id);
  console.log(
    JSON.stringify({ ok: true, id: sid, name: vmName(sid), running: vmRunning(sid), work: workDir(sid), ...readMeta(sid) }, null, 2),
  );
}

function cmdModels(id, { json = false, check = null } = {}) {
  const sid = safeId(id);
  const port = requireRunning(sid);
  if (vmSsh(sid, port, ["command -v opencode"]).status !== 0) {
    console.error("opencode not installed in this VM (Phase 3)");
    process.exit(1);
  }
  const r = vmSsh(sid, port, [guestCommand(["opencode", "models"])], { timeout: 60_000 });
  const models = String(r.stdout || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("["));
  if (check) {
    const ok = models.includes(check);
    if (json) console.log(JSON.stringify({ ok, model: check, models }, null, 2));
    else if (ok) console.log(`ok ${check}`);
    else {
      console.error(`model not available in this VM: ${check}`);
      console.error(`the box serves: ${models.join(", ") || "(none — opencode models returned nothing)"}`);
    }
    process.exit(ok ? 0 : 1);
  }
  if (json) console.log(JSON.stringify({ models }, null, 2));
  else for (const m of models) console.log(m);
}

function cmdPromote(id, dest) {
  const sid = safeId(id);
  const work = workDir(sid);
  if (!dest) {
    console.error("promote requires destDir (e.g. ~/Dev/my-new-app)");
    process.exit(2);
  }
  const port = readMeta(sid).port;
  if (vmRunning(sid) && port) pullWork(sid, port);
  else if (existsSync(work)) console.error(`[vm] ${vmName(sid)} not running — promoting the last copy in ${work}`);
  if (!existsSync(work)) {
    console.error(`no work dir: ${work}`);
    process.exit(1);
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
  console.error(`[vm] promoted ${sid} → ${destAbs}`);
}

function signal(pid, sig) {
  try {
    process.kill(pid, sig);
  } catch {
    /* already gone */
  }
}

/** vm-phase1-test.sh cmd_down, plus a SIGKILL so no qemu is ever left behind. */
function stopVm(sid) {
  const pid = readPid(sid);
  if (!pidAlive(pid)) return;
  const port = readMeta(sid).port;
  const off = port ? vmSsh(sid, port, ["sudo systemctl poweroff"]) : { status: 1 };
  if (off.status !== 0) signal(pid, "SIGTERM");
  for (let i = 0; i < 30 && pidAlive(pid); i++) sleep(1000);
  if (pidAlive(pid)) signal(pid, "SIGTERM");
  for (let i = 0; i < 5 && pidAlive(pid); i++) sleep(1000);
  if (pidAlive(pid)) signal(pid, "SIGKILL");
  sleep(500);
  if (pidAlive(pid)) {
    console.error(`[vm] qemu pid ${pid} for ${vmName(sid)} survived SIGKILL — not deleting its disk`);
    process.exit(1);
  }
  console.error(`[vm] stopped ${vmName(sid)} (pid ${pid} gone)`);
}

function cmdRm(id, { purge = false } = {}) {
  const sid = safeId(id);
  const dir = vmDir(sid);
  stopVm(sid);
  // The shared base in ~/.cache/gotchibot-vm is never touched: other VMs back onto it.
  for (const f of ["disk.qcow2", "seed.iso", "user-data", "meta-data", "qemu.pid", "known_hosts"]) {
    rmSync(`${dir}/${f}`, { force: true });
  }
  if (purge) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      console.error(`[vm] purged ${dir}`);
    }
    return;
  }
  if (existsSync(metaPath(sid))) {
    const { port, ...meta } = readMeta(sid);
    writeMeta(sid, { ...meta, status: "stopped", stoppedAt: new Date().toISOString() });
  }
  console.error(`[vm] kept ${workDir(sid)} (use --purge to delete)`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) usage();

  if (cmd === "ensure-image") {
    cmdEnsureImage();
    return;
  }
  if (cmd === "up") {
    const id = rest[0];
    if (!id) usage();
    await cmdUp(id, { json: rest.includes("--json") });
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
  if (cmd === "models") {
    const id = rest[0];
    if (!id) usage();
    const ci = rest.indexOf("--check");
    cmdModels(id, { json: rest.includes("--json"), check: ci >= 0 ? rest[ci + 1] : null });
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

main().catch((e) => {
  console.error(`[vm] ${e?.message || e}`);
  process.exit(1);
});
