#!/usr/bin/env node
/**
 * Cross-platform helpers for GotchiBot (macOS, Linux, Windows, WSL2).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

export const GOTCHIBOT_ABRA_PROJECT = "gotchibot";
export const WSL_DOC = "docs/SOLO-LINUX-WINDOWS.md#wsl2";

/** True when running inside WSL2 (Linux kernel under Windows). */
export function isWsl() {
  if (process.env.WSL_DISTRO_NAME || process.env.WSLENV) return true;
  if (process.platform !== "linux") return false;
  try {
    return readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

/** Native Windows Node (PowerShell / cmd) — not WSL. */
export function isNativeWindows() {
  return process.platform === "win32";
}

/** darwin | linux | win32 | wsl */
export function runtimeKind() {
  if (isWsl()) return "wsl";
  return process.platform;
}

export function commandExists(cmd) {
  if (process.platform === "win32") {
    return spawnSync("where", [cmd], { shell: true, stdio: "ignore" }).status === 0;
  }
  return spawnSync("sh", ["-c", `command -v ${JSON.stringify(cmd)}`], {
    stdio: "ignore",
  }).status === 0;
}

export function platformLabel() {
  const arch = process.arch;
  const kind = runtimeKind();
  if (kind === "wsl") {
    const distro = process.env.WSL_DISTRO_NAME || "linux";
    return `wsl2 ${arch} (${distro})`;
  }
  return `${process.platform} ${arch}`;
}

export function tmuxInstallHint() {
  const kind = runtimeKind();
  switch (kind) {
    case "darwin":
      return "brew install tmux";
    case "linux":
    case "wsl":
      return "sudo apt install tmux   # or your distro package manager";
    case "win32":
      return "use WSL2 — see: gotchibot wsl   # native Windows: headless only (abra run gotchibot -- …)";
    default:
      return "install tmux for your OS";
  }
}

export function abraInstallHint() {
  const base = "npm install -g @userdefault/abracadabra";
  const kind = runtimeKind();
  if (kind === "linux" || kind === "wsl") {
    return `${base}   # Debian/Ubuntu first: sudo apt install libsecret-1-dev build-essential`;
  }
  if (kind === "win32") {
    return `${base}   # native Windows, or install inside WSL2 (recommended — gotchibot wsl)`;
  }
  return base;
}

export function wslQuickStartLines() {
  return [
    "WSL2 quick start (Windows → full GotchiBot + tmux cockpit):",
    "",
    "  1. PowerShell (Admin):  wsl --install -d Ubuntu",
    "  2. Open Ubuntu from Start — do all GotchiBot steps inside WSL, not PowerShell",
    "  3. sudo apt update && sudo apt install -y build-essential libsecret-1-dev tmux",
    "  4. Install Node 20+ in WSL: https://nodejs.org or nvm",
    "  5. npm install -g @userdefault/abracadabra @userdefault/gotchibot",
    "  6. abra doctor && gotchibot onboard && gotchibot tmux",
    "",
    "Keep the repo under ~/Dev (WSL home), not /mnt/c/… — faster and fewer path bugs.",
    "abra vault in WSL is separate from native Windows abra.",
    `Full guide: ${WSL_DOC}`,
  ];
}

export function resolveCastBin() {
  if (process.env.CAST_BIN) return process.env.CAST_BIN;
  const candidates = [
    `${homedir()}/.foundry/bin/cast`,
    "/usr/local/bin/cast",
    "cast",
  ];
  for (const c of candidates) {
    if (c === "cast" && commandExists("cast")) return "cast";
    if (c !== "cast" && existsSync(c)) return c;
  }
  return "cast";
}

export function hasAbra() {
  return commandExists("abra");
}

/** Run `abra doctor`; returns { ok, stdout, stderr }. */
export function runAbraDoctor() {
  if (!hasAbra()) {
    return { ok: false, stdout: "", stderr: "abra not on PATH" };
  }
  const r = spawnSync("abra", ["doctor"], { encoding: "utf8" });
  return { ok: r.status === 0, stdout: r.stdout || "", stderr: r.stderr || "" };
}

/**
 * Run a Node script with secrets injected via `abra run gotchibot`.
 * Skips abra when SSH_PRIVATE_KEY is set (operator / fleet path).
 */
export function runNodeWithAbra(scriptPath, args = [], opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const stdio = opts.stdio ?? "inherit";
  const encoding = opts.encoding ?? "utf8";
  if (process.env.SSH_PRIVATE_KEY || !hasAbra()) {
    return spawnSync(process.execPath, [scriptPath, ...args], { cwd, stdio, encoding });
  }
  return spawnSync("abra", ["run", GOTCHIBOT_ABRA_PROJECT, "--", "node", scriptPath, ...args], {
    cwd,
    stdio,
    encoding,
  });
}

export function saveSecretToAbra(key, value, { project = GOTCHIBOT_ABRA_PROJECT } = {}) {
  if (!hasAbra()) {
    console.error(`\nabracadabra required — ${abraInstallHint()}`);
    return false;
  }
  const r = spawnSync("abra", ["set", project, key, "--stdin"], {
    input: value,
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (r.status !== 0) {
    console.error(`\nCould not save ${key} to abra — run: abra doctor`);
    if (process.platform === "linux" || isWsl()) {
      console.error("  Linux/WSL: sudo apt install libsecret-1-dev && npm rebuild keytar -g");
      console.error("  Or: export ABRA_KEYSTORE=passphrase-file && abra unlock");
    }
    return false;
  }
  return true;
}
