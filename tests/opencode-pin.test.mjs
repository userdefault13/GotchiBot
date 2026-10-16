import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  OPENCODE_DEFAULT_VERSION, opencodeVersion, opencodeInstallShell, opencodeGuardShell, assertOpencode1x,
} from "../scripts/opencode-pin.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

describe("opencode pin", () => {
  it("defaults to 1.19.0 and honours GOTCHIBOT_OPENCODE_VERSION", () => {
    assert.equal(OPENCODE_DEFAULT_VERSION, "1.19.0");
    assert.equal(opencodeVersion({}), "1.19.0");
    assert.equal(opencodeVersion({ GOTCHIBOT_OPENCODE_VERSION: "v1.18.35" }), "1.18.35");
    assert.throws(() => opencodeVersion({ GOTCHIBOT_OPENCODE_VERSION: "2.0.0" }), /not supported/);
    assert.throws(() => opencodeVersion({ GOTCHIBOT_OPENCODE_VERSION: "1.0; rm -rf /" }), /x\.y\.z/);
  });
  it("installs with --version and guards the binary", () => {
    const s = opencodeInstallShell("1.19.0");
    assert.match(s, /opencode\.ai\/install \| HOME=\/root bash -s -- --version "1\.19\.0"/);
    assert.match(s, /unsupported \(need 1\.x\)/);
  });
  it("assertOpencode1x rejects 2.x", () => {
    assert.equal(assertOpencode1x("1.19.0\n"), "1.19.0");
    assert.throws(() => assertOpencode1x("2.0.1"), /unsupported/);
    assert.throws(() => assertOpencode1x(""), /could not read/);
  });
  for (const [ver, ok] of [["1.19.0", true], ["2.0.0", false], ["10.1.0", false], ["", false]]) {
    it(`shell guard ${ok ? "passes" : "fails"} on '${ver}'`, () => {
      const r2 = spawnSync("sh", ["-c", `oc() { printf '%s\\n' '${ver}'; }; ${opencodeGuardShell("oc")}`]);
      assert.equal(r2.status === 0, ok);
    });
  }
  it("desk-vm, gotchibot-vm and the sandbox Dockerfile use the pin", () => {
    for (const f of ["scripts/desk-vm.mjs", "scripts/gotchibot-vm.mjs"]) {
      const src = read(f);
      assert.match(src, /opencodeInstallShell\(opencodeVersion\(\)\)/);
      assert.doesNotMatch(src, /opencode\.ai\/install \| HOME=\/root bash\n/);
    }
    const df = read("docker/sandbox/Dockerfile");
    assert.match(df, /ARG OPENCODE_VERSION=1\.19\.0/);
    assert.match(df, /VERSION="\$\{OPENCODE_VERSION\}" bash/);
    assert.doesNotMatch(df, /\|\| true/);
  });
});
