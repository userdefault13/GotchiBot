/**
 * Prompt modes — GotchiBot primaries load when OpenCode runs in another checkout.
 *   node --test tests/prompt-modes.test.mjs
 * Runs `opencode agent list` only; does not start the TUI or a server.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chatPane = path.join(root, "scripts/chat-pane.sh");
const configDir = path.join(root, ".opencode");

const GOTCHI_PRIMARIES = ["gotchi", "sandbox", "verse", "ask", "build", "plan"];
const HIDDEN_SYSTEM = ["compaction", "summary", "title"];

function hasOpencode() {
  return spawnSync("opencode", ["--version"], { stdio: "ignore" }).status === 0;
}

function listAgents(cwd) {
  // opencode exits before draining a stdout pipe, so capture through a file.
  const outFile = path.join(cwd, "agents.txt");
  const fd = openSync(outFile, "w");
  try {
    const res = spawnSync("opencode", ["agent", "list"], {
      cwd,
      env: { ...process.env, OPENCODE_CONFIG_DIR: configDir },
      stdio: ["ignore", fd, fd],
      timeout: 120_000,
    });
    assert.equal(res.status, 0, `opencode agent list exited ${res.status}`);
  } finally {
    closeSync(fd);
  }
  const agents = new Map();
  for (const line of readFileSync(outFile, "utf8").split("\n")) {
    const m = line.match(/^(\S+) \((primary|subagent|all)\)$/);
    if (m) agents.set(m[1], m[2]);
  }
  return agents;
}

describe("chat-pane.sh — OpenCode config dir", () => {
  it("exports OPENCODE_CONFIG_DIR to the GotchiBot .opencode directory", () => {
    const line = readFileSync(chatPane, "utf8")
      .split("\n")
      .find((l) => /^export OPENCODE_CONFIG_DIR=/.test(l));
    assert.ok(line, "chat-pane.sh must export OPENCODE_CONFIG_DIR");
    const value = execFileSync(
      "bash",
      ["-c", `ROOT="$1"; ${line}; printf %s "$OPENCODE_CONFIG_DIR"`, "_", root],
      { encoding: "utf8" },
    );
    assert.equal(value, configDir);
  });
});

describe("opencode agent list — from an unrelated directory", { skip: !hasOpencode() && "opencode not on PATH" }, () => {
  let agents;
  before(() => {
    const cwd = mkdtempSync(path.join(tmpdir(), "gotchibot-prompt-modes-"));
    try {
      agents = listAgents(cwd);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  for (const name of GOTCHI_PRIMARIES) {
    it(`${name} is primary`, () => {
      assert.equal(agents.get(name), "primary");
    });
  }

  it("has no unexpected primary agents", () => {
    const allowed = new Set([...GOTCHI_PRIMARIES, ...HIDDEN_SYSTEM]);
    const extra = [...agents]
      .filter(([name, mode]) => mode === "primary" && !allowed.has(name))
      .map(([name]) => name);
    assert.deepEqual(extra, []);
  });
});
