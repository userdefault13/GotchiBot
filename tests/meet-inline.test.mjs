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
  meetScrollDelta,
  MEET_SIDEBAR_COLS,
  SIDEBAR_CARD_ROWS,
  meetFocusTarget,
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
  it("80x24: strip + transcript + 4-row prompt", () => {
    const L = inlineLayout(80, 24);
    assert.equal(L.cols, 80);
    assert.equal(L.rows, 24);
    assert.equal(L.stripRow, 1);
    assert.equal(L.transcriptTop, 2);
    assert.equal(L.promptRows, 4);
    assert.equal(L.promptTop, 21);
    assert.equal(L.transcriptRows, 19);
    assert.equal(L.stripRow + L.transcriptRows + L.promptRows, 24);
  });

  it("120x40: scales transcript", () => {
    const L = inlineLayout(120, 40);
    assert.equal(L.cols, 120);
    assert.equal(L.promptRows, 4);
    assert.equal(L.promptTop, 37);
    assert.equal(L.transcriptTop, 2);
    assert.equal(L.transcriptRows, 35);
    assert.equal(L.stripRow + L.transcriptRows + L.promptRows, 40);
  });

  it("40x12: clamps sensibly", () => {
    const L = inlineLayout(40, 12);
    assert.equal(L.cols, 40);
    assert.equal(L.promptRows, 4);
    assert.equal(L.promptTop, 9);
    assert.equal(L.transcriptTop, 2);
    assert.equal(L.transcriptRows, 7);
    assert.ok(L.transcriptRows >= 1);
    assert.equal(L.stripRow + L.transcriptRows + L.promptRows, 12);
  });

  it("tiny height still returns positive regions", () => {
    const L = inlineLayout(40, 5);
    assert.ok(L.promptRows >= 1);
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

describe("meet transcript j/k", () => {
  it("j moves down toward newer turns and k moves up toward older ones", () => {
    assert.equal(meetScrollDelta("j"), -1);
    assert.equal(meetScrollDelta("J"), -1);
    assert.equal(meetScrollDelta("k"), 1);
    assert.equal(meetScrollDelta("K"), 1);
    assert.equal(meetScrollDelta("h"), 0);
    assert.equal(meetScrollDelta("l"), 0);
  });
});

describe("meet transcript inset", () => {
  it("leaves 2 columns beside the message text and 1 row above and below", () => {
    const frame = renderMeetChannel({ cols: 70, rows: 24, scrollFromBottom: 0 });
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
    assert.equal(SIDEBAR_CARD_ROWS, 5);
    const plainLines = side.map((s) => s.replace(/\x1b\[[0-9;]*m/g, ""));
    assert.equal(plainLines[4].trim(), "");
    const plain = side.map((s) => s.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
    assert.match(plain, /[▄▀█░]/);
    assert.doesNotMatch(plain, /seat/);
    const frame = renderInlineFrame({ cols: 90, rows: 30, scrollFromBottom: 0 });
    const row = frame.split("\n")[2] || "";
    const vis = row.replace(/\x1b\[[0-9;]*m/g, "");
    assert.ok(vis.length > MEET_SIDEBAR_COLS);
    assert.equal(vis[MEET_SIDEBAR_COLS - 1], "│");
  });

  it("m focuses the sidebar and n focuses the chat, and typing still takes the letters", () => {
    assert.equal(meetFocusTarget("m"), "sidebar");
    assert.equal(meetFocusTarget("M"), "sidebar");
    assert.equal(meetFocusTarget("n"), "chat");
    assert.equal(meetFocusTarget("N"), "chat");
    assert.equal(meetFocusTarget("j"), "");
    const src = readFileSync(path.join(root, "scripts/meet-room-prompter.mjs"), "utf8");
    const fn = src.slice(src.indexOf("function handleKey"), src.indexOf("function handleEsc"));
    assert.ok(fn.indexOf("meetFocusTarget") < fn.indexOf("editor.insert"));
    assert.match(fn, /bufferEmpty\(\)/);
  });
});

