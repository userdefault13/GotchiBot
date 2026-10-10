/**
 * Omarchy desk installer — syntax and "no second hub" guards.
 *   node --test tests/omarchy-desk-install.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts/omarchy-desk-install.sh");
const pkgbuild = path.join(root, "packaging/omarchy/PKGBUILD");

describe("omarchy desk install", () => {
  it("bash -n scripts/omarchy-desk-install.sh", () => {
    const r = spawnSync("bash", ["-n", script], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  });

  it("does not npm-install, vendor node_modules, or hub-install", () => {
    const text = `${readFileSync(script, "utf8")}\n${readFileSync(pkgbuild, "utf8")}`;
    assert.doesNotMatch(text, /npm\s+(install|i|ci)\b/);
    assert.doesNotMatch(text, /node_modules/);
    assert.doesNotMatch(text, /hub install/);
    assert.doesNotMatch(text, /\bdocker\b/);
    assert.doesNotMatch(text, /\bsystemctl\b/);
    assert.doesNotMatch(text, /\b(nc|socat|ss)\b/);
    assert.match(readFileSync(script, "utf8"), /scripts\/gotchibot/);
    assert.match(readFileSync(pkgbuild, "utf8"), /omarchy-desk-install\.sh/);
  });

  it("links the checkout CLI under a temp HOME", () => {
    const home = mkdtempSync(path.join(tmpdir(), "omarchy-desk-"));
    try {
      const r = spawnSync("bash", [script], {
        encoding: "utf8",
        env: { ...process.env, HOME: home, GOTCHIBOT_GLIFF: "0" },
      });
      assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
      assert.match(r.stdout, /Port 4001 was not touched/);
      assert.equal(
        readlinkSync(path.join(home, ".local/bin/gotchibot")),
        path.join(root, "scripts/gotchibot"),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
