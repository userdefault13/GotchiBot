/**
 * gotchibot gliff + the optional installer step. A fake gliff / omarchy on PATH
 * records what it was asked; nothing real is launched or installed.
 *   node --test tests/gliff.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDesks, main, resolveDesk } from "../scripts/gliff-desk.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gliffCli = path.join(root, "scripts/gliff-desk.mjs");
const installer = path.join(root, "scripts/omarchy-desk-install.sh");
const reg = loadDesks();

function fakeBin(dir, names, logFile) {
  for (const n of names) {
    const f = path.join(dir, n);
    writeFileSync(f, `#!/bin/sh\necho "${n} $*" >> "${logFile}"\nexit 0\n`);
    chmodSync(f, 0o755);
  }
}
const sysPath = `${path.dirname(process.execPath)}:/usr/bin:/bin`;

describe("resolveDesk", () => {
  it("maps names, aliases, case, FQDNs and addresses to user@host", () => {
    assert.equal(resolveDesk("omarchymini", reg).target, "user_default@100.82.137.20");
    assert.equal(resolveDesk("OmarchyMini", reg).target, "user_default@100.82.137.20");
    assert.equal(resolveDesk("mini", reg).target, "user_default@100.82.137.20");
    assert.equal(resolveDesk("imacOmarchy", reg).target, "user_default@100.97.16.64");
    assert.equal(resolveDesk("hub", reg).name, "imacomarchy");
    assert.equal(resolveDesk("omarchyimac", reg).target, "user_default@100.110.220.76");
    assert.equal(resolveDesk("100.110.220.76", reg).name, "omarchyimac");
    assert.equal(resolveDesk("omarchyM1", reg).target, "user_default@omarchym1.tail4120f5.ts.net");
    assert.equal(resolveDesk("omarchym1.tail4120f5.ts.net", reg).name, "omarchym1");
  });
  it("passes a literal user@host through and rejects junk and unknown names", () => {
    assert.equal(resolveDesk("bob@box.example.ts.net", reg).target, "bob@box.example.ts.net");
    assert.throws(() => resolveDesk("bob@bad host;rm", reg), /not a valid user@host/);
    assert.throws(() => resolveDesk("nope", reg), /unknown desk "nope" \(known: .*omarchymini/);
    assert.throws(() => resolveDesk("", reg), /no desk/);
  });
  it("the registry holds tailnet addresses only", () => {
    const text = readFileSync(path.join(root, "config/desks.json"), "utf8");
    assert.doesNotMatch(text, /password|secret|token|key|pass/i);
  });
});

describe("main (injected deps, no process spawned)", () => {
  const run = (argv, extra = {}) => {
    const calls = [];
    let out = "";
    let err = "";
    const code = main(argv, {
      platform: "linux",
      has: () => true,
      run: (bin, args) => (calls.push([bin, args]), 0),
      out: (s) => (out += s),
      err: (s) => (err += s),
      ...extra,
    });
    return { code, calls, out, err };
  };
  it("runs gliff user@host", () => {
    const r = run(["omarchymini"]);
    assert.equal(r.code, 0);
    assert.deepEqual(r.calls, [["gliff", ["user_default@100.82.137.20"]]]);
  });
  it("passes --headless through, before the target", () => {
    assert.deepEqual(run(["--headless", "2011"]).calls, [["gliff", ["--headless", "user_default@100.110.220.76"]]]);
    assert.deepEqual(run(["2011", "--headless"]).calls, [["gliff", ["--headless", "user_default@100.110.220.76"]]]);
  });
  it("refuses on macOS without running anything", () => {
    const r = run(["omarchymini"], { platform: "darwin" });
    assert.equal(r.code, 1);
    assert.match(r.err, /needs Hyprland.*macOS/);
    assert.equal(r.calls.length, 0);
  });
  it("prints install guidance and exits non-zero when gliff is missing", () => {
    const r = run(["omarchymini"], { has: () => false });
    assert.equal(r.code, 1);
    assert.match(r.err, /omarchy pkg add gliff/);
    assert.equal(r.calls.length, 0);
  });
  it("unknown desk is a usage error; --list prints the registry; no args prints usage", () => {
    assert.equal(run(["nope"]).code, 2);
    const l = run(["--list"]);
    assert.equal(l.code, 0);
    assert.match(l.out, /omarchymini\s+user_default@100\.82\.137\.20/);
    assert.match(l.out, /\(hub\)/);
    assert.equal(run([]).code, 2);
  });
});

describe("CLI with a fake gliff on PATH", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gliff-cli-"));
  const log = path.join(dir, "log");
  fakeBin(dir, ["gliff"], log);
  const cli = (args, env = {}) =>
    spawnSync(process.execPath, [gliffCli, ...args], {
      encoding: "utf8",
      env: { PATH: `${dir}:${sysPath}`, GOTCHIBOT_GLIFF_PLATFORM: "linux", ...env },
    });
  it("execs the fake gliff with user@host and --headless", () => {
    const r = cli(["omarchymini", "--headless"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(log, "utf8").trim(), "gliff --headless user_default@100.82.137.20");
  });
  it("macOS refusal through the real entry point", () => {
    const r = cli(["omarchymini"], { GOTCHIBOT_GLIFF_PLATFORM: "darwin" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Hyprland/);
  });
  it("missing gliff through the real entry point", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "gliff-empty-"));
    const r = spawnSync(process.execPath, [gliffCli, "omarchymini"], {
      encoding: "utf8",
      env: { PATH: empty, GOTCHIBOT_GLIFF_PLATFORM: "linux" },
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /omarchy pkg add gliff/);
  });
  it("is wired into gotchibot help", () => {
    const text = readFileSync(path.join(root, "scripts/gotchibot"), "utf8");
    assert.match(text, /gotchibot gliff <desk\|user@host> \[--headless\]/);
    assert.match(text, /gliff\) cmd_gliff/);
  });
});

describe("installer gliff step skip rules (fake omarchy/hyprctl/gliff, temp HOME)", () => {
  function install(env = {}, { bins = ["omarchy", "hyprctl"] } = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), "gliff-inst-"));
    const log = path.join(dir, "log");
    const bin = path.join(dir, "bin");
    spawnSync("mkdir", ["-p", bin]);
    fakeBin(bin, bins, log);
    const r = spawnSync("bash", [installer], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${sysPath}`,
        HOME: dir,
        GOTCHIBOT_GLIFF_OS: "Linux",
        GOTCHIBOT_GLIFF_HOST: "omarchyimac",
        GOTCHIBOT_GLIFF_MEMKB: String(8 * 1024 * 1024),
        ...env,
      },
    });
    const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
    const line = (r.stdout.match(/^gliff:.*$/m) || [""])[0];
    return { r, calls, line };
  }
  it("installs with `omarchy pkg add gliff` on an eligible desk", () => {
    const { r, calls, line } = install();
    assert.equal(r.status, 0, r.stderr);
    assert.match(calls, /^omarchy pkg add gliff$/m);
    assert.match(line, /installed with omarchy pkg add gliff/);
  });
  it("is idempotent: gliff already on PATH skips", () => {
    const { r, calls, line } = install({}, { bins: ["omarchy", "hyprctl", "gliff"] });
    assert.equal(r.status, 0);
    assert.doesNotMatch(calls, /pkg add/);
    assert.match(line, /already installed/);
  });
  it("skips on macOS", () => {
    const { calls, line } = install({ GOTCHIBOT_GLIFF_OS: "Darwin" });
    assert.match(line, /skipped \(macOS has no Hyprland\)/);
    assert.doesNotMatch(calls, /pkg add/);
  });
  it("skips when omarchy or Hyprland is missing", () => {
    assert.match(install({}, { bins: ["hyprctl"] }).line, /not an Omarchy\/Hyprland desk/);
    assert.match(install({}, { bins: ["omarchy"] }).line, /not an Omarchy\/Hyprland desk/);
    assert.doesNotMatch(install({}, { bins: ["hyprctl"] }).calls, /pkg add/);
  });
  it("skips on the hub desk (role hub in config/desks.json)", () => {
    for (const host of ["imacOmarchy", "imacomarchy.tail4120f5.ts.net"]) {
      const { calls, line } = install({ GOTCHIBOT_GLIFF_HOST: host });
      assert.match(line, /skipped \(hub desk/);
      assert.doesNotMatch(calls, /pkg add/);
    }
  });
  it("skips on a low-RAM box (omarchymini, 1.7 GiB)", () => {
    const { calls, line } = install({ GOTCHIBOT_GLIFF_HOST: "omarchymini", GOTCHIBOT_GLIFF_MEMKB: String(1.7 * 1024 * 1024 | 0) });
    assert.match(line, /skipped \(low RAM: 1740 MiB < 2560 MiB\)/);
    assert.doesNotMatch(calls, /pkg add/);
  });
  it("GOTCHIBOT_GLIFF=0 opts out", () => {
    const { calls, line } = install({ GOTCHIBOT_GLIFF: "0" });
    assert.match(line, /GOTCHIBOT_GLIFF=0/);
    assert.doesNotMatch(calls, /pkg add/);
  });
  it("a missing package is a note and the desk install still succeeds", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gliff-nopkg-"));
    const bin = path.join(dir, "bin");
    spawnSync("mkdir", ["-p", bin]);
    writeFileSync(path.join(bin, "omarchy"), "#!/bin/sh\nexit 1\n");
    writeFileSync(path.join(bin, "hyprctl"), "#!/bin/sh\nexit 0\n");
    chmodSync(path.join(bin, "omarchy"), 0o755);
    chmodSync(path.join(bin, "hyprctl"), 0o755);
    const r = spawnSync("bash", [installer], {
      encoding: "utf8",
      env: { PATH: `${bin}:${sysPath}`, HOME: dir, GOTCHIBOT_GLIFF_OS: "Linux", GOTCHIBOT_GLIFF_HOST: "omarchyimac", GOTCHIBOT_GLIFF_MEMKB: "8388608" },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /gliff: package not found via 'omarchy pkg add gliff'; not installed/);
  });
  it("uses only the package manager route: no source build, no piped installer, no bin/install", () => {
    const text = readFileSync(installer, "utf8");
    assert.doesNotMatch(text, /makepkg|cargo|git clone|\bcurl\b|\bwget\b|bin\/install|\bsudo\b/);
    assert.match(text, /omarchy pkg add gliff/);
  });
});
