// Verifies GotchiBot TUI command helpers.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatGotchiFocusOutput,
  gotchiFocusRespawnsChatPane,
  isGotchiBotEnabled,
  resolveGotchiBotRoot,
} from "./gotchi-commands.js";

describe("gotchi-commands", () => {
  const priorRoot = process.env.GOTCHIBOT_ROOT;
  const priorCwd = process.cwd();
  let tempRoot: string | null = null;

  afterEach(() => {
    if (priorRoot === undefined) {
      delete process.env.GOTCHIBOT_ROOT;
    } else {
      process.env.GOTCHIBOT_ROOT = priorRoot;
    }
    if (tempRoot) {
      process.chdir(priorCwd);
      tempRoot = null;
    }
  });

  it("detects workspace from GOTCHIBOT_ROOT", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "gotchi-bot-"));
    mkdirSync(join(tempRoot, "scripts"), { recursive: true });
    writeFileSync(join(tempRoot, "scripts/agent-focus.mjs"), "// stub\n");
    process.env.GOTCHIBOT_ROOT = tempRoot;
    expect(isGotchiBotEnabled()).toBe(true);
    expect(resolveGotchiBotRoot()).toBe(tempRoot);
  });

  it("knows when focus changes respawn the chat pane", () => {
    expect(gotchiFocusRespawnsChatPane(["orch"])).toBe(true);
    expect(gotchiFocusRespawnsChatPane(["switch", "2"])).toBe(true);
    expect(gotchiFocusRespawnsChatPane(["switch"])).toBe(false);
    expect(gotchiFocusRespawnsChatPane(["list"])).toBe(false);
  });

  it("formats stdout and stderr for chat display", () => {
    const lines = formatGotchiFocusOutput({
      ok: true,
      stdout: "Focus: ORCH",
      stderr: "",
      status: 0,
      root: "/tmp/gotchi",
    });
    expect(lines).toEqual(["Focus: ORCH"]);
  });
});
