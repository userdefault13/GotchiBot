/**
 * Screen off (scripts/screen-power.sh + cockpit Settings…): backlight to 0, any
 * key restores the remembered level. Runs against a fake /sys/class/backlight.
 *   node --test tests/screen-power.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync, execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function setup(t, devices) {
  const root = mkdtempSync(path.join(tmpdir(), "gb-screen-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "scripts"));
  cpSync(path.join(repo, "scripts", "screen-power.sh"), path.join(root, "scripts", "screen-power.sh"));
  const sys = path.join(root, "sys");
  for (const [name, cur, max] of devices) {
    mkdirSync(path.join(sys, name), { recursive: true });
    writeFileSync(path.join(sys, name, "brightness"), `${cur}\n`);
    writeFileSync(path.join(sys, name, "max_brightness"), `${max}\n`);
  }
  // No busctl in PATH: logind is skipped and the (writable) fake sysfs is used.
  const env = { PATH: "/usr/bin:/bin", HOME: root, GOTCHIBOT_BACKLIGHT_SYSFS: sys };
  const run = (...args) => spawnSync("bash", [path.join(root, "scripts", "screen-power.sh"), ...args], { env, encoding: "utf8", input: "x" });
  const level = (name) => readFileSync(path.join(sys, name, "brightness"), "utf8").trim();
  return { run, level };
}

describe("screen-power.sh", () => {
  it("turns the backlight off and back on to the remembered level", (t) => {
    const { run, level } = setup(t, [["gmux_backlight", 32767, 65535]]);
    assert.match(run("status").stdout, /gmux_backlight 32767\/65535/);
    assert.equal(run("off").status, 0);
    assert.equal(level("gmux_backlight"), "0");
    assert.equal(run("off").status, 0, "a second off keeps the remembered level");
    assert.equal(run("on").status, 0);
    assert.equal(level("gmux_backlight"), "32767");
  });

  it("off-until-key restores on the first key", (t) => {
    const { run, level } = setup(t, [["apple-panel-bl", 140, 509]]);
    const r = run("off-until-key");
    assert.equal(r.status, 0);
    assert.match(r.stderr, /Press any key/);
    assert.equal(level("apple-panel-bl"), "140");
  });

  it("prefers the panel backlight, uses max with nothing remembered, and reports none", (t) => {
    const { run, level } = setup(t, [["acpi_video0", 5, 10], ["gmux_backlight", 0, 65535]]);
    assert.match(run("status").stdout, /^gmux_backlight /);
    assert.equal(run("on").status, 0);
    assert.equal(level("gmux_backlight"), "65535");
    const none = setup(t, []);
    assert.equal(none.run("available").status, 1);
    assert.match(none.run("status").stdout, /no backlight/);
  });
});

describe("cockpit Settings…", () => {
  const menu = (on) =>
    execFileSync(process.execPath, [path.join(repo, "scripts", "onboarding-gate.mjs"), "--print-cockpit-menu", "--tree"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, GOTCHIBOT_SCREEN_POWER: on },
    });

  it("offers Screen off only on a machine with a backlight", () => {
    assert.match(menu("1"), /# group:settings\n  settings\n  avatar\n  roster-order\n  screen-off/);
    assert.doesNotMatch(menu("0"), /screen-off/);
  });
});
