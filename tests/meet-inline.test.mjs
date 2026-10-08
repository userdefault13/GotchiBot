/**
 * Inline meet room (--inline) — SLICE 4.
 *   node --test tests/meet-inline.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  inlineLayout,
  MEET_SIDEBAR_COLS,
  SIDEBAR_CARD_ROWS,
  renderInlineFrame,
  renderMeetSidebar,
} from "../scripts/meet-room-prompter.mjs";
import { renderMeetChannel } from "../scripts/meet-channel.mjs";
import { resolveMeetingsRoot } from "../scripts/project-context.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const meetCli = path.join(root, "scripts/gotchi-meet.mjs");
const currentPtr = path.join(root, "sessions/meetings/.current");

function meetingPointerExists() {
  try {
    const scoped = path.join(resolveMeetingsRoot().root, ".current");
    if (existsSync(scoped)) return true;
  } catch {
    /* fall through */
  }
  return existsSync(currentPtr);
}

describe("inlineLayout", () => {
  it("80x24: strip + transcript + pad + 6-row input + footer + pad", () => {
    const L = inlineLayout(80, 24);
    assert.equal(L.cols, 80);
    assert.equal(L.rows, 24);
    assert.equal(L.stripRow, 1);
    assert.equal(L.transcriptTop, 2);
    assert.equal(L.promptRows, 7);
    assert.equal(L.inputRows, 6);
    assert.equal(L.padY, 1);
    assert.equal(L.promptTop, 17);
    assert.equal(L.transcriptRows, 14);
    assert.equal(L.stripRow + L.transcriptRows + L.promptRows + L.padY * 2, 24);
  });

  it("120x40: scales transcript", () => {
    const L = inlineLayout(120, 40);
    assert.equal(L.cols, 120);
    assert.equal(L.promptRows, 7);
    assert.equal(L.promptTop, 33);
    assert.equal(L.transcriptTop, 2);
    assert.equal(L.transcriptRows, 30);
    assert.equal(L.stripRow + L.transcriptRows + L.promptRows + L.padY * 2, 40);
  });

  it("40x12: drops the padding and keeps the transcript", () => {
    const L = inlineLayout(40, 12);
    assert.equal(L.cols, 40);
    assert.equal(L.padY, 0);
    assert.equal(L.promptRows, 7);
    assert.equal(L.promptTop, 6);
    assert.equal(L.transcriptTop, 2);
    assert.equal(L.transcriptRows, 4);
    assert.ok(L.transcriptRows >= 1);
    assert.equal(L.stripRow + L.transcriptRows + L.promptRows, 12);
  });

  it("tiny height still returns positive regions", () => {
    const L = inlineLayout(40, 5);
    assert.ok(L.promptRows >= 1);
    assert.ok(L.inputRows >= 1);
    assert.ok(L.transcriptRows >= 1);
    assert.ok(L.promptTop >= 1);
    assert.ok(L.transcriptTop >= 1);
  });
});

describe("renderInlineFrame", () => {
  it("returns a non-empty multi-line string", () => {
    const frame = renderInlineFrame({
      cols: 80,
      rows: 24,
      meeting: { topic: "test", participants: [] },
      scrollFromBottom: 0,
    });
    assert.equal(typeof frame, "string");
    assert.ok(frame.includes("\n"));
    assert.ok(frame.length > 10);
  });
});

describe("gotchi-meet --inline gating", () => {
  it("handles --inline before the tmuxSessionName() check", () => {
    const src = readFileSync(meetCli, "utf8");
    const openIdx = src.indexOf('if (cmd === "open" || cmd === "room" || cmd === "ui")');
    assert.ok(openIdx > 0, "open|room|ui handler missing");
    const block = src.slice(openIdx, openIdx + 1200);
    const inlineIdx = block.indexOf("inline");
    const tmuxIdx = block.indexOf("tmuxSessionName()");
    assert.ok(inlineIdx >= 0, "inline flag missing in open|room|ui");
    assert.ok(tmuxIdx >= 0, "tmuxSessionName check missing");
    assert.ok(
      inlineIdx < tmuxIdx,
      "--inline handling must come before tmuxSessionName()",
    );
    // Inline path must not call ensureMeetGallery before spawn.
    const ensureIdx = block.indexOf("ensureMeetGallery()");
    const spawnInlineIdx = block.indexOf("meet-room-prompter.mjs");
    assert.ok(spawnInlineIdx >= 0);
    assert.ok(ensureIdx > spawnInlineIdx || ensureIdx < 0);
  });

  it("exits non-zero with no open meeting (when .current absent)", { skip: meetingPointerExists() }, () => {
    let err;
    try {
      execFileSync(process.execPath, [meetCli, "room", "--inline"], {
        encoding: "utf8",
        cwd: root,
        env: { ...process.env, GOTCHIBOT_MEET_INLINE: "1" },
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err, "expected non-zero exit");
    assert.notEqual(err.status, 0);
    const out = `${err.stdout || ""}${err.stderr || ""}`;
    assert.match(out, /no open meeting/i);
  });
});

describe("meet room iMessage layout", () => {
  const roomSrc = readFileSync(path.join(root, "scripts/meet-room.mjs"), "utf8");
  const prompterSrc = readFileSync(path.join(root, "scripts/meet-room-prompter.mjs"), "utf8");

  it("desk drawBody paints the iMessage frame, not the seat grid", () => {
    const draw = prompterSrc.slice(
      prompterSrc.indexOf("function drawBody("),
      prompterSrc.indexOf("function draw("),
    );
    assert.match(draw, /drawBodyInline\(/);
    assert.doesNotMatch(draw, /renderMeetRoom\(/);
    assert.doesNotMatch(draw, /3×2 grid/);
    assert.match(prompterSrc, /function drawBodyInline\(/);
    assert.match(prompterSrc, /renderInlineFrame\(/);
    assert.match(prompterSrc, /renderMeetChannel\(/);
  });

  it("renderMeetRoom paints the iMessage channel, not a cols×rows grid", () => {
    const fn = roomSrc.slice(
      roomSrc.indexOf("export function renderMeetRoom"),
      roomSrc.indexOf("function finalizeMeetFrame"),
    );
    assert.match(fn, /renderMeetChannel\(/);
    assert.doesNotMatch(fn, /renderGrid\(/);
    assert.doesNotMatch(fn, /in room/);
    assert.doesNotMatch(fn, /×\$\{GRID_/);
    assert.doesNotMatch(roomSrc, /3×2 grid/);
  });

  it("rendered meet room text has no seat-grid status", async () => {
    const { renderMeetRoom } = await import("../scripts/meet-room.mjs");
    const frame = renderMeetRoom({ cols: 80, rows: 24, includeHint: true });
    assert.equal(typeof frame, "string");
    assert.doesNotMatch(frame, /3×2 grid/);
    assert.doesNotMatch(frame, /\d+×\d+ grid/);
    assert.doesNotMatch(frame, /in room/);
  });
});

describe("meet transcript inset", () => {
  it("leaves 2 columns beside the message text and 1 row above and below", (t) => {
    // Top of the live meeting: the bottom can be one long reply (or "typing…")
    // with no speaker line in view, which made this test depend on chat state.
    const frame = renderMeetChannel({ cols: 70, rows: 24, scrollFromBottom: 1e9 });
    if (!/\d:\d\d/.test(frame.replace(/\x1b\[[0-9;]*m/g, ""))) return t.skip("no meeting turns to render");
    const lines = frame.split("\n");
    assert.ok(lines.length >= 3);
    const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
    const contentOf = (s) => plain(s).slice(0, -1);
    assert.equal(contentOf(lines[0]).trim(), "");
    assert.equal(contentOf(lines[lines.length - 1]).trim(), "");
    const body = lines.map(contentOf).find((line) => /\d:\d\d/.test(line));
    assert.ok(body, "expected a speaker line");
    const gap = body.match(/\S( +)\S/);
    assert.ok(gap, "expected a gap between the sprite and the name");
    assert.ok(gap[1].length >= 2, `gap was ${gap[1].length}`);
  });
});

describe("meet sidebar", () => {
  it("lists mini gotchi heads with a name, beside the transcript", () => {
    const side = renderMeetSidebar(10, MEET_SIDEBAR_COLS - 1);
    assert.equal(side.length, 10);
    assert.equal(SIDEBAR_CARD_ROWS, 6);
    const plainLines = side.map((s) => s.replace(/\x1b\[[0-9;]*m/g, ""));
    assert.equal(plainLines[5].trim(), "");
    const plain = side.map((s) => s.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
    assert.match(plain, /▀ ▀/);
    assert.doesNotMatch(plain, /▄▀▀▀▀▀▀▄/);
    assert.doesNotMatch(plain, /seat/);
    const frame = renderInlineFrame({ cols: 90, rows: 30, scrollFromBottom: 0 });
    const row = frame.split("\n")[2] || "";
    const vis = row.replace(/\x1b\[[0-9;]*m/g, "");
    assert.ok(vis.length > MEET_SIDEBAR_COLS);
    assert.equal(vis[MEET_SIDEBAR_COLS - 1], "│");
    const width = MEET_SIDEBAR_COLS - 1;
    const tall = renderMeetSidebar(48, width);
    for (const line of tall) {
      const visLine = line.replace(/\x1b\[[0-9;]*m/g, "");
      assert.ok(visLine.length <= width, JSON.stringify(visLine));
    }
    const wide = renderInlineFrame({ cols: 120, rows: 48, scrollFromBottom: 0 });
    for (const line of wide.split("\n").slice(1)) {
      const visLine = line.replace(/\x1b\[[0-9;]*m/g, "");
      assert.equal(visLine[MEET_SIDEBAR_COLS - 1], "│", JSON.stringify(visLine.slice(0, 40)));
    }
  });

  it("the room is a chat: every letter goes into the message; Tab then ↑↓ pick a meet", async () => {
    const mod = await import("../scripts/meet-room-prompter.mjs");
    mod.meetKeyForTest("\t"); // into the list…
    mod.meetKeyForTest("\t"); // …and back to the room
    assert.equal(mod.meetSidebarState().focus, "chat");
    for (const ch of "hjklmn,.[]") mod.meetKeyForTest(ch);
    assert.equal(mod.meetPromptText(), "hjklmn,.[]", "no letter or punctuation is a shortcut");
    assert.equal(mod.meetSidebarState().focus, "chat");
    for (let i = 0; i < 10; i++) mod.meetKeyForTest("\x7f");
    assert.equal(mod.meetPromptText(), "");
    mod.meetKeyForTest("\t");
    assert.equal(mod.meetSidebarState().focus, "sidebar", "Tab opens the meet list");
    const before = mod.meetSidebarState().sideSel;
    for (const ch of "\x1b[B") mod.meetKeyForTest(ch);
    const n = (await import("../scripts/meet-channel.mjs")).listMeetThreads().length;
    assert.equal(mod.meetSidebarState().sideSel, Math.min(n - 1, before + 1), "↓ picks the next meet");
    mod.meetKeyForTest("x");
    assert.equal(mod.meetSidebarState().focus, "chat", "typing in the list goes back to the room's chat");
    assert.equal(mod.meetPromptText(), "x");
    mod.meetKeyForTest("\x7f");
  });
});

describe("meet sidebar picks saved meets", () => {
  it("gives each group meeting its own room, titled with its topic", async () => {
    const { listMeetThreads, buildMeetChannelLines } = await import("../scripts/meet-channel.mjs");
    const mod = await import("../scripts/meet-room-prompter.mjs");
    const threads = listMeetThreads();
    const groups = threads.filter((t) => !t.direct);
    for (const g of groups) assert.equal(g.segments.length, 1, "one meeting per group room");
    assert.equal(threads.some((t) => t.id === "group"), false, "no combined group thread");
    for (const g of groups) assert.equal(g.id, g.segments[0].id, "a group room's id is its meeting id");
    const plain = mod
      .renderMeetSidebar(SIDEBAR_CARD_ROWS * 2, MEET_SIDEBAR_COLS - 1)
      .map((s) => s.replace(/\x1b\[[0-9;]*m/g, ""))
      .join("\n");
    const group = groups[0];
    if (!group) return;
    assert.doesNotMatch(plain, /Group meetings/);
    const lines = buildMeetChannelLines(group, 100, 90).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
    assert.match(lines[0], new RegExp(`# ${(group.topic || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.equal(lines.filter((l) => /▶ .* started /.test(l)).length <= 1, true, "no stack of earlier meetings");
    // The room shows that meeting's own messages (it read the right transcript).
    const { readTranscript } = await import("../scripts/meet-channel.mjs");
    if (readTranscript(group.id).length) assert.doesNotMatch(lines.join("\n"), /channel empty/);
    const at = threads.indexOf(group);
    while (mod.meetSidebarState().sideSel > at) mod.sidebarKey("up");
    while (mod.meetSidebarState().sideSel < at) mod.sidebarKey("down");
    mod.sidebarKey("open");
    assert.equal(mod.meetSidebarState().viewMeetingId, group.id);
    assert.equal(mod.meetSidebarState().focus, "chat");
    assert.equal(mod.sidebarKey("x"), "");
  });

  it("Tab, Ctrl+U/Ctrl+D and the input panel live in the chat column", () => {
    const src = readFileSync(path.join(root, "scripts/meet-room-prompter.mjs"), "utf8");
    const fn = src.slice(src.indexOf("function handleKey"), src.indexOf("function handleEsc"));
    assert.match(fn, /meetPaneFocus === "sidebar"/);
    assert.match(fn, /focusSidebar\(\)/);
    assert.match(fn, /\\x15/);
    // Every input-panel draw goes through one geometry (the footer redraw too).
    const calls = src.match(/drawInputPanel\([^)]*\)/g).filter((c) => !c.startsWith("drawInputPanel(top, cols, left"));
    assert.ok(calls.length >= 2);
    for (const c of calls) assert.equal(c, "drawInputPanel(g.top, g.cols, g.left, g.inputRows, g.padY)");
  });
});

describe("/chat picker", () => {
  it("single picks one gotchi; multi toggles several, then starts that set", async () => {
    const mod = await import("../scripts/meet-room-prompter.mjs");
    const roster = mod.chatRoster();
    if (roster.length < 2) return;
    const started = [];
    const start = (ids) => started.push(ids);
    mod.openChatPicker();
    assert.equal(mod.chatPickerState().step, "mode");
    mod.chatPickerKey("enter", { start }); // Single
    assert.equal(mod.chatPickerState().mode, "single");
    mod.chatPickerKey("down", { start });
    mod.chatPickerKey("enter", { start });
    assert.deepEqual(started.pop(), [roster[1].id]);
    assert.equal(mod.chatPickerState(), null);

    mod.openChatPicker();
    mod.chatPickerKey("down", { start });
    mod.chatPickerKey("enter", { start }); // Multi
    assert.equal(mod.chatPickerState().mode, "multi");
    mod.chatPickerKey("toggle", { start });
    mod.chatPickerKey("down", { start });
    mod.chatPickerKey("toggle", { start });
    mod.chatPickerKey("enter", { start });
    assert.deepEqual(started.pop(), [roster[0].id, roster[1].id]);

    mod.openChatPicker();
    mod.chatPickerKey("back", { start });
    assert.equal(mod.chatPickerState(), null, "esc on the first step closes");
  });

  it("direct chats key the meet list on their exact gotchi set; /desk leaves", () => {
    const ch = readFileSync(path.join(root, "scripts/meet-channel.mjs"), "utf8");
    assert.match(ch, /m\.solo \|\| m\.direct \? `direct:\$\{agentKey\(m\)/);
    const meet = readFileSync(meetCli, "utf8");
    assert.match(meet, /export async function openDirectChat/);
    assert.match(meet, /open\.parkedAt = /);
    const pr = readFileSync(path.join(root, "scripts/meet-room-prompter.mjs"), "utf8");
    assert.match(pr, /line === "\/chat"\) \{\s+editTargetTs = null;\s+openChatPicker\(\)/);
    assert.match(pr, /line === "\/desk"/);
  });
});

describe("input panel geometry", () => {
  it("puts the panel in the chat column with the same rows for full and footer redraws", async () => {
    const { inputPanelGeometry, meetSideWidth } = await import("../scripts/meet-room-prompter.mjs");
    const g = inputPanelGeometry(150, 46, null);
    const L = inlineLayout(150, 46);
    assert.equal(g.top, L.promptTop);
    assert.equal(g.inputRows, L.inputRows);
    assert.equal(g.left, meetSideWidth(150, null) + 1);
    assert.equal(g.cols + g.left - 1, 150);
  });
});

describe("wheel scrolls the messages, not the prompt", () => {
  it("↑/↓ scroll the transcript; prompt history is Ctrl+P / Ctrl+N", () => {
    const src = readFileSync(path.join(root, "scripts/meet-room-prompter.mjs"), "utf8");
    const esc = src.slice(src.indexOf("function handleEsc"), src.indexOf("function ensureMeetGalleryLayout"));
    const up = esc.slice(esc.indexOf('if (seq === "\\x1b[A" || seq === "\\x1bOA") {\n    if (editor.cycleMenu(-1))'));
    assert.match(up.slice(0, 200), /scrollFromBottom \+= 1/);
    assert.doesNotMatch(esc, /historyUp\(\)/, "arrows never touch prompt history");
    const keys = src.slice(src.indexOf("function handleKey"), src.indexOf("function handleEsc"));
    assert.match(keys, /case "\\x10":[\s\S]*?historyUp\(\)/);
    assert.match(keys, /case "\\x0e":[\s\S]*?historyDown\(\)/);
  });
});

describe("meeting gotchis stay honest about actions", () => {
  it("every turn says nothing runs from a meeting and gives the ! command instead", async () => {
    const { MEET_ACTION_RULE } = await import("../scripts/gotchi-meet.mjs");
    assert.match(MEET_ACTION_RULE, /cannot run anything yourself/);
    assert.match(MEET_ACTION_RULE, /Never say something was done/);
    assert.match(MEET_ACTION_RULE, /ACTION: \.\/scripts\/gotchibot heroes bind/);
    const src = readFileSync(path.join(root, "scripts/gotchi-meet.mjs"), "utf8");
    const fn = src.slice(src.indexOf("async function agentReply"), src.indexOf("function printMeetingBlock"));
    assert.match(fn, /MEET_ACTION_RULE/);
    assert.match(fn, /meetDeskFacts\(\)/);
  });
});

describe("meet message selector", () => {
  it("↑ picks the latest message, ↑↓ step, ↓ past the latest returns to typing; the pick is drawn with ▶ and copy keys", async (t) => {
    const mod = await import("../scripts/meet-room-prompter.mjs");
    const { meetingTurns, renderMeetChannel } = await import("../scripts/meet-channel.mjs");
    const meeting = mod.viewedMeeting();
    const n = meetingTurns(meeting).length;
    if (n < 2) return t.skip("needs a room with 2+ messages");
    mod.leaveMessageSelector();
    assert.equal(mod.moveMessageSelector(1), "noop", "↓ with nothing picked does not pick");
    mod.moveMessageSelector(-1);
    assert.equal(mod.messageSelectorState().selTurn, n - 1, "↑ picks the latest");
    mod.moveMessageSelector(-1);
    assert.equal(mod.messageSelectorState().selTurn, n - 2);
    const { scrollForTurn } = await import("../scripts/meet-channel.mjs");
    for (const [cols, rows] of [[90, 40], [70, 16]]) {
      const frame = renderMeetChannel({ cols, rows, meeting, selected: n - 2, scrollFromBottom: scrollForTurn({ cols, rows, meeting, index: n - 2 }) })
        .replace(/\x1b\[[0-9;]*m/g, "");
      assert.match(frame, /▶ /, `the picked message is on screen at ${cols}×${rows}`);
    }
    const frame = renderMeetChannel({ cols: 90, rows: 40, meeting, selected: n - 2, scrollFromBottom: scrollForTurn({ cols: 90, rows: 40, meeting, index: n - 2 }) })
      .replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(frame, /▶ .*⏎ copy · Esc latest/, "the picked message is on screen with its keys");
    mod.moveMessageSelector(1);
    mod.moveMessageSelector(1);
    assert.deepEqual(mod.messageSelectorState(), { selTurn: null, selMark: null, scrollFromBottom: 0 }, "past the latest: back to typing");
    mod.moveMessageSelector(-1);
    mod.leaveMessageSelector();
    assert.equal(mod.messageSelectorState().selTurn, null, "Esc drops the pick");
  });
});
