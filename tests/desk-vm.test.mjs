/**
 * Desk VM (scripts/desk-vm.mjs): the power gate, guest sizing, the Lima config's
 * isolation, and dispatch's auto backend. No VM is booted here.
 *   node --test tests/desk-vm.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  qualify,
  vmSize,
  limaConfig,
  available,
  resolveBackend,
  guestCommand,
  guestPaths,
  safeId,
  readFloor,
  DEFAULT_FLOOR,
  SEED_EXCLUDES,
  BASELINE_SCRIPT,
  GUEST_SERVE_PORT,
} from "../scripts/desk-vm.mjs";
import { readFileSync, readdirSync } from "node:fs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mac = (o = {}) => ({ platform: "darwin", arch: "arm64", cores: 16, memGB: 64, freeGB: 40, macos: 26, limactl: "limactl version 2.2.0", ...o });

describe("power gate", () => {
  it("qualifies a big Apple Silicon Mac with limactl", () => {
    assert.deepEqual(qualify(mac()), { ok: true, reasons: [] });
  });

  it("names every shortfall on a small Mac", () => {
    const q = qualify(mac({ cores: 8, memGB: 8 }));
    assert.equal(q.ok, false);
    assert.deepEqual(q.reasons, ["8 cores < 12", "8 GB RAM < 32"]);
  });

  it("force skips the floor but not the platform or limactl", () => {
    assert.equal(qualify(mac({ cores: 8, memGB: 8 }), DEFAULT_FLOOR, { force: true }).ok, true);
    assert.match(qualify(mac({ limactl: null }), DEFAULT_FLOOR, { force: true }).reasons.join(), /limactl not installed/);
    assert.match(qualify(mac({ platform: "linux", arch: "x64" }), DEFAULT_FLOOR, { force: true }).reasons.join(), /need macOS/);
    assert.match(qualify(mac({ arch: "x64" })).reasons.join(), /Apple Silicon/);
  });

  it("reads the floor from config/desk-vm.json over the defaults", (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "gb-dvm-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(path.join(root, "config"));
    writeFileSync(path.join(root, "config", "desk-vm.json"), JSON.stringify({ minCores: 20 }));
    const floor = readFloor(root);
    assert.equal(floor.minCores, 20);
    assert.equal(floor.minMemGB, DEFAULT_FLOOR.minMemGB);
    assert.equal(qualify(mac(), floor).ok, false);
  });
});

describe("guest size", () => {
  it("takes a capped share of the desk and leaves headroom", () => {
    assert.deepEqual(vmSize(mac()), { cpus: 8, memGB: 16, diskGB: 40 });
    assert.deepEqual(vmSize(mac({ cores: 12, memGB: 32 })), { cpus: 6, memGB: 8, diskGB: 40 });
    assert.deepEqual(vmSize(mac({ cores: 24, memGB: 192 })), { cpus: 8, memGB: 16, diskGB: 40 });
  });

  it("boots a 2 vCPU / 2 GiB test guest when forced on a small desk", () => {
    assert.deepEqual(vmSize(mac({ cores: 8, memGB: 8 }), DEFAULT_FLOOR, { force: true }), { cpus: 2, memGB: 2, diskGB: 20 });
  });
});

describe("Lima config", () => {
  const yaml = limaConfig({ cpus: 4, memGB: 8, diskGB: 40 });

  it("shares nothing from the desk and forwards no ports", () => {
    assert.match(yaml, /^vmType: vz$/m);
    assert.match(yaml, /^mounts: \[\]$/m);
    assert.match(yaml, /^- template:_images\/debian-12$/m);
    assert.doesNotMatch(yaml, /_default\/mounts|template:debian-12\b/);
    assert.match(yaml, /loadDotSSHPubKeys: false/);
    assert.match(yaml, /forwardAgent: false/);
    assert.equal((yaml.match(/ignore: true/g) || []).length, 2);
    // The one forward: the guest's sandbox-mode opencode server → the desk's loopback, listed first.
    const fwd = yaml.split("portForwards:")[1];
    assert.ok(fwd.indexOf(`guestPort: ${GUEST_SERVE_PORT}`) < fwd.indexOf("ignore: true"));
    assert.match(fwd, /guestPort: 4097\n  hostIP: "127\.0\.0\.1"\n  hostPort: 41097/);
    assert.match(yaml, /cpus: 4\nmemory: "8GiB"\ndisk: "40GiB"/);
  });

  it("provisions arm64 node, opencode, and the loopback abra host", () => {
    assert.match(yaml, /linux-arm64/);
    assert.match(yaml, /opencode\.ai\/install/);
    assert.match(yaml, /host\.lima\.internal/);
    assert.match(yaml, /useradd -m -s \/bin\/bash gotchi/);
  });

  it("is valid for the installed Lima", { skip: spawnSync("limactl", ["--version"]).status !== 0 && "limactl not installed" }, (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), "gb-dvm-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const f = path.join(dir, "gbdesk.yaml");
    writeFileSync(f, yaml);
    const r = spawnSync("limactl", ["template", "validate", f], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  });
});

describe("availability and backend", () => {
  const tmpRoot = (t, optIn) => {
    const root = mkdtempSync(path.join(tmpdir(), "gb-dvm-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(path.join(root, "sessions"));
    if (optIn) writeFileSync(path.join(root, "sessions", ".desk-vm.json"), JSON.stringify(optIn));
    return root;
  };

  it("needs qualify + enable + a created guest", (t) => {
    const env = {};
    assert.match(available({ root: tmpRoot(t), specs: mac(), env, instanceExists: () => true }).reason, /not enabled/);
    assert.match(available({ root: tmpRoot(t, { enabled: true }), specs: mac(), env, instanceExists: () => false }).reason, /ensure-image/);
    assert.equal(available({ root: tmpRoot(t, { enabled: true }), specs: mac(), env, instanceExists: () => true }).ok, true);
    assert.match(available({ root: tmpRoot(t, { enabled: true }), specs: mac({ cores: 8 }), env, instanceExists: () => true }).reason, /8 cores/);
    assert.equal(available({ root: tmpRoot(t, { enabled: true }), specs: mac({ cores: 8, memGB: 8 }), env: { GOTCHIBOT_DESK_VM_FORCE: "1" }, instanceExists: () => true }).ok, true);
  });

  it("auto picks the desk VM, else docker with the reason — never the Hub VM", () => {
    assert.deepEqual(resolveBackend("auto", { ok: true }), { backend: "desk-vm", fallback: null });
    assert.deepEqual(resolveBackend(undefined, { ok: false, reason: "8 cores < 12" }), { backend: "docker", fallback: "desk VM unavailable: 8 cores < 12" });
    assert.deepEqual(resolveBackend("vm", { ok: false }), { backend: "vm", fallback: null });
  });
});

describe("job command", () => {
  it("runs as gotchi in the job's own work dir, every arg quoted", () => {
    const argv = guestCommand("s1", ["opencode", "run", "it's; rm -rf /"]);
    assert.deepEqual(argv.slice(0, 5), ["-u", "gotchi", "-H", "bash", "-c"]);
    assert.match(argv[5], /cd \/jobs\/s1\/work; exec 'opencode' 'run' 'it'\\''s; rm -rf \/'$/);
    assert.match(argv[5], /^set -a; \. \/etc\/gotchibot\/sandbox\.env; set \+a;/);
  });

  it("keeps job paths inside /jobs", () => {
    assert.deepEqual(guestPaths("s2"), { root: "/jobs/s2", work: "/jobs/s2/work", session: "/jobs/s2/session" });
    assert.equal(safeId("../../etc"), "....etc");
    assert.throws(() => safeId(".."), /invalid/);
    assert.throws(() => safeId("/"), /invalid/);
  });
});

describe("dispatch backend", () => {
  const dispatch = path.join(repo, "scripts", "opencode-dispatch.sh");
  it("rejects an unknown backend on every entry point", () => {
    const r = spawnSync("bash", [dispatch, "list"], { encoding: "utf8", env: { ...process.env, GOTCHIBOT_SANDBOX_BACKEND: "bogus" } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /'auto', 'docker', 'vm' or 'desk-vm'/);
  });

  it("resolves auto from the desk-vm CLI", () => {
    const r = spawnSync(process.execPath, [path.join(repo, "scripts", "desk-vm.mjs"), "backend", "auto"], { encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.ok(["docker", "desk-vm"].includes(r.stdout.split("\n")[0]));
  });
});

describe("sandbox mode in the desk VM", () => {
  const sh = (cmd, cwd) => spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8" });

  it("never seeds secrets, the Hub desk token, or bulk into the guest", (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), "gb-seed-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const [p, body] of [["src/a.js", "x"], [".env", "K=1"], [".env.local", "K=2"], ["sessions/.hub.json", "{}"], ["node_modules/m/i.js", ""], ["certs/k.pem", ""], ["id.key", ""], ["README.md", "r"]]) {
      mkdirSync(path.join(dir, path.dirname(p)), { recursive: true });
      writeFileSync(path.join(dir, p), body);
    }
    const r = spawnSync("tar", [...SEED_EXCLUDES.flatMap((x) => ["--exclude", x]), "-C", dir, "-cf", "-", "."], { maxBuffer: 2 ** 26 });
    const list = spawnSync("tar", ["-tf", "-"], { input: r.stdout, encoding: "utf8" }).stdout.split("\n").filter((l) => /[^/]$/.test(l) && l !== ".");
    assert.deepEqual(list.sort(), ["./README.md", "./src/a.js"]);
  });

  it("promotes exactly the changes made after the baseline, and refuses a stale patch", (t) => {
    const base = mkdtempSync(path.join(tmpdir(), "gb-promote-"));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const project = path.join(base, "project");
    const guest = path.join(base, "guest");
    mkdirSync(project);
    writeFileSync(path.join(project, "a.txt"), "one\n");
    writeFileSync(path.join(project, "dirty.txt"), "uncommitted\n");
    sh("git init -q && git add a.txt && git -c user.email=t@t -c user.name=t commit -qm init", project);
    sh(`cp -R "${project}" "${guest}"`, base);
    // In the guest: the user's uncommitted file is part of the baseline, not the patch.
    const ident = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    const b = spawnSync("bash", ["-c", BASELINE_SCRIPT], { cwd: guest, env: ident, encoding: "utf8" });
    assert.equal(b.status, 0, b.stderr);
    writeFileSync(path.join(guest, "a.txt"), "one\ntwo\n");
    writeFileSync(path.join(guest, "new.txt"), "fresh\n");
    const patch = sh("git add -A && git diff --cached --binary gotchibot-baseline", guest).stdout;
    assert.match(patch, /\+two/);
    assert.match(patch, /new\.txt/);
    assert.doesNotMatch(patch, /dirty\.txt/);
    const pf = path.join(base, "p.patch");
    writeFileSync(pf, patch);
    assert.equal(spawnSync("git", ["apply", "--check", pf], { cwd: project }).status, 0);
    assert.equal(spawnSync("git", ["apply", pf], { cwd: project }).status, 0);
    assert.equal(readFileSync(path.join(project, "a.txt"), "utf8"), "one\ntwo\n");
    // The project moved on meanwhile → the same patch no longer applies cleanly.
    writeFileSync(path.join(project, "a.txt"), "changed on the desk\n");
    assert.notEqual(spawnSync("git", ["apply", "--check", pf], { cwd: project }).status, 0);
  });

  it("the chat pane attaches only on an available desk VM and labels local otherwise", () => {
    const pane = readFileSync(path.join(repo, "scripts", "chat-pane.sh"), "utf8");
    assert.match(pane, /sandbox\) border=" Sandbox · local " ;;/);
    assert.match(pane, /\[ "\$AGENT" = "sandbox" \] && \[ "\$\{GOTCHIBOT_SANDBOX_LOCAL:-\}" != "1" \]/);
    assert.match(pane, /desk-vm\.mjs" available >\/dev\/null/);
    assert.match(pane, /OPENCODE_SERVER_PASSWORD="\$\(node -e/);
    assert.match(pane, /opencode attach "\$vm_url"/);
    assert.doesNotMatch(pane, /opencode attach[^\n]*-p /, "password never on argv");
  });
});
