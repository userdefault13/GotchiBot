/**
 * Pane switching: speed and resilience guards.
 *   node --test tests/layout-resilience.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const layout = read("scripts/orchestrator-layout.sh");
const fn = (name) => {
  const m = layout.match(new RegExp(`\\n${name}\\(\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(m, `${name} present`);
  return m[0];
};

describe("layout lock", () => {
  it("serializes layout changes and lets a newer focus request supersede a waiting one", () => {
    const lock = fn("layout_lock");
    assert.match(lock, /mkdir "\$LAYOUT_LOCK"/);
    assert.match(lock, /kill -0 "\$owner"/, "a dead holder's lock is taken over");
    assert.match(lock, /LAYOUT_WANT/);
    assert.match(layout, /trap layout_unlock EXIT\n/);
    assert.match(layout, /enter-cockpit\|boot-cockpit\|[^\n]*toggle-\*[^\n]*\)\n\s+layout_lock latest/);
  });

  it("releases the lock before re-dispatching itself through run-shell", () => {
    const reexec = fn("layout_safe_reexec");
    assert.ok(reexec.indexOf("layout_unlock") < reexec.indexOf("tmux run-shell"));
    const three = fn("require_three_panes");
    assert.ok(three.indexOf("layout_unlock") < three.indexOf("tmux run-shell"));
  });
});

describe("focus_desk cost", () => {
  it("reads panes from one list-panes cache and binds step keys once per server", () => {
    const focus = fn("focus_desk");
    assert.match(focus, /pane_cache_load/);
    assert.match(fn("pane_start_cmd"), /PANE_CACHE_OK/);
    const keys = fn("install_pane_step_keys");
    assert.match(keys, /@gotchibot-step-keys/);
    assert.match(layout, /install_pane_step_keys force/);
  });

  it("publishes pane borders in the background, once per run", () => {
    const borders = fn("refresh_desk_borders");
    assert.match(borders, /BORDERS_QUEUED/);
    assert.match(borders, /\) <\/dev\/null >\/dev\/null 2>&1 &/);
  });

  it("parks tool apps instead of killing them, and quits the park with the desk", () => {
    const slot = fn("place_slot");
    assert.match(slot, /unpark_slot_app/);
    assert.match(slot, /park_slot_app/);
    assert.match(fn("apps_park_session"), /gbapps-/);
    const quit = read("scripts/desk-quit.sh");
    assert.match(quit, /gbapps-\$sess/);
    assert.match(quit, /gbpark-\$sess/);
  });
});

describe("9-pane desk resilience", () => {
  it("never runs the 3-pane rebuild over the 9-pane desk", () => {
    assert.match(fn("start_pane_commands"), /nine_pane_desk[\s\S]*focus_desk/);
    assert.match(layout, /  refresh\)\n\s+if nine_pane_desk; then/);
    assert.match(layout, /  refresh-soft\)\n\s+if nine_pane_desk; then/);
    assert.match(read("scripts/chat-pane.sh"), /"\$\{count:-0\}" -ge 7/);
  });

  it("keeps dead panes in their slot and revives them from a pane-died hook", () => {
    const hook = fn("install_revive_hook");
    assert.match(hook, /remain-on-exit on/);
    assert.match(hook, /pane-died/);
    assert.match(layout, /  revive\)\n[\s\S]*?\.layout-revive/);
  });

  it("signals panes by what they run, never by slot index", () => {
    const chat = read("scripts/chat-pane.sh");
    assert.doesNotMatch(chat, /work\.2" '#\{pane_pid\}'/);
    assert.match(chat, /signal_desk_pane avatar-pane/);
    assert.doesNotMatch(read("scripts/poke-meet-channel.sh"), /-t "\$\{?sess\}?:work\.2"/);
  });

  it("restores IFS in the avatar pane's signal handlers", () => {
    const avatar = read("scripts/avatar-pane.sh");
    assert.match(avatar, /on_usr1\(\) \{\n[\s\S]*?local IFS=\$' \\t\\n'/);
    assert.match(avatar, /trap on_winch WINCH/);
    assert.match(avatar, /memo_reset\(\) \{\n[\s\S]*?local v IFS=/);
  });

  it("scripts parse", () => {
    for (const f of ["orchestrator-layout.sh", "avatar-pane.sh", "chat-pane.sh", "poke-meet-channel.sh", "desk-quit.sh"]) {
      execFileSync("bash", ["-n", path.join(root, "scripts", f)]);
    }
  });
});

describe("avatar selector from other panes", () => {
  it("wakes the avatar with a key (read returns at once), not only USR1", () => {
    const avatar = read("scripts/avatar-pane.sh");
    const wake = avatar.match(/\nsb_click_wake\(\) \{[\s\S]*?\n\}/)[0];
    assert.match(wake, /tmux send-keys -t "\$pane" C-\]/);
    assert.match(avatar, /\[ "\$key" = \$'\\x1d' \] && return 0/);
  });
});

describe("kanban Enter", () => {
  it("opens a meet chat for gotchis and keeps the OpenCode chat for the orchestrator", () => {
    const src = read("scripts/gotchi-kanban.mjs");
    const start = src.indexOf('if (key.name === "return" || key.name === "enter")');
    const k = src.slice(start, src.indexOf("enterCardAction(card, {", start));
    assert.match(k, /heroId === orchId[\s\S]*?leaveKanbanPane\("leave-kanban-chat"\)/);
    assert.match(k, /"scripts\/gotchi-meet\.mjs"\), "chat", String\(heroId\)/);
    assert.match(k, /leaveKanbanPane\("toggle-meet"\)/);
    assert.doesNotMatch(k, /agent-focus\.mjs/, "Enter no longer re-seats the OpenCode chat");
  });
});

describe("chat recovery gate", () => {
  it("starts chat without waiting on Hub recovery", () => {
    const chat = read("scripts/chat-pane.sh");
    assert.doesNotMatch(chat, /hub-desk-recovery\.mjs" once/, "no wait before chat");
    assert.doesNotMatch(chat, /desk_recovery_gate/);
  });
});
