/**
 * Project switch → every pane follows (orchestrator-layout.sh project-sync).
 * Runs against an isolated tmux server (TMUX_TMPDIR), never the live desk.
 *   node --test tests/project-sync-panes.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hasTmux = spawnSync("tmux", ["-V"]).status === 0;

describe("project-sync", { skip: !hasTmux && "tmux not installed" }, () => {
  it("restarts Files, keeps a busy Terminal, and acts once per change", (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), "gb-psync-"));
    const env = { ...process.env, TMUX_TMPDIR: dir, TMUX: "", GOTCHIBOT_TMUX_SESSION: "gbtest" };
    const tmux = (...a) => spawnSync("tmux", a, { env, encoding: "utf8" });
    t.after(() => {
      tmux("kill-server");
      rmSync(dir, { recursive: true, force: true });
    });
    assert.equal(tmux("new-session", "-d", "-s", "gbtest", "-n", "work", "-x", "120", "-y", "30", "sleep 300 # mc-pane").status, 0);
    tmux("split-window", "-t", "gbtest:work", "sleep 300 # terminal-pane");
    const startCmd = (i) => tmux("display", "-p", "-t", `gbtest:work.${i}`, "#{pane_start_command}").stdout.trim();
    const sync = () => spawnSync("bash", [path.join(repo, "scripts", "orchestrator-layout.sh"), "project-sync"], { env, encoding: "utf8" });

    // First sight only records the project.
    assert.equal(sync().status, 0);
    const cur = readFileSync(path.join(repo, "sessions", ".project-current"), "utf8").trim();
    assert.equal(tmux("show-options", "-qv", "-t", "gbtest", "@gotchibot-project").stdout.trim(), cur);
    assert.match(startCmd(0), /sleep 300 # mc-pane/, "nothing restarted on first sight");

    // A switch (recorded project differs): Files restarts, a busy Terminal stays.
    tmux("set-option", "-t", "gbtest", "@gotchibot-project", "some-other-project");
    assert.equal(sync().status, 0);
    assert.match(startCmd(0), /exec \.\/scripts\/mc-pane\.sh/);
    assert.match(startCmd(1), /sleep 300 # terminal-pane/, "running command never killed");
    assert.equal(tmux("show-options", "-qv", "-t", "gbtest", "@gotchibot-project").stdout.trim(), cur);
  });

  it("setCurrentProject triggers it, Files and Terminal open on the project folder", () => {
    const ctx = readFileSync(path.join(repo, "scripts", "project-context.mjs"), "utf8");
    assert.match(ctx, /if \(!sessionsDir\) syncDeskPanes\(\);/);
    assert.match(ctx, /"orchestrator-layout\.sh"\), "project-sync"/);
    for (const f of ["mc-pane.sh", "terminal-pane.sh"]) {
      assert.match(readFileSync(path.join(repo, "scripts", f), "utf8"), /project_dir "\$ROOT"/, f);
    }
  });
});
