/**
 * Launch update check must not stall when git fetch never answers.
 *   node --test tests/update-check-git-timeout.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cachePath = path.join(root, "sessions", ".update-cache.json");
const realGit = spawnSync("bash", ["-lc", "command -v git"], { encoding: "utf8" }).stdout.trim();

function withoutCache(fn) {
  const had = existsSync(cachePath);
  const prev = had ? readFileSync(cachePath) : null;
  if (had) rmSync(cachePath);
  try {
    return fn();
  } finally {
    if (had) writeFileSync(cachePath, prev);
    else rmSync(cachePath, { force: true });
  }
}

function gitStub(dir) {
  const script = `#!/bin/bash
args="$*"
printf '%s\\n' "$args" >> "${dir}/git-args"
case " $args " in
  *" fetch "*|*" pull "*)
    printf 'GIT_TERMINAL_PROMPT=%s\\n' "\${GIT_TERMINAL_PROMPT-}" > "${dir}/git-env"
    printf 'GCM_INTERACTIVE=%s\\n' "\${GCM_INTERACTIVE-}" >> "${dir}/git-env"
    printf 'GIT_ASKPASS=%s\\n' "\${GIT_ASKPASS-}" >> "${dir}/git-env"
    if [ "\${STUB_GIT_MODE:-hang}" = "hang" ]; then
      exec sleep 120
    fi
    exit 0
    ;;
esac
if [ "$1" = "rev-list" ]; then
  printf '4\\n'
  exit 0
fi
exec ${JSON.stringify(realGit)} "$@"
`;
  const bin = path.join(dir, "git");
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return bin;
}

function runCheck(dir, mode, args) {
  const env = {
    ...process.env,
    PATH: `${dir}${path.delimiter}${process.env.PATH || ""}`,
    STUB_GIT_MODE: mode,
    GOTCHIBOT_GIT_TIMEOUT_MS: "1500",
    GOTCHIBOT_CDN_LATEST: "http://127.0.0.1:9/latest.json",
    GOTCHIBOT_WWW_LATEST: "http://127.0.0.1:9/latest.json",
    GOTCHIBOT_GITHUB_LATEST: "http://127.0.0.1:9/latest.json",
  };
  delete env.GOTCHIBOT_SKIP_UPDATE_CHECK;
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(root, "scripts/update-check.mjs"), ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 12000,
  });
  return { ...r, elapsed: Date.now() - started };
}

describe("update-check git network", () => {
  it("a non-responding git fetch does not hang the launch check", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gb-upd-"));
    try {
      gitStub(dir);
      const r = withoutCache(() => runCheck(dir, "hang", ["--launch"]));
      assert.equal(r.status, 0, `status ${r.status} signal ${r.signal} stderr ${r.stderr}`);
      assert.ok(r.elapsed < 7000, `launch check hung for ${r.elapsed}ms`);
      const recorded = readFileSync(path.join(dir, "git-env"), "utf8");
      assert.match(recorded, /GIT_TERMINAL_PROMPT=0/);
      assert.match(recorded, /GCM_INTERACTIVE=never/);
      assert.match(readFileSync(path.join(dir, "git-args"), "utf8"), /fetch/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a fetch that answers still reports commits behind", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gb-upd-"));
    try {
      gitStub(dir);
      const r = withoutCache(() => runCheck(dir, "ok", ["--check"]));
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /4 commit\(s\) behind/);
      assert.ok(r.elapsed < 7000, `check took ${r.elapsed}ms`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
