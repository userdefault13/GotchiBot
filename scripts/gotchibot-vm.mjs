#!/usr/bin/env node
/**
 * GotchiBot QEMU/KVM VM sandbox (2020 iMac only) — the VM twin of sandbox.mjs.
 *
 *   node scripts/gotchibot-vm.mjs ensure-image [--rebuild]
 *   node scripts/gotchibot-vm.mjs up <id> [--json]
 *   node scripts/gotchibot-vm.mjs exec <id> -- <cmd...>
 *   node scripts/gotchibot-vm.mjs status [id]
 *   node scripts/gotchibot-vm.mjs models <id> [--check <model>] [--json]
 *   node scripts/gotchibot-vm.mjs promote <id> <destDir>
 *   node scripts/gotchibot-vm.mjs rm <id> [--purge]
 *
 * Image: ensure-image downloads + SHA512-verifies the Debian 12 base, then builds a
 * prepared image (node 22 + opencode) ONCE into ~/.cache/gotchibot-vm, reused by every
 * `up`. `up` never builds; without the prepared image it fails fast.
 * Isolation: own kernel, 2 vCPU / 2 GiB / 20G overlay on the read-only prepared image.
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
const GIT_CREDENTIAL_HELPER = "/usr/local/bin/git-credential-gotchibot";

function envOr(name, fallback) {
  const v = process.env[name];
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

// Each git request to github.com gets a fresh 1-hour GitHub App token minted by
// the host's abra serve, limited to the ABRA_KEY's GitHub grant; nothing is stored
// in the guest. No grant or no App makes git fail, not prompt.
const GIT_CREDENTIAL_SCRIPT = `#!/bin/sh
[ "$1" = get ] || exit 0
host=
while IFS='=' read -r k v; do
  [ -z "$k" ] && break
  [ "$k" = host ] && host=$v
done
[ "$host" = github.com ] || exit 0
set -a; . ${SANDBOX_ENV}; set +a
[ -n "\${ABRA_KEY:-}" ] || exit 0
tok=$(curl -fsS -X POST "http://\${ABRA_HOST:-10.0.2.2}:7331/github/token" -H "Authorization: Bearer \${ABRA_KEY}" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).token||"")}catch{}})')
[ -n "$tok" ] || exit 0
printf 'username=x-access-token\\npassword=%s\\n' "$tok"
`;

function gitSystemConfig() {
  const name = envOr("GOTCHIBOT_VM_GIT_NAME", "GotchiBot VM");
  const email = envOr("GOTCHIBOT_VM_GIT_EMAIL", "gotchibot-vm@users.noreply.github.com");
  return `[credential "https://github.com"]
\thelper = ${GIT_CREDENTIAL_HELPER}
[user]
\tname = ${name}
\temail = ${email}
`;
}

const IMAGE = envOr("GOTCHIBOT_VM_IMAGE", "debian-12-genericcloud-amd64.qcow2");
const BASE = `${CACHE}/${IMAGE}`;
const PREPARED = `${CACHE}/gotchibot-sandbox.qcow2`;
const PREPARED_PART = `${PREPARED}.part`;
const PREPARED_META = `${CACHE}/gotchibot-sandbox.json`;
const BUILD_DIR = `${CACHE}/build`;
const BUILD_ID = "__build__";
const FAILED_SERIAL = `${CACHE}/build-failed-serial.log`;

const BUILD_LOCK = `${CACHE}/.image-build.lock`;
/** Boot + provision + convert is minutes; anything older than this is a corpse. */
const BUILD_LOCK_STALE_MS = 30 * 60_000;
/** Hard ceiling for provisioning — a wedged apt or installer must not hang the caller. */
const BUILD_TIMEOUT_MS = Number(process.env.GOTCHIBOT_VM_BUILD_TIMEOUT_MS || 20 * 60_000);
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

/**
 * Runs as root in the build guest (piped to `sudo bash -s`). Mirrors
 * docker/sandbox/Dockerfile so a job behaves the same in either backend.
 * No secret ever enters the build guest: the image is shared by every VM.
 * The GOTCHIBOT_* lines are the last thing on stdout; the host parses them.
 */
const PROVISION_SCRIPT = `set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# First boot is still settling (cloud-init may hold apt). Errors here are
# cloud-init's to report, not ours to fail on.
cloud-init status --wait >/dev/null 2>&1 || true

# Same toolchain as the Dockerfile, plus rsync so pushWork/pullWork never need
# the scp fallback.
apt-get -o DPkg::Lock::Timeout=300 update
apt-get -o DPkg::Lock::Timeout=300 install -y --no-install-recommends \\
  git curl ca-certificates build-essential python3 rsync
rm -rf /var/lib/apt/lists/*

# Node 22 from nodejs.org (the Dockerfile's node:22 base), not apt's older
# nodejs. .tar.gz so xz-utils is not needed; sha256 checked BEFORE extracting.
tmp=$(mktemp -d)
curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$tmp/SHASUMS256.txt"
tarball=$(awk '$2 ~ /^node-v[0-9.]+-linux-x64\\.tar\\.gz$/ {print $2; exit}' "$tmp/SHASUMS256.txt")
want=$(awk -v f="$tarball" '$2 == f {print $1}' "$tmp/SHASUMS256.txt")
if [ -z "$tarball" ] || [ -z "$want" ]; then
  echo "[provision] no node linux-x64 .tar.gz in SHASUMS256.txt" >&2
  exit 1
fi
curl -fsSL "https://nodejs.org/dist/latest-v22.x/$tarball" -o "$tmp/$tarball"
got=$(sha256sum "$tmp/$tarball" | awk '{print $1}')
if [ "$want" != "$got" ]; then
  echo "[provision] node checksum mismatch for $tarball" >&2
  exit 1
fi
tar -xzf "$tmp/$tarball" -C /usr/local --strip-components=1
rm -rf "$tmp"
node --version >&2

# Same installer as the Dockerfile. Installed, not symlinked: a link into
# /root is unreadable by the unprivileged gotchi user.
curl -fsSL https://opencode.ai/install | HOME=/root bash
install -m 0755 /root/.opencode/bin/opencode /usr/local/bin/opencode
sudo -u ${GUEST_USER} -H opencode --version >&2

# Same helper as the Dockerfile with one difference: the default host is
# 10.0.2.2, QEMU user-mode NAT's gateway to the host, not Docker's
# host.docker.internal alias (which does not exist in a VM).
printf '%s\\n' \\
  '#!/bin/sh' \\
  'set -e' \\
  'if [ -z "\${ABRA_KEY:-}" ]; then echo "ABRA_KEY missing — secrets unavailable in sandbox" >&2; exit 2; fi' \\
  'HOST="\${ABRA_HOST:-10.0.2.2}"' \\
  'curl -fsS -X POST "http://\${HOST}:7331/secret" \\' \\
  '  -H "Authorization: Bearer \${ABRA_KEY}" \\' \\
  '  -H "Content-Type: application/json" \\' \\
  '  -d "{\\"project\\":\\"\${ABRA_PROJECT:-gotchibot}\\",\\"keys\\":$1}"' \\
  > /usr/local/bin/sandbox-abra-fetch
chmod 0755 /usr/local/bin/sandbox-abra-fetch

install -d -o ${GUEST_USER} -g ${GUEST_USER} /work /session

printf 'GOTCHIBOT_NODE=%s\\n' "$(node --version)"
printf 'GOTCHIBOT_OPENCODE=%s\\n' "$(opencode --version)"
printf 'GOTCHIBOT_DEBIAN_IMAGE=%s\\n' ${shq(IMAGE)}

# Every VM made from this image must be a fresh identity: cloud-init re-runs on
# its first boot with that VM's hostname, user key and new SSH host keys.
# /etc/machine-id must exist and be empty: systemd treats that as first boot.
# Missing (what bookworm's "cloud-init clean --machine-id" leaves) on a
# read-only early /etc means the guest never finishes booting.
cloud-init clean --logs >&2
: > /etc/machine-id
apt-get clean
rm -rf /var/lib/apt/lists/*
echo "[provision] done — powering off" >&2
# Delayed so this ssh session exits 0 with all of stdout before sshd goes down.
systemd-run --quiet --on-active=3 /usr/bin/systemctl poweroff
`;

function usage() {
  console.error(`usage:
  gotchibot-vm.mjs ensure-image [--rebuild]
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
// A hostname may not contain "_" and the build id has two. Real session ids are
// already hostname-safe, so this is a no-op for them: gbvm-__build__ → gbvm-build.
const guestHost = (id) => vmName(id).replace(/_/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "");
const vmDir = (id) => `${VMS}/${safeId(id)}`;
// The build guest lives outside vms/ so status and the one-VM scan never see
// it as a job, but every id-keyed helper still works for it.
function stateDir(id) {
  return id === BUILD_ID ? BUILD_DIR : vmDir(id);
}
const workDir = (id) => `${stateDir(id)}/work`;
const metaPath = (id) => `${stateDir(id)}/meta.json`;
const pidPath = (id) => `${stateDir(id)}/qemu.pid`;
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

/** The plain Debian base. Only the image build backs onto it; VMs never do. */
function fetchBaseImage() {
  mkdirSync(CACHE, { recursive: true });
  // The base was verified when it was downloaded and has been read-only since;
  // re-hashing ~400 MB on every build buys nothing.
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
    throw new Error(`checksum mismatch for ${IMAGE} (${want ? "hash differs" : "not listed in SHA512SUMS"})`);
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
    `UserKnownHostsFile=${stateDir(id)}/known_hosts`,
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
  // Thrown, not exit(): an image build must get to failBuild and clean up.
  throw new Error(`no free SSH port in 127.0.0.1:${VM_PORT}-${VM_PORT + PORT_SEARCH - 1}`);
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

/**
 * Copy a guest dir back over SSH. rsync when both ends have it, scp otherwise.
 * `replace` lets the scp path swap `dest` out wholesale; without it the copy is
 * merged in, so host files the guest never had survive.
 */
function pullGuest(id, port, remote, dest, what, { replace = false } = {}) {
  if (useRsync(id, port)) {
    console.error(`[vm] pulling ${remote} → ${dest} (rsync)`);
    mkdirSync(dest, { recursive: true });
    const r = spawnSync("rsync", ["-a", "-e", rsyncSsh(id, port), `${GUEST}:${remote}/`, `${dest}/`], {
      stdio: ["ignore", "ignore", "pipe"],
      encoding: "utf8",
    });
    if (r.status !== 0) throw new Error(`rsync pull failed: ${r.stderr}`);
    return;
  }
  console.error(`[vm] pulling ${remote} → ${dest} (scp)`);
  const tmp = `${stateDir(id)}/${what}.pull`;
  rmSync(tmp, { recursive: true, force: true });
  const r = spawnSync("scp", ["-q", "-r", ...sshOpts(id, port, "-P"), `${GUEST}:${remote}`, tmp], {
    stdio: ["ignore", "ignore", "pipe"],
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`scp pull failed: ${r.stderr}`);
  if (replace) {
    rmSync(dest, { recursive: true, force: true });
    renameSync(tmp, dest);
    return;
  }
  mkdirSync(dest, { recursive: true });
  cpSync(tmp, dest, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
}

function pullWork(id, port) {
  pullGuest(id, port, GUEST_WORK, workDir(id), "work", { replace: true });
}

// Never --delete or replace here: sessions/<id>/ holds prompt.txt, state.env,
// runner.sh, output.log — host files the guest knows nothing about.
function pullSession(id, port) {
  pullGuest(id, port, GUEST_SESSION, sessionDir(id), "session");
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

function createOverlay(id, backing) {
  const disk = `${stateDir(id)}/disk.qcow2`;
  if (existsSync(disk)) return disk;
  const r = spawnSync("qemu-img", ["create", "-q", "-f", "qcow2", "-F", "qcow2", "-b", backing, disk, VM_DISK], {
    stdio: "pipe",
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`qemu-img create failed: ${r.stderr}`);
  return disk;
}

function writeSeed(id) {
  const dir = stateDir(id);
  const name = vmName(id);
  const seed = `${dir}/seed.iso`;
  const pub = readFileSync(`${KEY}.pub`, "utf8").trim();
  writeFileSync(
    `${dir}/user-data`,
    `#cloud-config
hostname: ${guestHost(id)}
users:
  - name: ${GUEST_USER}
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - ${pub}
ssh_pwauth: false
`,
  );
  writeFileSync(`${dir}/meta-data`, `instance-id: ${name}\nlocal-hostname: ${guestHost(id)}\n`);
  const r = spawnSync("cloud-localds", [seed, `${dir}/user-data`, `${dir}/meta-data`], { stdio: "pipe", encoding: "utf8" });
  if (r.status !== 0) throw new Error(`cloud-localds failed: ${r.stderr}`);
  return seed;
}

/** vm-phase1-test.sh's flags, verbatim: proven on the 2020 iMac. Jobs and the build share them. */
function bootQemu(id, port) {
  const dir = stateDir(id);
  return spawnSync(
    "qemu-system-x86_64",
    [
      "-name", vmName(id),
      "-machine", "q35,accel=kvm",
      "-cpu", "host",
      "-smp", VM_CPUS,
      "-m", VM_MEMORY_MB,
      "-drive", `file=${dir}/disk.qcow2,if=virtio,format=qcow2`,
      "-drive", `file=${dir}/seed.iso,if=virtio,format=raw,readonly=on`,
      "-netdev", `user,id=n0,hostfwd=tcp:127.0.0.1:${port}-:22`,
      "-device", "virtio-net-pci,netdev=n0",
      "-display", "none",
      "-serial", `file:${dir}/serial.log`,
      "-pidfile", pidPath(id),
      "-daemonize",
    ],
    { stdio: "pipe", encoding: "utf8" },
  );
}

function waitForSsh(id, port) {
  console.error(`[vm] waiting for SSH on 127.0.0.1:${port}`);
  for (let i = 0; i < 60; i++) {
    if (vmSsh(id, port, ["true"]).status === 0) {
      console.error("[vm] SSH ready");
      return true;
    }
    sleep(3000);
  }
  return false;
}

/** Who else is building the prepared image right now, if anyone. */
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

function releaseBuildLock() {
  try {
    if (JSON.parse(readFileSync(BUILD_LOCK, "utf8")).pid === process.pid) rmSync(BUILD_LOCK, { force: true });
  } catch {
    /* best effort */
  }
}

function readProvenance() {
  try {
    return JSON.parse(readFileSync(PREPARED_META, "utf8"));
  } catch {
    return null;
  }
}

const preparedReady = () => existsSync(PREPARED) && statSync(PREPARED).isFile() && statSync(PREPARED).size > 0;

function tail(text, n = 200) {
  return String(text || "").split("\n").slice(-n).join("\n");
}

/**
 * Every failure of a build ends here: no build qemu, no build dir, no partial
 * image, no lock. process.exit skips `finally`, so the lock is released here too.
 * Never throws — it is what runs when something already did.
 */
function failBuild(msg) {
  try {
    stopVm(BUILD_ID);
  } catch {
    /* best effort */
  }
  let kept = false;
  try {
    if (existsSync(`${BUILD_DIR}/serial.log`)) {
      renameSync(`${BUILD_DIR}/serial.log`, FAILED_SERIAL);
      kept = true;
    }
  } catch {
    /* best effort */
  }
  try {
    rmSync(BUILD_DIR, { recursive: true, force: true });
    rmSync(PREPARED_PART, { force: true });
    // A PREPARED without provenance is half-written; one with provenance is a
    // previous good build that a failed --rebuild must not destroy.
    if (existsSync(PREPARED) && !readProvenance()) rmSync(PREPARED, { force: true });
  } catch {
    /* best effort */
  }
  releaseBuildLock();
  console.error(`[vm] image build failed: ${msg}`);
  console.error(kept ? `[vm] see ${FAILED_SERIAL}` : "[vm] no serial log (failed before the build guest booted)");
  process.exit(1);
}

async function buildPrepared() {
  // A build whose caller died (Ctrl-C, killed ssh) leaves a daemonized qemu
  // holding 2 GiB. Its lock is already judged dead; reap the guest too.
  if (!stopVm(BUILD_ID)) throw new Error("an orphaned build qemu survived SIGKILL");
  rmSync(BUILD_DIR, { recursive: true, force: true });
  rmSync(FAILED_SERIAL, { force: true });
  mkdirSync(BUILD_DIR, { recursive: true });

  fetchBaseImage();
  createOverlay(BUILD_ID, BASE);
  writeSeed(BUILD_ID);

  const port = await pickPort(readMeta(BUILD_ID).port);
  // stopVm reads the port from meta to power the guest off cleanly.
  writeMeta(BUILD_ID, { id: BUILD_ID, name: vmName(BUILD_ID), port, status: "building" });
  rmSync(pidPath(BUILD_ID), { force: true });
  let r = bootQemu(BUILD_ID, port);
  if (r.status !== 0) throw new Error(`qemu-system-x86_64 failed: ${r.stderr || r.stdout || `exit ${r.status}`}`);
  console.error(`[vm] booted build guest ${vmName(BUILD_ID)} (pid ${readPid(BUILD_ID)})`);
  if (!waitForSsh(BUILD_ID, port)) throw new Error("SSH not ready after 180s");

  console.error(`[vm] provisioning (apt, node 22, opencode) — minutes, ceiling ${Math.round(BUILD_TIMEOUT_MS / 60000)}m`);
  // Output is captured, not streamed, so the provenance lines can be parsed;
  // apt is chatty, hence the large buffer.
  r = vmSsh(BUILD_ID, port, ["sudo bash -s"], {
    input: PROVISION_SCRIPT,
    timeout: BUILD_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 64 << 20,
  });
  const found = {};
  for (const line of String(r.stdout || "").split("\n")) {
    const m = line.trim().match(/^(GOTCHIBOT_[A-Z_]+)=(.*)$/);
    if (m) found[m[1]] = m[2];
  }
  if (r.status !== 0 || !found.GOTCHIBOT_NODE || !found.GOTCHIBOT_OPENCODE) {
    console.error(`[vm] provision stdout (last 200 lines):\n${tail(r.stdout)}`);
    console.error(`[vm] provision stderr (last 200 lines):\n${tail(r.stderr)}`);
    const why = r.error ? r.error.message : r.status !== 0 ? `exit ${r.status}` : "no GOTCHIBOT_NODE / GOTCHIBOT_OPENCODE lines";
    throw new Error(`provision failed (${why})`);
  }
  console.error(`[vm] provisioned: node ${found.GOTCHIBOT_NODE}, opencode ${found.GOTCHIBOT_OPENCODE}`);

  // The guest powers itself off; converting a disk qemu still writes to would
  // snapshot a half-flushed filesystem.
  for (let i = 0; i < 60 && vmRunning(BUILD_ID); i++) sleep(1000);
  if (!stopVm(BUILD_ID)) throw new Error("build qemu survived SIGKILL");
  console.error("[vm] build guest powered off");

  // Standalone (no backing file): every overlay backs onto this, and the
  // Debian base is not guaranteed to stay around.
  console.error(`[vm] converting to standalone ${PREPARED}`);
  r = spawnSync("qemu-img", ["convert", "-O", "qcow2", `${BUILD_DIR}/disk.qcow2`, PREPARED_PART], {
    stdio: ["ignore", "ignore", "pipe"],
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`qemu-img convert failed: ${r.stderr || `exit ${r.status}`}`);

  // Provenance present ⇔ PREPARED is complete: drop the old record before the
  // swap so a crash in between reads as half-written, not as the old build.
  rmSync(PREPARED_META, { force: true });
  renameSync(PREPARED_PART, PREPARED);
  // Every overlay backs onto this file; a write here corrupts all of them.
  chmodSync(PREPARED, statSync(PREPARED).mode & ~0o222);
  const prov = {
    builtAt: new Date().toISOString(),
    debianImage: found.GOTCHIBOT_DEBIAN_IMAGE || IMAGE,
    nodeVersion: found.GOTCHIBOT_NODE,
    opencodeVersion: found.GOTCHIBOT_OPENCODE,
    base: BASE,
  };
  writeFileSync(PREPARED_META, `${JSON.stringify(prov, null, 2)}\n`);
  rmSync(BUILD_DIR, { recursive: true, force: true });
  console.error(`[vm] prepared image ready: ${PREPARED} (node ${prov.nodeVersion}, opencode ${prov.opencodeVersion})`);
}

async function cmdEnsureImage({ rebuild = false } = {}) {
  requireKvm();
  mkdirSync(CACHE, { recursive: true });
  if (!rebuild && preparedReady()) {
    const p = readProvenance();
    console.error(
      `[vm] prepared image ready: ${PREPARED}` +
        (p ? ` (built ${p.builtAt}, node ${p.nodeVersion}, opencode ${p.opencodeVersion})` : ""),
    );
    return;
  }

  // Two builds share ~/.cache/gotchibot-vm/build and would destroy each other.
  const held = readBuildLock();
  if (held) {
    console.error(`[vm] another image build is already running (pid ${held.pid}, started ${held.at}) — wait for it instead of racing`);
    process.exit(4);
  }
  // The build guest is a 2 GiB VM like any other: the one-VM rule applies.
  const other = runningOther(BUILD_ID);
  if (other) {
    console.error(
      `[vm] refusing: ${vmName(other.id)} is already running (pid ${other.pid}) — only one VM fits in the 2020 iMac's RAM. ` +
        `Stop it first: node scripts/gotchibot-vm.mjs rm ${other.id}`,
    );
    process.exit(4);
  }
  // A stopped VM's overlay backs onto the image this build replaces; booting
  // it afterwards would read a different disk underneath its own blocks.
  const leftover = existsSync(VMS) ? readdirSync(VMS).filter((d) => existsSync(`${VMS}/${d}/disk.qcow2`)) : [];
  if (leftover.length) {
    console.error(
      `[vm] refusing: leftover VM disk(s) would back onto the image this build replaces: ${leftover.join(", ")} — ` +
        `remove them first: node scripts/gotchibot-vm.mjs rm <id> [--purge]`,
    );
    process.exit(4);
  }

  try {
    rmSync(BUILD_LOCK, { force: true }); // any existing lock was judged stale above
    writeFileSync(BUILD_LOCK, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() }, null, 2)}\n`, {
      flag: "wx",
    });
  } catch {
    console.error("[vm] another image build took the lock just now — wait for it instead of racing");
    process.exit(4);
  }

  try {
    await buildPrepared();
  } catch (e) {
    failBuild(e?.message || String(e));
  } finally {
    releaseBuildLock();
  }
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
  const dir = stateDir(sid);

  const other = runningOther(sid);
  if (other) {
    console.error(
      `[vm] refusing: ${vmName(other.id)} is already running (pid ${other.pid}) — only one VM fits in the 2020 iMac's RAM. ` +
        `Stop it first: node scripts/gotchibot-vm.mjs rm ${other.id}`,
    );
    process.exit(4);
  }
  // A build guest is a 2 GiB VM too. Two guests make the host swap.
  if (vmRunning(BUILD_ID)) {
    console.error(`[vm] refusing: an image build guest (${vmName(BUILD_ID)}) is running — wait for ensure-image to finish`);
    process.exit(4);
  }
  if (vmRunning(sid)) {
    printUp({ ...readMeta(sid), id: sid, name, status: "running" }, json);
    return;
  }

  // A spawn must fail fast; the build takes minutes and belongs to ensure-image.
  if (!preparedReady()) {
    console.error("no prepared image — run: node scripts/gotchibot-vm.mjs ensure-image");
    process.exit(3);
  }

  const work = workDir(sid);
  const sess = sessionDir(sid);
  mkdirSync(work, { recursive: true });
  mkdirSync(sess, { recursive: true });

  const disk = createOverlay(sid, PREPARED);
  const seed = writeSeed(sid);

  const port = await pickPort(readMeta(sid).port);
  rmSync(pidPath(sid), { force: true });
  const r = bootQemu(sid, port);
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout || "qemu-system-x86_64 failed");
    process.exit(r.status ?? 1);
  }
  console.error(`[vm] booted ${name} (pid ${readPid(sid)})`);

  if (!waitForSsh(sid, port)) {
    console.error(`[vm] SSH not ready after 180s; see ${dir}/serial.log`);
    process.exit(1);
  }

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
  let env = "GOTCHIBOT_SANDBOX=1\nGOTCHIBOT_SKIP_ABRA=1\nABRA_HOST=10.0.2.2\nGIT_TERMINAL_PROMPT=0\n";
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
  guestWrite(sid, port, GIT_CREDENTIAL_HELPER, GIT_CREDENTIAL_SCRIPT, { owner: "root:root", mode: "0755" });
  guestWrite(sid, port, "/etc/gitconfig", gitSystemConfig(), { owner: "root:root", mode: "0644" });
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
    image: PREPARED,
    baseImage: BASE,
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
  if (vmRunning(sid) && port) {
    pullWork(sid, port);
    pullSession(sid, port);
  } else if (existsSync(work)) console.error(`[vm] ${vmName(sid)} not running — promoting the last copy in ${work}`);
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

/**
 * vm-phase1-test.sh cmd_down, plus a SIGKILL so no qemu is ever left behind.
 * Returns false (never exits) when the pid survives, so a build can clean up.
 */
function stopVm(sid) {
  const pid = readPid(sid);
  if (!pidAlive(pid)) return true;
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
    return false;
  }
  console.error(`[vm] stopped ${vmName(sid)} (pid ${pid} gone)`);
  return true;
}

function cmdRm(id, { purge = false } = {}) {
  const sid = safeId(id);
  const dir = vmDir(sid);
  // Pull before stopping so the job's output survives the VM the way it
  // survives the Docker bind mount. --purge is throwing the work away anyway.
  const port = readMeta(sid).port;
  if (!purge && port && vmRunning(sid)) {
    for (const [pull, remote] of [
      [pullWork, GUEST_WORK],
      [pullSession, GUEST_SESSION],
    ]) {
      try {
        pull(sid, port);
      } catch (e) {
        throw new Error(`${e.message} — ${vmName(sid)} left running so its ${remote} is not lost (rm --purge discards it)`);
      }
    }
  }
  if (!stopVm(sid)) process.exit(1);
  // Neither the prepared image nor the Debian base in ~/.cache/gotchibot-vm is
  // ever touched: every VM's overlay backs onto the first, the next build onto the second.
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
  if (rest[0] === BUILD_ID) {
    console.error(`${BUILD_ID} is reserved for the ensure-image build guest`);
    process.exit(2);
  }

  if (cmd === "ensure-image") {
    await cmdEnsureImage({ rebuild: rest.includes("--rebuild") });
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
