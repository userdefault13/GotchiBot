/**
 * Housekeep decisions on in-memory messages, and file moves in a temp directory.
 * Never opens sessions/pstack or sessions/inbox.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOUSEKEEP_MAX_AGE_MS,
  formatHousekeep,
  housekeepInbox,
  housekeepMessages,
} from "../scripts/bot-inbox.mjs";

const NOW = Date.parse("2026-10-02T07:00:00.000Z");
const OLD = new Date(NOW - HOUSEKEEP_MAX_AGE_MS - 1).toISOString();
const EXACT = new Date(NOW - HOUSEKEEP_MAX_AGE_MS).toISOString();
const YOUNG = new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString();
const SEP19 = "2026-09-19T15:00:00.000Z";
const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempRoot() {
  const dir = mkdtempSync(join(tmpdir(), "bot-inbox-housekeep-"));
  assert.equal(dir.startsWith(REPO), false);
  assert.equal(dir.includes(`${sep}sessions${sep}pstack${sep}`), false);
  dirs.push(dir);
  return dir;
}

function msg(partial) {
  return {
    id: partial.id,
    project: "fixture",
    from: partial.from || "system",
    to: partial.to || "owned-22899",
    kind: partial.kind || "report",
    subject: partial.subject,
    body: partial.body || "fixture body",
    ts: partial.ts === undefined ? OLD : partial.ts,
    readAt: partial.readAt ?? null,
    archivedAt: null,
  };
}

function writeBox(dir, name, messages) {
  const box = {
    project: "fixture",
    kind: name === "archive.json" ? "archive" : "inbox",
    messages,
    updatedAt: "2026-09-01T00:00:00.000Z",
    note: "fixture",
  };
  writeFileSync(join(dir, name), `${JSON.stringify(box, null, 2)}\n`);
}

function readBox(dir, name) {
  return JSON.parse(readFileSync(join(dir, name), "utf8"));
}

describe("housekeepMessages", () => {
  const inbox = [
    msg({ id: "read-fyi", kind: "fyi", subject: "seen", ts: YOUNG, readAt: "2026-10-01T00:00:00.000Z" }),
    msg({ id: "read-ask", kind: "ask", subject: "please", ts: YOUNG, readAt: "2026-10-01T00:00:00.000Z" }),
    msg({ id: "ask-old", kind: "ask", subject: "sub s1 finished", ts: OLD }),
    msg({ id: "alert-old", kind: "alert", subject: "sub s1 failed", ts: OLD, to: "owned-22899" }),
    msg({
      id: "user-old",
      kind: "fyi",
      to: "userdefault",
      subject: "pkm:delegated — board",
      ts: SEP19,
      from: "owned-954",
    }),
    msg({
      id: "user-read",
      kind: "report",
      to: "UserDefault",
      subject: "sub s9 finished",
      ts: OLD,
      readAt: "2026-09-20T00:00:00.000Z",
    }),
    msg({ id: "sub-done", kind: "report", subject: "sub s20260915-230158-20052 finished", ts: OLD, from: "system" }),
    msg({ id: "sub-fail", kind: "report", subject: "sub s2 failed", ts: SEP19, from: "system" }),
    msg({
      id: "pkm",
      kind: "fyi",
      from: "owned-954",
      to: "owned-14338",
      subject: "pkm:delegated — wake cycle",
      ts: SEP19,
    }),
    msg({ id: "sub-exact", kind: "report", subject: "sub s3 finished", ts: EXACT }),
    msg({ id: "pkm-other", kind: "fyi", subject: "pkm:submitted — wake cycle", ts: OLD, from: "owned-954" }),
    msg({ id: "noise", kind: "fyi", subject: "morning note", ts: OLD }),
    msg({ id: "sub-young", kind: "report", subject: "sub s4 finished", ts: YOUNG }),
    msg({ id: "no-ts", kind: "report", subject: "sub s5 finished", ts: "" }),
  ];

  it("archives read mail and stale sub/pkm notices, and leaves asks, alerts, and userdefault", () => {
    const prior = [{ id: "already", subject: "kept in archive", body: "still here", archivedAt: "2026-08-01T00:00:00.000Z" }];
    const result = housekeepMessages(inbox, prior, { now: NOW });

    assert.deepEqual(
      result.inbox.map((m) => m.id),
      ["ask-old", "alert-old", "user-old", "user-read", "sub-exact", "pkm-other", "noise", "sub-young", "no-ts"],
    );
    assert.deepEqual(
      result.archive.map((m) => m.id),
      ["already", "read-fyi", "read-ask", "sub-done", "sub-fail", "pkm"],
    );
    assert.equal(result.archived, 5);
    assert.equal(result.kept, 9);
    assert.equal(result.stillUnread, 8);
    assert.equal(formatHousekeep(result), "archived 5  kept 9  still unread 8");

    const moved = Object.fromEntries(result.archive.map((m) => [m.id, m]));
    assert.equal(moved["read-fyi"].readAt, "2026-10-01T00:00:00.000Z");
    assert.equal(moved["sub-done"].readAt, result.stamp);
    assert.equal(moved["sub-done"].archivedAt, result.stamp);
    assert.equal(moved["pkm"].to, "owned-14338");
    assert.equal(moved["pkm"].body, "fixture body");
    assert.equal(moved.already.body, "still here");

    const stayed = Object.fromEntries(result.inbox.map((m) => [m.id, m]));
    assert.equal(stayed["ask-old"].readAt, null);
    assert.equal(stayed["alert-old"].readAt, null);
    assert.equal(stayed["user-old"].readAt, null);
    assert.equal(stayed["user-read"].readAt, "2026-09-20T00:00:00.000Z");
    assert.equal(stayed["sub-young"].readAt, null);

    assert.equal(inbox.find((m) => m.id === "sub-done").readAt, null);
    assert.equal(inbox.find((m) => m.id === "sub-done").archivedAt, null);
  });

  it("does not archive a second copy when the id is already in the archive", () => {
    const result = housekeepMessages(
      [msg({ id: "dup", kind: "report", subject: "sub s1 finished", ts: OLD })],
      [{ id: "dup", subject: "sub s1 finished", body: "original" }],
      { now: NOW },
    );
    assert.equal(result.archived, 1);
    assert.equal(result.kept, 0);
    assert.equal(result.archive.length, 1);
    assert.equal(result.archive[0].body, "original");
  });
});

describe("housekeepInbox temp dir", () => {
  it("moves candidates into archive.json and leaves the rest in inbox.json", () => {
    const dir = tempRoot();
    writeBox(dir, "inbox.json", [
      msg({ id: "read-fyi", kind: "fyi", subject: "seen", readAt: "2026-10-01T00:00:00.000Z", ts: YOUNG }),
      msg({ id: "sub-done", subject: "sub s1 finished", ts: OLD }),
      msg({ id: "pkm", kind: "fyi", from: "owned-954", to: "owned-954", subject: "pkm:delegated — note", ts: SEP19 }),
      msg({ id: "ask-old", kind: "ask", subject: "need a decision", ts: OLD }),
      msg({ id: "user-old", kind: "fyi", to: "userdefault", subject: "pkm:delegated — note", ts: SEP19 }),
      msg({ id: "sub-young", subject: "sub s2 finished", ts: YOUNG }),
    ]);
    writeBox(dir, "archive.json", [
      { id: "already", subject: "old", body: "stay", archivedAt: "2026-08-01T00:00:00.000Z" },
    ]);

    const first = housekeepInbox(dir, { now: NOW });
    assert.deepEqual(first, { archived: 3, kept: 3, stillUnread: 3 });

    const inbox = readBox(dir, "inbox.json");
    const archive = readBox(dir, "archive.json");
    assert.deepEqual(inbox.messages.map((m) => m.id), ["ask-old", "user-old", "sub-young"]);
    assert.deepEqual(archive.messages.map((m) => m.id), ["already", "read-fyi", "sub-done", "pkm"]);
    assert.equal(archive.messages.find((m) => m.id === "already").body, "stay");
    assert.equal(archive.messages.find((m) => m.id === "sub-done").readAt, new Date(NOW).toISOString());
    assert.equal(inbox.messages.every((m) => m.readAt == null), true);
    assert.equal(existsSync(join(dir, "inbox.json")), true);
    assert.equal(existsSync(join(dir, "archive.json")), true);
    assert.equal(inbox.messages.length + archive.messages.length, 7);

    const inboxBytes = readFileSync(join(dir, "inbox.json"));
    const archiveBytes = readFileSync(join(dir, "archive.json"));
    const second = housekeepInbox(dir, { now: NOW });
    assert.deepEqual(second, { archived: 0, kept: 3, stillUnread: 3 });
    assert.deepEqual(readFileSync(join(dir, "inbox.json")), inboxBytes);
    assert.deepEqual(readFileSync(join(dir, "archive.json")), archiveBytes);
  });

  it("does not create files when the inbox is missing", () => {
    const dir = tempRoot();
    const result = housekeepInbox(dir, { now: NOW });
    assert.deepEqual(result, { archived: 0, kept: 0, stillUnread: 0 });
    assert.equal(existsSync(join(dir, "inbox.json")), false);
    assert.equal(existsSync(join(dir, "archive.json")), false);
  });

  it("leaves an unreadable inbox or archive untouched", () => {
    const dir = tempRoot();
    writeFileSync(join(dir, "inbox.json"), "{not json\n");
    assert.throws(() => housekeepInbox(dir, { now: NOW }), /inbox\.json is unreadable/);
    assert.equal(readFileSync(join(dir, "inbox.json"), "utf8"), "{not json\n");

    const dir2 = tempRoot();
    const inboxRaw = `${JSON.stringify({
      project: "fixture",
      kind: "inbox",
      messages: [msg({ id: "sub-done", subject: "sub s1 finished", ts: OLD })],
      updatedAt: "2026-09-01T00:00:00.000Z",
    })}\n`;
    writeFileSync(join(dir2, "inbox.json"), inboxRaw);
    writeFileSync(join(dir2, "archive.json"), "{not json\n");
    assert.throws(() => housekeepInbox(dir2, { now: NOW }), /archive\.json is unreadable/);
    assert.equal(readFileSync(join(dir2, "inbox.json"), "utf8"), inboxRaw);
    assert.equal(readFileSync(join(dir2, "archive.json"), "utf8"), "{not json\n");
  });

  it("requires a directory and does not default to the live inbox", () => {
    assert.throws(() => housekeepInbox(), /root required/);
    assert.throws(() => housekeepInbox(""), /root required/);
    assert.throws(() => housekeepInbox(join(tempRoot(), "missing")), /existing directory/);
  });
});
