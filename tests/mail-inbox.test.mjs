/**
 * Mail source for the inbox pane + sync cache. Fixture data only.
 *   node --test tests/mail-inbox.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mailSourceMessages, mergeMailSource, listMailMessages } from "../scripts/inbox-pane.mjs";
import { syncDoc, writeSyncDoc } from "../scripts/mail.mjs";

const identity = { id: "gotchibot.xyz", address: "admin@gotchibot.xyz" };
const rows = [
  { id: "5", from: "Pat <pat@x.test>", to: "admin@gotchibot.xyz", subject: "New", date: "2026-10-09T10:00:00Z", seen: false },
  { id: "4", from: "Sam <sam@x.test>", to: "admin@gotchibot.xyz", subject: "Old", date: "2026-10-01T10:00:00Z", seen: true },
];

describe("sync cache", () => {
  it("writes sessions/mail/<identity>.json atomically with no credentials", () => {
    const dir = mkdtempSync(join(tmpdir(), "mail-sync-"));
    const file = writeSyncDoc(join(dir, "mail"), syncDoc(identity, rows, "2026-10-09T12:00:00Z"));
    assert.equal(readdirSync(join(dir, "mail")).length, 1);
    const doc = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(doc.messages.length, 2);
    assert.equal(doc.messages[0].id, "imap:gotchibot.xyz:5");
    assert.equal(doc.messages[0].readAt, null);
    assert.ok(doc.messages[1].readAt);
    assert.ok(!/pass|secret|token/i.test(JSON.stringify(doc)));
  });
});

describe("mailSourceMessages", () => {
  const dir = mkdtempSync(join(tmpdir(), "mail-pane-"));
  writeSyncDoc(join(dir, "mail"), syncDoc(identity, rows, "2026-10-09T12:00:00Z"));
  it("lists cached mail as read-only pane messages with an open hint", () => {
    const msgs = mailSourceMessages(dir, "gotchibot.xyz");
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].kind, "mail");
    assert.match(msgs[0].body, /gotchibot mail read 5 --as gotchibot\.xyz/);
    assert.match(msgs[0].body, /gotchibot mail reply 5/);
  });
  it("is empty when nothing is synced", () => {
    assert.deepEqual(mailSourceMessages(dir, "yummydog.xyz"), []);
    assert.deepEqual(mailSourceMessages(join(dir, "missing"), "gotchibot.xyz"), []);
  });
  it("merges with project mail, newest first", () => {
    const project = listMailMessages({ messages: [{ id: "p1", from: "bot", subject: "Mid", ts: "2026-10-05T00:00:00Z", body: "x" }] });
    const merged = mergeMailSource(project, mailSourceMessages(dir, "gotchibot.xyz"));
    assert.deepEqual(merged.map((m) => m.subject), ["New", "Mid", "Old"]);
  });
});
