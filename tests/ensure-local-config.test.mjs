/**
 * ensure-local-config — seed local config from .example (never overwrite).
 *   node --test tests/ensure-local-config.test.mjs
 */
import { describe, it, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ROOT } from "../scripts/ensure-local-config.mjs";

describe("ensureLocalConfig", () => {
  const envBackup = { ...process.env };
  const tmp = mkdtempSync(join(tmpdir(), "gotchibot-ensure-test-"));
  const root = resolve(tmp);

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it("seeds all three configs + sessions/ from examples, then no-ops", async () => {
    mkdirSync(join(root, "config"), { recursive: true });
    for (const ex of [
      "hub-bridge.json.example",
      "aseprite.json.example",
      "openclaw.install.json5.example",
    ]) {
      writeFileSync(join(root, "config", ex), readFileSync(join(ROOT, "config", ex), "utf8"));
    }

    const { ensureLocalConfig } = await import("../scripts/ensure-local-config.mjs");
    const r = ensureLocalConfig(root, { quiet: true });

    assert.deepEqual(
      [...r.created].sort(),
      [
        join(root, "config", "aseprite.json"),
        join(root, "config", "hub-bridge.json"),
        join(root, "config", "openclaw.install.json5"),
      ].sort(),
    );
    assert.equal(r.skipped.length, 0);
    assert.equal(existsSync(join(root, "sessions")), true);

    // ROOT/ path segments replaced with the absolute root
    const install = readFileSync(join(root, "config", "openclaw.install.json5"), "utf8");
    assert.ok(install.includes(`${root}/config/openclaw.gotchi.json5`));
    assert.ok(!/\bROOT\//.test(install));

    // second run: everything skipped, nothing overwritten
    const r2 = ensureLocalConfig(root, { quiet: true });
    assert.equal(r2.created.length, 0);
    assert.equal(r2.skipped.length, 3);
    assert.equal(r2.hubHostSet, false);
  });

  it("sets hub host from GOTCHIBOT_HUB_HOST when creating", async () => {
    const tmp2 = mkdtempSync(join(tmpdir(), "gotchibot-ensure-test2-"));
    const root2 = resolve(tmp2);
    mkdirSync(join(root2, "config"), { recursive: true });
    writeFileSync(
      join(root2, "config", "hub-bridge.json.example"),
      readFileSync(join(ROOT, "config", "hub-bridge.json.example"), "utf8"),
    );
    process.env.GOTCHIBOT_HUB_HOST = "my-hub.tailnet";
    const { ensureLocalConfig } = await import("../scripts/ensure-local-config.mjs");
    const r = ensureLocalConfig(root2, { quiet: true });
    assert.equal(r.hubHostSet, true);
    const cfg = JSON.parse(readFileSync(join(root2, "config", "hub-bridge.json"), "utf8"));
    assert.equal(cfg.host, "my-hub.tailnet");
    rmSync(tmp2, { recursive: true, force: true });
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
});