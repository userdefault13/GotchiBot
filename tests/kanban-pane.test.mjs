/**
 * Kanban desk pane — own tmux pane, cockpit menu is not replaced.
 *   node --test tests/kanban-pane.test.mjs
 * Does not start tmux.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { kindLabel } from "../scripts/desk-active.mjs";
import { LAYOUT_CMDS } from "../scripts/tmux-layout.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  return readFileSync(path.join(root, rel), "utf8");
}

describe("kanban desk pane", () => {
  it("is pane 8 and opens without taking the cockpit pane", () => {
    const layout = read("scripts/orchestrator-layout.sh");
    assert.match(layout, /DESK_PANE_COUNT=10/);
    assert.match(layout, /kanban\) echo 8/);
    assert.match(layout, /enter-kanban\|kanban\)/);
    assert.match(layout, /toggle-kanban\)/);
    assert.match(layout, /leave-kanban\)/);
    assert.match(layout, /label-bar-pane\.sh Kanban/);
    assert.match(layout, /exec \.\/scripts\/kanban-pane\.sh/);
    assert.match(layout, /bind-key -T prefix B/);
    assert.doesNotMatch(layout, /set-option -g mouse on|set-option mouse on/);
    const gate = read("scripts/onboarding-gate.mjs");
    assert.match(gate, /function enterKanbanLayout\(/);
    assert.match(gate, /runLayout\("enter-kanban"/);
    assert.match(gate, /if \(enterKanbanLayout\(\)\)/);
    const pane = read("scripts/kanban-pane.sh");
    assert.match(pane, /GOTCHIBOT_KANBAN_PANE=1/);
    assert.match(pane, /gotchi-kanban\.mjs" --tui/);
    assert.equal(kindLabel("./scripts/kanban-pane.sh", "kanban", "gotchibot"), "Kanban");
    assert.equal(kindLabel("./scripts/label-bar-pane.sh Kanban", "chat", "gotchibot"), "Kanban");
    for (const cmd of ["enter-kanban", "kanban", "toggle-kanban", "leave-kanban", "leave-kanban-chat"]) {
      assert.equal(LAYOUT_CMDS.has(cmd), true, cmd);
    }
  });

  it("focuses kanban at 106 columns and leaves the cockpit bar at 3", () => {
    const out = execFileSync("bash", ["scripts/orchestrator-layout.sh", "sizes", "163", "kanban"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, TMUX: "", TMUX_PANE: "", TERM: "xterm-256color" },
    }).trim();
    const got = Object.fromEntries(out.split(/\s+/).map((part) => part.split("=")));
    assert.equal(got.kanban, "106");
    assert.equal(got.cockpit, "3");
    assert.equal(got.chat, "3");
    assert.equal(got.factory, "3");
    assert.equal(got.dossier, "3");
    assert.equal(got.inbox, "3");
    assert.equal(got.meet, "3");
    assert.equal(got.files, "3");
    assert.equal(got.avatar, "24");
    assert.equal(got.sum, "154");
    const chat = execFileSync("bash", ["scripts/orchestrator-layout.sh", "sizes", "163", "chat"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, TMUX: "", TMUX_PANE: "", TERM: "xterm-256color" },
    }).trim();
    const chatGot = Object.fromEntries(chat.split(/\s+/).map((part) => part.split("=")));
    assert.equal(chatGot.chat, got.kanban);
    assert.equal(chatGot.kanban, "3");
    assert.equal(chatGot.avatar, "24");
  });

  it("bash -n kanban pane and layout", () => {
    execFileSync("bash", ["-n", path.join(root, "scripts/kanban-pane.sh")]);
    execFileSync("bash", ["-n", path.join(root, "scripts/orchestrator-layout.sh")]);
  });

  it("draws seat avatars as the mini roster head, not the tall thumb", () => {
    const src = read("scripts/gotchi-kanban.mjs");
    assert.match(src, /import \{ renderMiniAscii \}/);
    assert.match(src, /const KANBAN_ART_W = 9/);
    assert.match(src, /renderMiniAscii\(colors/);
    assert.doesNotMatch(src, /renderKanbanAscii/);
  });

});
