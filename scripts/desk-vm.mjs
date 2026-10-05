#!/usr/bin/env node
/**
 * GotchiBot desk VM — a sandbox VM on a powerful desk (Mac), so heavy sandbox
 * work runs on the desk's CPU instead of the Hub's. The Lima/vz twin of
 * gotchibot-vm.mjs (QEMU/KVM on the Hub): same verbs, so opencode-dispatch can
 * swap backends.
 *
 *   node scripts/desk-vm.mjs check [--json]          does this desk qualify? (floor: config/desk-vm.json)
 *   node scripts/desk-vm.mjs enable | disable        owner opt-in (sessions/.desk-vm.json)
 *   node scripts/desk-vm.mjs available [--json]      exit 0 when sandbox jobs may use it
 *   node scripts/desk-vm.mjs ensure-image [--rebuild]  create + provision the guest (run by UserDefault)
 *   node scripts/desk-vm.mjs up <id> [--json]
 *   node scripts/desk-vm.mjs exec <id> -- <cmd...>
 *   node scripts/desk-vm.mjs detach <id>
 *   node scripts/desk-vm.mjs status [id]
 *   node scripts/desk-vm.mjs models <id> [--check <model>] [--json]
 *   node scripts/desk-vm.mjs promote <id> <destDir>
 *   node scripts/desk-vm.mjs rm <id> [--purge]        `rm shared` stops the guest; --purge deletes it
 *
 * Sandbox mode (the pink Tab) on an enabled desk runs inside the guest:
 *   node scripts/desk-vm.mjs mode-up [--project DIR] [--fresh] [--json]
 *        seed /jobs/mode/work from the project once (secrets, sessions/, node_modules
 *        left out), commit a baseline in the guest, start `opencode serve` there;
 *        the chat pane attaches to it (port forwarded to the desk's 127.0.0.1 only)
 *   node scripts/desk-vm.mjs mode-promote [--project DIR] [--yes]
 *        patch of everything changed since the baseline; applied to the project
 *        only with --yes, then the baseline moves forward
 *   node scripts/desk-vm.mjs mode-down                  stop the guest's opencode server
 *
 * A desk qualifies when it is Apple Silicon macOS 13+, has limactl, and meets
 * the floor (default 12 cores / 32 GB). It is offered only when it qualifies AND
 * its owner ran `enable`. GOTCHIBOT_DESK_VM_FORCE=1 skips the floor for testing
 * on a small Mac (2 vCPU / 2 GiB guest).
 *
 * One guest (Lima instance gbdesk, vmType vz). Jobs attach to it; each job gets
 * /jobs/<id>/work and /jobs/<id>/session, so several jobs can share the guest.
 * Isolation: no host mounts (Lima's default home mount is not used), no port
 * forwards, no ssh-agent forwarding, no host ssh keys. Jobs run as the
 * unprivileged `gotchi` user. Secrets reach the guest only via the forwarded
 * env file (0600, piped over stdin) and abra serve on the desk's loopback
 * (host.lima.internal:7331). Design: docs/GOTCHIBOT-DESK-VM.md.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { cpus, freemem, homedir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const INSTANCE = "gbdesk";
export const SHARED_GUEST_ID = "shared";
const GUEST_USER = "gotchi";
const SANDBOX_ENV = "/etc/gotchibot/sandbox.env";
const GIT_CREDENTIAL_HELPER = "/usr/local/bin/git-credential-gotchibot";
const ABRA_HOST = "host.lima.internal";
const CACHE = join(homedir(), ".cache", "gotchibot-desk-vm");
export const MODE_ID = "mode";
export const GUEST_SERVE_PORT = 4097;
const BASELINE_TAG = "gotchibot-baseline";

export const DEFAULT_FLOOR = {
  minCores: 12,
  minMemGB: 32,
  cpuShare: 0.5,
  maxCpus: 8,
  memShare: 0.25,
  maxMemGB: 16,
  diskGB: 40,
  modePort: 41097,
};

/**
 * Never copied into the guest when sandbox mode seeds it from a project:
 * credentials (.env*, keys, sessions/ with the Hub desk token), bulk, and other
 * sandboxes' state. bsdtar --exclude patterns (match at any depth).
 */
export const SEED_EXCLUDES = ["node_modules", "sessions", "desk-vms", "vms", "sandboxes", ".env", ".env.*", "*.pem", "*.key", ".abra", ".DS_Store"];

const FORWARD_ENV = [
  "NVIDIA_API_KEY",
  "NVIDIA_API_KEY_GLM_5_3",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENCODE_API_KEY",
  "OPENCODE_ZEN_API_KEY",
  "AARCADE_GOTCHIBOT_SERVICE_SECRET",
  "GOTCHIBOT_OWNER",
  "ABRA_KEY",
  "ABRA_PROJECT",
];

// ── paths ─────────────────────────────────────────────────────────────────

export function safeId(id) {
  const s = String(id || "").replace(/[^a-zA-Z0-9._-]/g, "");
  if (!s || s === "." || s === "..") throw new Error("invalid sessionId");
  return s;
}

/** Where a job lives inside the guest. */
export function guestPaths(id) {
  const sid = safeId(id);
  return { root: `/jobs/${sid}`, work: `/jobs/${sid}/work`, session: `/jobs/${sid}/session` };
}

const stateDir = (root, id) => join(root, "desk-vms", safeId(id));
const workDir = (root, id) => join(stateDir(root, id), "work");
const metaPath = (root, id) => join(stateDir(root, id), "meta.json");
const sessionDir = (root, id) => join(root, "sessions", safeId(id));
const optInPath = (root) => join(root, "sessions", ".desk-vm.json");

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

// ── qualify ───────────────────────────────────────────────────────────────

export function readFloor(root = ROOT) {
  return { ...DEFAULT_FLOOR, ...(readJson(join(root, "config", "desk-vm.json"), {}) || {}) };
}

function hasLimactl() {
  const r = spawnSync("limactl", ["--version"], { encoding: "utf8", timeout: 10_000 });
  return r.status === 0 ? (r.stdout || "").trim() : null;
}

/** macOS major version (sw_vers; the Darwin→macOS mapping jumped at macOS 26). */
function macosMajor() {
  const r = spawnSync("sw_vers", ["-productVersion"], { encoding: "utf8", timeout: 5000 });
  const major = Number(String(r.stdout || "").split(".")[0]);
  return Number.isFinite(major) && major > 0 ? major : null;
}

export function deskSpecs() {
  return {
    platform: process.platform,
    arch: process.arch,
    cores: cpus().length,
    memGB: Math.round(totalmem() / 2 ** 30),
    freeGB: Math.round(freemem() / 2 ** 30),
    macos: process.platform === "darwin" ? macosMajor() : null,
    limactl: hasLimactl(),
  };
}

/** Does this desk qualify? Pure. */
export function qualify(specs, floor = DEFAULT_FLOOR, { force = false } = {}) {
  const reasons = [];
  if (specs.platform !== "darwin") reasons.push("desk VMs need macOS (the Hub uses gotchibot-vm)");
  else {
    if (specs.arch !== "arm64") reasons.push("needs Apple Silicon (vz)");
    if (specs.macos != null && specs.macos < 13) reasons.push(`needs macOS 13+ (have ${specs.macos})`);
  }
  if (!specs.limactl) reasons.push("limactl not installed (UserDefault: brew install lima)");
  if (!force) {
    if (specs.cores < floor.minCores) reasons.push(`${specs.cores} cores < ${floor.minCores}`);
    if (specs.memGB < floor.minMemGB) reasons.push(`${specs.memGB} GB RAM < ${floor.minMemGB}`);
  }
  return { ok: reasons.length === 0, reasons };
}

/** Guest size: a share of the machine, capped, leaving the desk headroom. Pure. */
export function vmSize(specs, floor = DEFAULT_FLOOR, { force = false } = {}) {
  if (force && (specs.cores < floor.minCores || specs.memGB < floor.minMemGB)) return { cpus: 2, memGB: 2, diskGB: 20 };
  return {
    cpus: Math.max(2, Math.min(floor.maxCpus, Math.floor(specs.cores * floor.cpuShare))),
    memGB: Math.max(2, Math.min(floor.maxMemGB, Math.floor(specs.memGB * floor.memShare))),
    diskGB: floor.diskGB,
  };
}

export function readOptIn(root = ROOT) {
  return readJson(optInPath(root), null);
}

function forced(env = process.env) {
  return env.GOTCHIBOT_DESK_VM_FORCE === "1";
}

/**
 * May sandbox jobs use the desk VM right now? Qualified + enabled + guest
 * created (ensure-image). `instanceExists` is injectable for tests.
 */
export function available({ root = ROOT, specs = deskSpecs(), env = process.env, instanceExists = () => limaInstance() != null } = {}) {
  const force = forced(env);
  const q = qualify(specs, readFloor(root), { force });
  if (!q.ok) return { ok: false, reason: q.reasons.join("; ") };
  if (!readOptIn(root)?.enabled) return { ok: false, reason: "not enabled on this desk (gotchibot desk-vm enable)" };
  if (!instanceExists()) return { ok: false, reason: "guest not created (gotchibot desk-vm ensure-image)" };
  return { ok: true, reason: force ? "forced (GOTCHIBOT_DESK_VM_FORCE=1)" : "qualified + enabled" };
}

/**
 * GOTCHIBOT_SANDBOX_BACKEND=auto → desk-vm when available, else docker. Never
 * the Hub VM: that is only ever chosen explicitly (`vm`). Pure.
 */
export function resolveBackend(want, avail) {
  const w = String(want || "auto").toLowerCase();
  if (w !== "auto") return { backend: w, fallback: null };
  if (avail.ok) return { backend: "desk-vm", fallback: null };
  return { backend: "docker", fallback: `desk VM unavailable: ${avail.reason}` };
}

// ── guest definition ──────────────────────────────────────────────────────

/** Runs as root on every boot (Lima system provision); a marker makes repeats no-ops. */
export const PROVISION_SCRIPT = `#!/bin/bash
set -euo pipefail
[ -f /etc/gotchibot/provisioned ] && exit 0
export DEBIAN_FRONTEND=noninteractive
apt-get -o DPkg::Lock::Timeout=300 update
apt-get -o DPkg::Lock::Timeout=300 install -y --no-install-recommends git curl ca-certificates build-essential python3 rsync
rm -rf /var/lib/apt/lists/*

# Node 22 (linux-arm64) from nodejs.org, sha256 checked before extracting.
tmp=$(mktemp -d)
curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$tmp/SHASUMS256.txt"
tarball=$(awk '$2 ~ /^node-v[0-9.]+-linux-arm64\\.tar\\.gz$/ {print $2; exit}' "$tmp/SHASUMS256.txt")
want=$(awk -v f="$tarball" '$2 == f {print $1}' "$tmp/SHASUMS256.txt")
[ -n "$tarball" ] && [ -n "$want" ] || { echo "[provision] no node linux-arm64 tarball" >&2; exit 1; }
curl -fsSL "https://nodejs.org/dist/latest-v22.x/$tarball" -o "$tmp/$tarball"
[ "$(sha256sum "$tmp/$tarball" | awk '{print $1}')" = "$want" ] || { echo "[provision] node checksum mismatch" >&2; exit 1; }
tar -xzf "$tmp/$tarball" -C /usr/local --strip-components=1
rm -rf "$tmp"

curl -fsSL https://opencode.ai/install | HOME=/root bash
install -m 0755 /root/.opencode/bin/opencode /usr/local/bin/opencode

# The unprivileged job user: no sudo, no ssh login.
id ${GUEST_USER} >/dev/null 2>&1 || useradd -m -s /bin/bash ${GUEST_USER}

printf '%s\\n' \\
  '#!/bin/sh' \\
  'set -e' \\
  'if [ -z "\${ABRA_KEY:-}" ]; then echo "ABRA_KEY missing — secrets unavailable in sandbox" >&2; exit 2; fi' \\
  'HOST="\${ABRA_HOST:-${ABRA_HOST}}"' \\
  'curl -fsS -X POST "http://\${HOST}:7331/secret" \\' \\
  '  -H "Authorization: Bearer \${ABRA_KEY}" \\' \\
  '  -H "Content-Type: application/json" \\' \\
  '  -d "{\\"project\\":\\"\${ABRA_PROJECT:-gotchibot}\\",\\"keys\\":$1}"' \\
  > /usr/local/bin/sandbox-abra-fetch
chmod 0755 /usr/local/bin/sandbox-abra-fetch

install -d -m 0755 /etc/gotchibot /rules
install -d -o ${GUEST_USER} -g ${GUEST_USER} -m 0750 /jobs
printf 'node=%s\\nopencode=%s\\nat=%s\\n' "$(node --version)" "$(opencode --version)" "$(date -u +%FT%TZ)" > /etc/gotchibot/provisioned
`;

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
tok=$(curl -fsS -X POST "http://\${ABRA_HOST:-${ABRA_HOST}}:7331/github/token" -H "Authorization: Bearer \${ABRA_KEY}" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).token||"")}catch{}})')
[ -n "$tok" ] || exit 0
printf 'username=x-access-token\\npassword=%s\\n' "$tok"
`;

function gitSystemConfig() {
  const name = process.env.GOTCHIBOT_VM_GIT_NAME || "GotchiBot Desk VM";
  const email = process.env.GOTCHIBOT_VM_GIT_EMAIL || "gotchibot-vm@users.noreply.github.com";
  return `[credential "https://github.com"]\n\thelper = ${GIT_CREDENTIAL_HELPER}\n[user]\n\tname = ${name}\n\temail = ${email}\n`;
}

function indent(text, n) {
  const pad = " ".repeat(n);
  return text
    .split("\n")
    .map((l) => (l ? pad + l : l))
    .join("\n");
}

/**
 * Lima instance config. Based on the Debian 12 image template only — NOT
 * template:debian-12, which adds Lima's default home-directory mount. Pure.
 */
export function limaConfig({ cpus: c, memGB, diskGB, modePort = DEFAULT_FLOOR.modePort }) {
  return `# GotchiBot desk VM (generated by scripts/desk-vm.mjs — do not edit)
minimumLimaVersion: 2.0.0
base:
- template:_images/debian-12
vmType: vz
cpus: ${c}
memory: "${memGB}GiB"
disk: "${diskGB}GiB"
mounts: []
containerd:
  system: false
  user: false
ssh:
  localPort: 0
  loadDotSSHPubKeys: false
  forwardAgent: false
  forwardX11: false
portForwards:
# Only the sandbox-mode opencode server, to the desk's loopback (first match wins).
- guestIP: "127.0.0.1"
  guestPort: ${GUEST_SERVE_PORT}
  hostIP: "127.0.0.1"
  hostPort: ${modePort}
- guestIP: "127.0.0.1"
  guestPortRange: [1, 65535]
  proto: any
  ignore: true
- guestIP: "0.0.0.0"
  guestPortRange: [1, 65535]
  proto: any
  ignore: true
provision:
- mode: system
  script: |
${indent(PROVISION_SCRIPT, 4)}
`;
}

// ── lima ──────────────────────────────────────────────────────────────────

function lima(args, opts = {}) {
  return spawnSync("limactl", args, { encoding: "utf8", maxBuffer: 64 * 2 ** 20, ...opts });
}

/** { name, status, cpus, memory, … } for gbdesk, or null. */
export function limaInstance() {
  const r = lima(["list", "--json", INSTANCE], { timeout: 20_000 });
  if (r.status !== 0) return null;
  const line = String(r.stdout || "")
    .split("\n")
    .find((l) => l.trim().startsWith("{"));
  try {
    return line ? JSON.parse(line) : null;
  } catch {
    return null;
  }
}

const running = () => limaInstance()?.status === "Running";

/** Run argv in the guest as root (argv is shell-quoted by limactl shell). */
function guestRoot(argv, opts = {}) {
  return lima(["shell", "--workdir", "/", INSTANCE, "sudo", ...argv], opts);
}

function mustGuest(argv, what, opts = {}) {
  const r = guestRoot(argv, opts);
  if (r.status !== 0) throw new Error(`${what} failed: ${String(r.stderr || r.stdout || "").trim().split("\n").pop()}`);
  return r;
}

/** Write a file in the guest from stdin (never argv: secrets stay off process lists). */
function guestWrite(path, content, { owner = "root:root", mode = "0644" } = {}) {
  const [user, group] = owner.split(":");
  mustGuest(["install", "-o", user, "-g", group, "-m", mode, "/dev/stdin", path], `write ${path}`, { input: content });
}

function tarIn(hostDir, guestDir, excludes = []) {
  const tar = spawnSync("tar", [...excludes.flatMap((x) => ["--exclude", x]), "-C", hostDir, "-cf", "-", "."], { maxBuffer: 2 ** 31 - 1 });
  if (tar.status !== 0) throw new Error(`tar ${hostDir} failed`);
  mustGuest(["-u", GUEST_USER, "tar", "-C", guestDir, "-xf", "-"], `copy into ${guestDir}`, { input: tar.stdout, encoding: "buffer" });
}

function tarOut(guestDir, hostDir) {
  const r = guestRoot(["-u", GUEST_USER, "tar", "-C", guestDir, "-cf", "-", "."], { encoding: "buffer" });
  if (r.status !== 0) throw new Error(`copy out of ${guestDir} failed`);
  mkdirSync(hostDir, { recursive: true });
  const x = spawnSync("tar", ["-C", hostDir, "-xf", "-"], { input: r.stdout });
  if (x.status !== 0) throw new Error(`untar into ${hostDir} failed`);
}

function envLine(k, v) {
  return `${k}='${String(v).replace(/'/g, "'\\''")}'\n`;
}

/** The job's command line in the guest: forwarded env, its own /work, as gotchi. */
export function guestCommand(id, args) {
  const p = guestPaths(id);
  const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  return ["-u", GUEST_USER, "-H", "bash", "-c", `set -a; . ${SANDBOX_ENV}; set +a; cd ${p.work}; exec ${args.map(q).join(" ")}`];
}

// ── verbs ─────────────────────────────────────────────────────────────────

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function cmdCheck({ json }) {
  const specs = deskSpecs();
  const floor = readFloor();
  const force = forced();
  const q = qualify(specs, floor, { force });
  const out = { qualified: q.ok, reasons: q.reasons, enabled: Boolean(readOptIn()?.enabled), forced: force, specs, floor, size: vmSize(specs, floor, { force }), guest: limaInstance()?.status || "not created" };
  if (json) return console.log(JSON.stringify(out, null, 2));
  console.log(`desk     ${specs.cores} cores · ${specs.memGB} GB RAM · ${specs.arch} · macOS ${specs.macos ?? "—"} · ${specs.limactl || "no limactl"}`);
  console.log(`floor    ${floor.minCores} cores · ${floor.minMemGB} GB (config/desk-vm.json)`);
  console.log(`verdict  ${q.ok ? "qualifies" : `does not qualify — ${q.reasons.join("; ")}`}${force ? " (forced)" : ""}`);
  console.log(`guest    ${q.ok ? "" : "would be "}${out.size.cpus} vCPU · ${out.size.memGB} GiB · ${out.size.diskGB} GiB disk · ${out.guest}`);
  console.log(`enabled  ${out.enabled ? "yes" : "no (gotchibot desk-vm enable)"}`);
}

function cmdEnable(on) {
  if (on) {
    const q = qualify(deskSpecs(), readFloor(), { force: forced() });
    if (!q.ok) die(`this desk does not qualify: ${q.reasons.join("; ")}`);
  }
  mkdirSync(join(ROOT, "sessions"), { recursive: true });
  writeFileSync(optInPath(ROOT), `${JSON.stringify({ enabled: on, at: new Date().toISOString(), ...(forced() ? { forced: true } : {}) }, null, 2)}\n`);
  console.log(on ? "desk VM enabled — sandbox jobs on this desk use it once the guest exists (gotchibot desk-vm ensure-image)" : "desk VM disabled — sandbox jobs fall back to Docker");
}

function cmdEnsureImage({ rebuild }) {
  const specs = deskSpecs();
  const floor = readFloor();
  const force = forced();
  const q = qualify(specs, floor, { force });
  if (!q.ok) die(`this desk does not qualify: ${q.reasons.join("; ")}`);
  const inst = limaInstance();
  if (inst && rebuild) {
    console.error(`[desk-vm] deleting ${INSTANCE} for a rebuild`);
    lima(["delete", "--force", INSTANCE], { stdio: "inherit" });
  } else if (inst) {
    console.log(`${INSTANCE} exists (${inst.status}) — --rebuild to recreate`);
    return;
  }
  mkdirSync(CACHE, { recursive: true });
  const yaml = join(CACHE, `${INSTANCE}.yaml`);
  writeFileSync(yaml, limaConfig({ ...vmSize(specs, floor, { force }), modePort: floor.modePort }));
  const v = lima(["template", "validate", yaml]);
  if (v.status !== 0) die(`lima config invalid: ${(v.stderr || v.stdout).trim()}`);
  console.error(`[desk-vm] creating ${INSTANCE} (first boot downloads Debian 12 and provisions node + opencode; ~5–10 min)`);
  let r = lima(["create", "--tty=false", `--name=${INSTANCE}`, yaml], { stdio: "inherit" });
  if (r.status !== 0) die("limactl create failed");
  r = lima(["start", "--tty=false", "--timeout=30m", INSTANCE], { stdio: "inherit" });
  if (r.status !== 0) die(`limactl start failed — logs: ~/.lima/${INSTANCE}/`);
  const p = guestRoot(["cat", "/etc/gotchibot/provisioned"]);
  if (p.status !== 0) die("provisioning did not finish (no /etc/gotchibot/provisioned) — limactl shell gbdesk sudo journalctl -u lima-guestagent");
  console.log(`${INSTANCE} ready\n${p.stdout.trim()}`);
}

function writeMeta(id, meta) {
  mkdirSync(stateDir(ROOT, id), { recursive: true });
  writeFileSync(metaPath(ROOT, id), `${JSON.stringify(meta, null, 2)}\n`);
}

function ensureRunning() {
  const a = available();
  if (!a.ok) die(`desk VM not available: ${a.reason}`, 3);
  if (!running()) {
    console.error(`[desk-vm] starting ${INSTANCE}`);
    const r = lima(["start", "--tty=false", "--timeout=10m", INSTANCE], { stdio: ["ignore", "ignore", "inherit"] });
    if (r.status !== 0) die(`limactl start ${INSTANCE} failed`);
  }
}

const guestHas = (path) => guestRoot(["test", "-e", path]).status === 0;

/**
 * Attach a job to the guest: its dirs, /work seeded (from desk-vms/<id>/work, or
 * `seed` = { dir, excludes } — only when the job is new unless fresh), rules,
 * forwarded env. Returns the job meta.
 */
function attachJob(sid, { seed = null, fresh = false } = {}) {
  ensureRunning();
  const p = guestPaths(sid);
  mkdirSync(workDir(ROOT, sid), { recursive: true });
  mkdirSync(sessionDir(ROOT, sid), { recursive: true });
  const existed = guestHas(p.work);
  if (fresh && existed) guestRoot(["rm", "-rf", "--", p.root]);
  mustGuest(["install", "-d", "-o", GUEST_USER, "-g", GUEST_USER, "-m", "0750", p.root, p.work, p.session], "make job dirs");
  const seeded = !existed || fresh;
  if (!seed) tarIn(workDir(ROOT, sid), p.work);
  else if (seeded) tarIn(seed.dir, p.work, seed.excludes || []);
  for (const [src, dst] of [
    [join(ROOT, "AGENTS.md"), "/rules/AGENTS.md"],
    [join(ROOT, "skills", "registry.json"), "/rules/skills-registry.json"],
  ]) {
    if (existsSync(src)) guestWrite(dst, readFileSync(src), { mode: "0444" });
  }
  let env = `GOTCHIBOT_SANDBOX=1\nGOTCHIBOT_SKIP_ABRA=1\nABRA_HOST=${ABRA_HOST}\nGIT_TERMINAL_PROMPT=0\n`;
  const forwarded = [];
  const abraKey = process.env.ABRA_KEY || process.env.GOTCHIBOT_SANDBOX_ABRA_KEY || "";
  if (abraKey) {
    env += envLine("ABRA_KEY", abraKey);
    forwarded.push("ABRA_KEY");
  }
  for (const k of FORWARD_ENV) {
    if (k === "ABRA_KEY" || !process.env[k]) continue;
    env += envLine(k, process.env[k]);
    forwarded.push(k);
  }
  guestWrite(SANDBOX_ENV, env, { owner: `${GUEST_USER}:${GUEST_USER}`, mode: "0600" });
  guestWrite(GIT_CREDENTIAL_HELPER, GIT_CREDENTIAL_SCRIPT, { mode: "0755" });
  guestWrite("/etc/gitconfig", gitSystemConfig());
  console.error(forwarded.length ? `[desk-vm] forwarded credentials: ${forwarded.join(", ")}` : "[desk-vm] WARNING: no credentials forwarded — model calls from this box will fail");
  const meta = { ...(readJson(metaPath(ROOT, sid), {}) || {}), id: sid, guest: INSTANCE, status: "attached", work: p.work, session: p.session, upAt: new Date().toISOString(), seeded };
  writeMeta(sid, meta);
  return meta;
}

function cmdUp(id, { json }) {
  const meta = attachJob(safeId(id));
  if (json) console.log(JSON.stringify(meta, null, 2));
  else console.log(`${INSTANCE} ${meta.work}`);
}

// ── sandbox mode in the guest ─────────────────────────────────────────────

const servePath = (root) => join(stateDir(root, MODE_ID), "serve.json");

/** Run a shell script in the guest as gotchi, in the mode job's work dir. */
function asGotchi(script, opts = {}) {
  const p = guestPaths(MODE_ID);
  return guestRoot(["-u", GUEST_USER, "-H", "bash", "-c", `set -a; . ${SANDBOX_ENV}; set +a; cd ${p.work}; ${script}`], opts);
}

/** Baseline commit in the guest copy: promote diffs against it. */
export const BASELINE_SCRIPT = `[ -d .git ] || git init -q
git add -A
git -c commit.gpgsign=false commit -q --allow-empty -m "gotchibot sandbox baseline"
git tag -f ${BASELINE_TAG} >/dev/null`;

async function serveUp(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
    return r.status > 0;
  } catch {
    return false;
  }
}

async function cmdModeUp({ project, fresh, json }) {
  const dir = resolve(project || ROOT);
  if (!existsSync(dir)) die(`no project dir: ${dir}`);
  const floor = readFloor();
  const meta = attachJob(MODE_ID, { seed: { dir, excludes: SEED_EXCLUDES }, fresh });
  if (meta.seeded) {
    const b = asGotchi(BASELINE_SCRIPT);
    if (b.status !== 0) die(`baseline commit failed: ${String(b.stderr || "").trim()}`);
    writeMeta(MODE_ID, { ...meta, project: dir, seededAt: new Date().toISOString() });
  }
  let serve = readJson(servePath(ROOT), null);
  if (!serve || !(await serveUp(floor.modePort))) {
    const password = randomBytes(18).toString("base64url");
    const p = guestPaths(MODE_ID);
    guestWrite(`${p.session}/.serve-pass`, password, { owner: `${GUEST_USER}:${GUEST_USER}`, mode: "0600" });
    const r = asGotchi(
      `export OPENCODE_SERVER_PASSWORD="$(cat ${p.session}/.serve-pass)"; setsid -f opencode serve --port ${GUEST_SERVE_PORT} --hostname 127.0.0.1 > ${p.session}/serve.log 2>&1 < /dev/null`,
    );
    if (r.status !== 0) die(`opencode serve failed to start: ${String(r.stderr || "").trim()}`);
    serve = { url: `http://127.0.0.1:${floor.modePort}`, password, startedAt: new Date().toISOString() };
    mkdirSync(stateDir(ROOT, MODE_ID), { recursive: true });
    writeFileSync(servePath(ROOT), JSON.stringify(serve, null, 2), { mode: 0o600 });
    chmodSync(servePath(ROOT), 0o600);
    for (let i = 0; i < 40 && !(await serveUp(floor.modePort)); i++) await new Promise((r2) => setTimeout(r2, 500));
    if (!(await serveUp(floor.modePort))) die(`opencode serve did not come up on ${serve.url} — limactl shell ${INSTANCE} sudo cat ${p.session}/serve.log`);
  }
  const out = { url: serve.url, project: readJson(metaPath(ROOT, MODE_ID), {})?.project || dir, work: guestPaths(MODE_ID).work };
  // The password goes to the chat pane via serve.json (0600), never stdout.
  if (json) console.log(JSON.stringify({ ...out, passwordFile: servePath(ROOT) }));
  else console.log(`sandbox mode: ${out.url} · guest ${out.work} · seeded from ${out.project}`);
}

function cmdModePromote({ project, yes }) {
  requireRunning();
  const meta = readJson(metaPath(ROOT, MODE_ID), {}) || {};
  const dir = resolve(project || meta.project || ROOT);
  const r = asGotchi(`git add -A && git diff --cached --binary ${BASELINE_TAG}`, { encoding: "buffer", maxBuffer: 2 ** 30 });
  if (r.status !== 0) die(`could not diff the sandbox: ${String(r.stderr || "").trim()}`);
  const patch = r.stdout;
  if (!patch.length) return console.log("nothing to promote — the sandbox matches its baseline");
  mkdirSync(stateDir(ROOT, MODE_ID), { recursive: true });
  const file = join(stateDir(ROOT, MODE_ID), "promote.patch");
  writeFileSync(file, patch);
  const stat = spawnSync("git", ["apply", "--stat", file], { cwd: dir, encoding: "utf8" });
  console.log(stat.stdout.trim());
  const check = spawnSync("git", ["apply", "--check", file], { cwd: dir, encoding: "utf8" });
  if (check.status !== 0) die(`patch does not apply cleanly to ${dir}:\n${check.stderr.trim()}\n(patch kept at ${file})`);
  if (!yes) return console.log(`\nPatch: ${file}\nApply to ${dir} with: gotchibot desk-vm mode-promote --yes`);
  const a = spawnSync("git", ["apply", file], { cwd: dir, encoding: "utf8" });
  if (a.status !== 0) die(`apply failed: ${a.stderr.trim()}`);
  const b = asGotchi(`git -c commit.gpgsign=false commit -q --allow-empty -m "gotchibot sandbox promoted" && git tag -f ${BASELINE_TAG} >/dev/null`);
  if (b.status !== 0) console.error("[desk-vm] applied, but the guest baseline did not move — the next promote will repeat these changes");
  console.log(`applied to ${dir}`);
}

function cmdModeDown() {
  if (running()) asGotchi("pkill -u gotchi -f 'opencode serve' || true");
  rmSync(servePath(ROOT), { force: true });
  console.log("sandbox mode server stopped (the guest copy is kept; mode-up --fresh reseeds)");
}

function requireRunning() {
  if (!running()) die(`desk VM not running: ${INSTANCE} — run: node scripts/desk-vm.mjs up <id>`);
}

function cmdExec(id, args) {
  if (!args.length) die("usage: desk-vm.mjs exec <id> -- <cmd...>", 2);
  requireRunning();
  const r = guestRoot(guestCommand(id, args), { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

function pullJob(sid) {
  const p = guestPaths(sid);
  tarOut(p.work, workDir(ROOT, sid));
  tarOut(p.session, sessionDir(ROOT, sid));
}

function cmdDetach(id) {
  const sid = safeId(id);
  if (running()) {
    try {
      pullJob(sid);
    } catch (e) {
      die(`${e.message} — ${INSTANCE} left as is so its files are not lost`);
    }
    guestRoot(["rm", "-rf", "--", guestPaths(sid).root]);
  }
  if (existsSync(metaPath(ROOT, sid))) writeMeta(sid, { ...readJson(metaPath(ROOT, sid), {}), status: "detached", detachedAt: new Date().toISOString() });
  console.error(`[desk-vm] detached ${sid} — ${INSTANCE} ${running() ? "still running" : "not running"}`);
}

function cmdStatus(id) {
  const inst = limaInstance();
  if (id) {
    const m = readJson(metaPath(ROOT, safeId(id)), null);
    console.log(JSON.stringify({ guest: inst?.status || "not created", job: m }, null, 2));
    return;
  }
  const jobs = existsSync(join(ROOT, "desk-vms")) ? readdirSync(join(ROOT, "desk-vms")) : [];
  console.log(`${INSTANCE}: ${inst ? `${inst.status} · ${inst.cpus} vCPU · ${Math.round(Number(inst.memory) / 2 ** 30)} GiB` : "not created"}`);
  for (const j of jobs) {
    const m = readJson(metaPath(ROOT, j), {});
    console.log(`  ${j}  ${m.status || "?"}`);
  }
}

function cmdModels(id, { json, check }) {
  requireRunning();
  const r = guestRoot(guestCommand(id, ["opencode", "models"]), { timeout: 60_000 });
  const models = String(r.stdout || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("["));
  if (check) {
    const ok = models.includes(check);
    if (json) console.log(JSON.stringify({ ok, model: check, models }, null, 2));
    else if (ok) console.log(`ok ${check}`);
    else console.error(`model not available in the desk VM: ${check}\nthe box serves: ${models.join(", ") || "(none)"}`);
    process.exit(ok ? 0 : 1);
  }
  if (json) console.log(JSON.stringify({ models }, null, 2));
  else for (const m of models) console.log(m);
}

function cmdPromote(id, dest) {
  const sid = safeId(id);
  if (!dest) die("promote requires destDir (e.g. ~/Dev/my-new-app)", 2);
  if (running()) pullJob(sid);
  const work = workDir(ROOT, sid);
  if (!existsSync(work)) die(`no work dir: ${work}`);
  const destAbs = resolve(dest.startsWith("~") ? dest.replace(/^~/, homedir()) : dest);
  if (existsSync(destAbs) && readdirSync(destAbs).length) die(`dest not empty: ${destAbs}`);
  mkdirSync(destAbs, { recursive: true });
  cpSync(work, destAbs, { recursive: true });
  console.log(destAbs);
}

function cmdRm(id, { purge }) {
  if (id === SHARED_GUEST_ID) {
    if (purge) {
      lima(["delete", "--force", INSTANCE], { stdio: "inherit" });
      console.error(`[desk-vm] deleted ${INSTANCE}`);
    } else {
      lima(["stop", INSTANCE], { stdio: "inherit" });
      console.error(`[desk-vm] stopped ${INSTANCE}`);
    }
    return;
  }
  const sid = safeId(id);
  if (running()) guestRoot(["rm", "-rf", "--", guestPaths(sid).root]);
  if (purge) rmSync(stateDir(ROOT, sid), { recursive: true, force: true });
  else if (existsSync(metaPath(ROOT, sid))) writeMeta(sid, { ...readJson(metaPath(ROOT, sid), {}), status: "removed" });
  console.error(`[desk-vm] removed job ${sid}${purge ? " (local copy purged)" : ""}`);
}

function usage(code = 2) {
  console.error(
    "usage: desk-vm.mjs check|enable|disable|available [--json] | ensure-image [--rebuild] | up <id> [--json] | exec <id> -- <cmd...> | detach <id> | status [id] | models <id> [--check m] [--json] | promote <id> <dest> | rm <id|shared> [--purge] | mode-up [--project DIR] [--fresh] [--json] | mode-promote [--yes] | mode-down",
  );
  process.exit(code);
}

async function main(argv) {
  const [cmd, id, ...rest] = argv;
  const json = argv.includes("--json");
  switch (cmd) {
    case "check":
      return cmdCheck({ json });
    case "enable":
      return cmdEnable(true);
    case "disable":
      return cmdEnable(false);
    case "available": {
      const a = available();
      if (json) console.log(JSON.stringify(a));
      else console.log(a.ok ? `available — ${a.reason}` : `unavailable — ${a.reason}`);
      process.exit(a.ok ? 0 : 1);
    }
    // eslint-disable-next-line no-fallthrough
    case "backend": {
      // backend <want> → prints the resolved backend; line 2 is the fallback note
      const r = resolveBackend(id, String(id || "auto").toLowerCase() === "auto" ? available() : { ok: false });
      console.log(r.backend);
      if (r.fallback) console.log(r.fallback);
      return;
    }
    case "ensure-image":
      return cmdEnsureImage({ rebuild: argv.includes("--rebuild") });
    case "up":
      if (!id) usage();
      return cmdUp(id, { json });
    case "exec": {
      if (!id) usage();
      const i = argv.indexOf("--");
      return cmdExec(id, i >= 0 ? argv.slice(i + 1) : rest);
    }
    case "detach":
      if (!id) usage();
      return cmdDetach(id);
    case "status":
      return cmdStatus(id && !id.startsWith("-") ? id : null);
    case "models": {
      if (!id) usage();
      const ci = argv.indexOf("--check");
      return cmdModels(id, { json, check: ci >= 0 ? argv[ci + 1] : null });
    }
    case "promote":
      return cmdPromote(id, rest[0]);
    case "rm":
      if (!id) usage();
      return cmdRm(id, { purge: argv.includes("--purge") });
    case "mode-up": {
      const pi = argv.indexOf("--project");
      return cmdModeUp({ project: pi >= 0 ? argv[pi + 1] : null, fresh: argv.includes("--fresh"), json });
    }
    case "mode-promote": {
      const pi = argv.indexOf("--project");
      return cmdModePromote({ project: pi >= 0 ? argv[pi + 1] : null, yes: argv.includes("--yes") });
    }
    case "mode-down":
      return cmdModeDown();
    default:
      usage(cmd ? 2 : 0);
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => die(e?.message || String(e)));
}
