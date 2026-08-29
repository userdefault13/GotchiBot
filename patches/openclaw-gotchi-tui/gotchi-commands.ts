// GotchiBot TUI slash commands — shells out to scripts/agent-focus.mjs in the workspace.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type GotchiFocusRunResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
  root: string | null;
  timedOut?: boolean;
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

export function gotchiFocusTimeoutMs(args: readonly string[]): number {
  const cmd = args[0];
  if (cmd === "list" || (cmd === "switch" && args.length === 1)) {
    return 20_000;
  }
  if (cmd === "cockpit" || cmd === "onboarding") {
    return 8_000;
  }
  if (cmd === "orch" || cmd === "orchestrator") {
    return 30_000;
  }
  if (cmd === "switch") {
    return 45_000;
  }
  return 30_000;
}

function collectSpawnResult(
  result: {
    status: number | null;
    stdout: string;
    stderr: string;
    signal: NodeJS.Signals | null;
  },
  root: string,
  timedOut = false,
): GotchiFocusRunResult {
  return {
    ok: result.status === 0 && !timedOut,
    stdout: result.stdout ?? "",
    stderr: timedOut
      ? [result.stderr, "gotchi command timed out — try again or use ./scripts/gotchibot switch"].filter(Boolean).join("\n")
      : (result.stderr ?? ""),
    status: result.status,
    root,
    timedOut,
  };
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
  const timeoutMs = gotchiFocusTimeoutMs(args);
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGTERM",
  });
  const timedOut = result.error != null && "code" in result.error && result.error.code === "ETIMEDOUT";
  return collectSpawnResult(result, root, timedOut);
}

export async function runGotchiFocusAsync(args: readonly string[]): Promise<GotchiFocusRunResult> {
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
  const timeoutMs = gotchiFocusTimeoutMs(args);

  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve(
        collectSpawnResult(
          { status, stdout, stderr, signal },
          root,
          timedOut,
        ),
      );
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        stdout,
        stderr: `${stderr}\n${err.message}`.trim(),
        status: 1,
        root,
        timedOut,
      });
    });
  });
}

/** Whether agent-focus will respawn the tmux chat pane (orch / switch with target). */
export function gotchiFocusRespawnsChatPane(args: readonly string[]): boolean {
  const cmd = args[0];
  if (cmd === "orch" || cmd === "orchestrator") {
    return true;
  }
  if (cmd === "cockpit" || cmd === "onboarding") {
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
