/**
 * launchd-job.mjs — one way to install, inspect and remove a per-user launchd
 * job on the host this runs on. Every hero schedule (LINK's trader cycle, YFI's
 * infra supervisor) goes through here, so "is it scheduled?" has one answer.
 *
 * The plist is rendered at install time with THIS host's node path and HOME;
 * a committed plist that hard-codes /usr/local/bin/node is wrong on a desk
 * where node lives under nvm.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

export const AGENTS_DIR = join(homedir(), "Library", "LaunchAgents");
const sh = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" });
const uid = () => userInfo().uid;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function plistPath(label) {
  return join(AGENTS_DIR, `${label}.plist`);
}

export function renderPlist({ label, program, args = [], cwd, intervalSec, logDir, env = {} }) {
  const node = process.execPath;
  const path = `${dirname(node)}:/usr/local/bin:/opt/homebrew/bin:${homedir()}/.local/bin:/usr/bin:/bin`;
  const prog = program || node;
  const envAll = { PATH: path, HOME: homedir(), ...env };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(label)}</string>
  <key>ProgramArguments</key>
  <array>
${[prog, ...args].map((a) => `    <string>${esc(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key><string>${esc(cwd)}</string>
  <key>StartInterval</key><integer>${Number(intervalSec)}</integer>
  <key>RunAtLoad</key><false/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>${esc(join(logDir, `${label}.out.log`))}</string>
  <key>StandardErrorPath</key><string>${esc(join(logDir, `${label}.err.log`))}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(envAll).map(([k, v]) => `    <key>${esc(k)}</key><string>${esc(v)}</string>`).join("\n")}
  </dict>
</dict>
</plist>
`;
}

/** null when not loaded; else { runs, lastExit } from `launchctl print`. */
export function loaded(label) {
  const r = sh("launchctl", ["print", `gui/${uid()}/${label}`]);
  if (r.status !== 0) return null;
  return {
    lastExit: r.stdout.match(/last exit code = (\S+)/)?.[1] ?? null,
    runs: (() => {
      const m = r.stdout.match(/runs = (\d+)/);
      return m ? Number(m[1]) : null;
    })(),
  };
}

export function install(spec) {
  const path = plistPath(spec.label);
  mkdirSync(AGENTS_DIR, { recursive: true });
  mkdirSync(spec.logDir, { recursive: true });
  const body = renderPlist(spec);
  const changed = !existsSync(path) || readFileSync(path, "utf8") !== body;
  if (changed) writeFileSync(path, body);
  if (loaded(spec.label)) sh("launchctl", ["bootout", `gui/${uid()}/${spec.label}`]);
  let r = sh("launchctl", ["bootstrap", `gui/${uid()}`, path]);
  if (r.status !== 0) r = sh("launchctl", ["load", "-w", path]);
  if (r.status !== 0) throw new Error(`launchctl failed: ${(r.stderr || r.stdout).trim()}`);
  return { path, changed, node: process.execPath };
}

export function uninstall(label) {
  const path = plistPath(label);
  if (loaded(label)) sh("launchctl", ["bootout", `gui/${uid()}/${label}`]);
  if (existsSync(path)) unlinkSync(path);
}

export function kickstart(label) {
  if (!loaded(label)) throw new Error("not loaded — run install first");
  const r = sh("launchctl", ["kickstart", `gui/${uid()}/${label}`]);
  if (r.status !== 0) throw new Error(`kickstart failed: ${(r.stderr || r.stdout).trim()}`);
}
