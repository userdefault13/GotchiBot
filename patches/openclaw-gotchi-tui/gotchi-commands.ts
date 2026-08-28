// GotchiBot TUI slash commands — shells out to scripts/agent-focus.mjs in the workspace.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type GotchiFocusRunResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
  root: string | null;
};

export function resolveGotchiBotRoot(): string | null {
  const fromEnv = process.env.GOTCHIBOT_ROOT?.trim();
  if (fromEnv && existsSync(join(fromEnv, "scripts/agent-focus.mjs"))) {
    return fromEnv;
  }
  const fromCwd = process.cwd();
  if (existsSync(join(fromCwd, "scripts/agent-focus.mjs"))) {
    return fromCwd;
  }
  return null;
}

export function isGotchiBotEnabled(): boolean {
  return resolveGotchiBotRoot() !== null;
}

export function runGotchiFocus(args: readonly string[]): GotchiFocusRunResult {
  const root = resolveGotchiBotRoot();
  if (!root) {
    return {
      ok: false,
      stdout: "",
      stderr: "GotchiBot workspace not found (set GOTCHIBOT_ROOT or run from repo root)",
      status: 1,
      root: null,
    };
  }
  const script = join(root, "scripts/agent-focus.mjs");
  const env = { ...process.env, GOTCHIBOT_ROOT: root };
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
    root,
  };
}

/** Whether agent-focus will respawn the tmux chat pane (orch / switch with target). */
export function gotchiFocusRespawnsChatPane(args: readonly string[]): boolean {
  const cmd = args[0];
  if (cmd === "orch" || cmd === "orchestrator") {
    return true;
  }
  if (cmd === "switch" && args.length > 1 && args[1]?.trim()) {
    return true;
  }
  return false;
}

export function readGotchiOpenClawAgentId(root: string): string | null {
  try {
    const focus = JSON.parse(readFileSync(join(root, "sessions/.focus.json"), "utf8")) as {
      openclawAgentId?: string;
      heroId?: string;
    };
    const id = focus.openclawAgentId || focus.heroId;
    return id ? String(id) : null;
  } catch {
    return null;
  }
}

export function formatGotchiFocusOutput(result: GotchiFocusRunResult): string[] {
  const lines: string[] = [];
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  if (stdout) {
    lines.push(...stdout.split("\n"));
  }
  if (stderr) {
    lines.push(...stderr.split("\n"));
  }
  if (!lines.length) {
    lines.push(result.ok ? "ok" : "gotchi command failed");
  }
  return lines;
}
