#!/usr/bin/env node
/**
 * OpenCode version pin. OpenCode 2.x breaks our plugins, the server API and tui.json,
 * so every install path pins GOTCHIBOT_OPENCODE_VERSION (default 1.19.0) and refuses 2.x.
 *
 *   node scripts/opencode-pin.mjs            # check the installed `opencode --version` (read-only)
 */
import { spawnSync } from "node:child_process";
import { isMainModule } from "./is-main.mjs";

export const OPENCODE_DEFAULT_VERSION = "1.19.0";
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function opencodeVersion(env = process.env) {
  const v = String(env.GOTCHIBOT_OPENCODE_VERSION || OPENCODE_DEFAULT_VERSION).trim().replace(/^v/, "");
  if (!SEMVER.test(v)) throw new Error(`GOTCHIBOT_OPENCODE_VERSION must be x.y.z, got ${JSON.stringify(v)}`);
  if (Number(v.split(".")[0]) >= 2) throw new Error(`OpenCode ${v} is not supported (2.x breaks GotchiBot); pin 1.x`);
  return v;
}

/** Shell lines: pinned install, then fail if the binary reports 2.x or newer. */
export function opencodeInstallShell(v = opencodeVersion(), { home = "/root" } = {}) {
  return [
    `curl -fsSL https://opencode.ai/install | HOME=${home} bash -s -- --version "${v}"`,
    opencodeGuardShell(`${home}/.opencode/bin/opencode`),
  ].join("\n");
}

export function opencodeGuardShell(bin = "opencode") {
  return `ocv=$(${bin} --version 2>/dev/null | grep -Eo '[0-9]+\\.[0-9]+\\.[0-9]+' | head -n1); case "$ocv" in ""|[2-9].*|[1-9][0-9]*.*) echo "[provision] opencode version '$ocv' unsupported (need 1.x)" >&2; exit 1;; esac`;
}

/** Throws if a version string is missing or 2.x+. */
export function assertOpencode1x(versionOutput) {
  const m = String(versionOutput || "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) throw new Error("could not read opencode --version");
  if (Number(m[1]) !== 1) throw new Error(`opencode ${m[0]} is unsupported; GotchiBot needs 1.x (pin ${OPENCODE_DEFAULT_VERSION})`);
  return m[0];
}

if (isMainModule(import.meta.url)) {
  const r = spawnSync("opencode", ["--version"], { encoding: "utf8" });
  try {
    console.log(`opencode ${assertOpencode1x(r.stdout)} ok`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
