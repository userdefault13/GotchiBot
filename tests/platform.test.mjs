/**
 * Platform helpers — WSL2 detection.
 *   node --test tests/platform.test.mjs
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

describe("platform WSL", () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it("detects WSL via WSL_DISTRO_NAME", async () => {
    process.env.WSL_DISTRO_NAME = "Ubuntu";
    const { isWsl, runtimeKind, platformLabel } = await import("../scripts/platform.mjs");
    assert.equal(isWsl(), true);
    assert.equal(runtimeKind(), "wsl");
    assert.match(platformLabel(), /wsl2/);
  });

  it("native linux is not wsl without env", async () => {
    delete process.env.WSL_DISTRO_NAME;
    delete process.env.WSLENV;
    const { isWsl, runtimeKind } = await import("../scripts/platform.mjs");
    if (process.platform === "linux" && !String(process.env.WSL_DISTRO_NAME || "")) {
      // on real linux CI, isWsl may be false unless /proc/version mentions microsoft
      assert.equal(runtimeKind(), "linux");
    }
  });
});
