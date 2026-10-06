/**
 * `gotchibot` started through a symlink (npm's global bin, ~/.local/bin, mise
 * shims) still finds the repo.
 *   node --test tests/gotchibot-symlink-root.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(repo, "scripts", "gotchibot");

describe("gotchibot via symlink", () => {
  it("resolves ROOT through absolute and relative (chained) links", (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), "gb-link-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(path.join(dir, "bin"));
    mkdirSync(path.join(dir, "other"));
    symlinkSync(bin, path.join(dir, "bin", "gotchibot"));
    symlinkSync("../bin/gotchibot", path.join(dir, "other", "gb"));
    for (const p of [path.join(dir, "bin", "gotchibot"), path.join(dir, "other", "gb")]) {
      const r = spawnSync(p, ["desk-tools", "status", "--json"], { cwd: tmpdir(), encoding: "utf8", timeout: 30_000 });
      assert.equal(r.status, 0, `${p}: ${r.stderr}`);
      assert.match(r.stdout, /"port":45690/);
    }
  });
});
