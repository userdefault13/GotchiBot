/**
 * macOS / SSH platform guards — SLICE 5.
 *   node --test tests/platform-guard.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isDarwin,
  isOverSsh,
  macGuiAvailable,
  skipNote,
} from "../scripts/lib/platform-guard.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("isOverSsh", () => {
  it("true when SSH_TTY set", () => {
    assert.equal(isOverSsh({ SSH_TTY: "/dev/pts/9" }), true);
  });

  it("true when SSH_CONNECTION set", () => {
    assert.equal(isOverSsh({ SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 22" }), true);
  });

  it("false when neither", () => {
    assert.equal(isOverSsh({}), false);
    assert.equal(isOverSsh({ TERM: "xterm-256color" }), false);
  });
});

describe("macGuiAvailable", () => {
  it("GOTCHIBOT_MAC_GUI=1 / GOTCHIBOT_ON_IMAC=1 allow the Mac screen over SSH (desk-terminals --host imac)", () => {
    assert.equal(macGuiAvailable({ SSH_CONNECTION: "1 2 3 4", GOTCHIBOT_MAC_GUI: "1" }, "darwin"), true);
    assert.equal(macGuiAvailable({ SSH_TTY: "/dev/pts/9", GOTCHIBOT_ON_IMAC: "1" }, "darwin"), true);
    assert.equal(macGuiAvailable({ GOTCHIBOT_MAC_GUI: "1" }, "linux"), false);
  });

  it("true on local darwin", () => {
    assert.equal(macGuiAvailable({}, "darwin"), true);
  });

  it("false on darwin over SSH_TTY", () => {
    assert.equal(macGuiAvailable({ SSH_TTY: "/dev/pts/9" }, "darwin"), false);
  });

  it("false on darwin over SSH_CONNECTION", () => {
    assert.equal(macGuiAvailable({ SSH_CONNECTION: "1 2 3 4" }, "darwin"), false);
  });

  it("false on linux even without SSH", () => {
    assert.equal(macGuiAvailable({}, "linux"), false);
  });

  it("false on linux over SSH", () => {
    assert.equal(macGuiAvailable({ SSH_TTY: "/dev/pts/1" }, "linux"), false);
  });
});

describe("isDarwin", () => {
  it("accepts platform override", () => {
    assert.equal(isDarwin("darwin"), true);
    assert.equal(isDarwin("linux"), false);
    assert.equal(isDarwin("win32"), false);
  });
});

describe("skipNote", () => {
  it("writes gotchibot skip line to stderr", () => {
    const r = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { skipNote } from ${JSON.stringify(path.join(root, "scripts/lib/platform-guard.mjs"))}; skipNote("SwiftBar", "macOS only");`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /gotchibot: SwiftBar skipped \(macOS only\)/);
  });
});

describe("clipboard-copy over SSH", () => {
  it("exits 0 with ok osc52 and no pbcopy", () => {
    const r = spawnSync(process.execPath, [path.join(root, "scripts/clipboard-copy.mjs")], {
      encoding: "utf8",
      input: "slice5-clipboard-test",
      env: {
        ...process.env,
        SSH_TTY: "/dev/pts/9",
      },
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    // OSC 52 is written to stdout before the status line — strip BEL/OSC for the assert.
    const status = r.stdout.replace(/\x1b\]52;[^\x07]*\x07/g, "");
    assert.match(status, /^ok osc52 \(\d+ chars\)\n?$/m);
    assert.doesNotMatch(status, /pbcopy/);
  });
});

describe("bash -n edited shell scripts", () => {
  for (const rel of [
    "scripts/gotchibot",
    "scripts/agent-desktop-terminal.sh",
    "scripts/infra-desktop-terminal.sh",
  ]) {
    it(`bash -n ${rel}`, () => {
      execFileSync("bash", ["-n", path.join(root, rel)], { encoding: "utf8" });
    });
  }
});

describe("agent-desktop-terminal.sh over SSH", () => {
  it("exits 0 without calling osascript", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gotchibot-osascript-"));
    const marker = path.join(dir, "osascript-called");
    try {
      const script = path.join(dir, "osascript");
      writeFileSync(script, `#!/bin/bash\nprintf 'called\\n' > "${marker}"\n`);
      execFileSync("chmod", ["+x", script]);

      const r = spawnSync(
        "bash",
        [path.join(root, "scripts/agent-desktop-terminal.sh"), "--window", "test-win"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 22",
            GOTCHIBOT_TMUX_SESSION: "gotchibot-test-slice5",
          },
        },
      );
      assert.equal(r.status, 0, r.stderr || r.stdout);
      assert.match(r.stderr, /Terminal\.app window skipped/);
      assert.equal(existsSync(marker), false, "fake osascript must not run");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
