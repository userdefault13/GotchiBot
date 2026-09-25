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
  renderInlineFrame,
} from "../scripts/meet-room-prompter.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const meetCli = path.join(root, "scripts/gotchi-meet.mjs");
const currentPtr = path.join(root, "sessions/meetings/.current");

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

  it("exits non-zero with no open meeting (when .current absent)", { skip: existsSync(currentPtr) }, () => {
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
