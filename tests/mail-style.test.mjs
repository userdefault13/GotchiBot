/**
 * The mail pane wears the dossier pane's chrome (pstack-window helpers + palette).
 *   node --test tests/mail-style.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderInboxView, parseMailRead } from "../scripts/inbox-pane.mjs";
import { c } from "../scripts/pstack-window.mjs";

const strip = (t) => t.replace(/\x1b\[[0-9;]*m/g, "");
const msgs = [
  { id: "imap:gotchibot.xyz:2", from: "Pat <pat@x.test>", to: "gotchibot@gotchibot.xyz", kind: "mail", subject: "Quarterly report", body: "Open with: gotchibot mail read 2 --as gotchibot.xyz", ts: "2026-10-09T10:00:00Z", readAt: null },
  { id: "imap:gotchibot.xyz:1", from: "Sam <sam@x.test>", to: "gotchibot@gotchibot.xyz", kind: "mail", subject: "Old note", body: "x", ts: "2026-10-01T10:00:00Z", readAt: "2026-10-02T00:00:00Z" },
];
const READ = "From: Pat <pat@x.test>\nTo: gotchibot@gotchibot.xyz\nSubject: Quarterly report\nDate: 2026-10-09T10:00:00Z\n\n[1] text/plain (18 B)\n[2] application/pdf (12 KB) report.pdf\n\nHello there.\nSecond line.\n";

describe("mail list in dossier chrome", () => {
  const out = renderInboxView({ messages: msgs, selected: 0, identity: "gotchibot.xyz", cols: 80, rows: 30 });
  const plain = strip(out);
  it("uses the dossier box, pink bold section titles and border color", () => {
    assert.match(plain, /┌─ INBOX [─]+┐/);
    assert.match(plain, /├─ MESSAGES [─]+┤/);
    assert.match(plain, /└[─]+┘/);
    assert.ok(out.includes(`${c.border}┌─ ${c.reset}${c.pink}${c.bold}INBOX${c.reset}`));
  });
  it("shows gold counts, a labeled 'mail as' field and the dossier hint line", () => {
    assert.ok(out.includes(`${c.gold}2${c.reset} msgs`));
    assert.match(plain, /1 unread/);
    assert.match(plain, /mail as\s+gotchibot\.xyz/);
    const last = plain.split("\n").at(-1);
    assert.equal(last, "j/k select · enter read · r reply · c compose · i identity · s sync · q chat");
    assert.ok(out.endsWith(`${c.dim}${last}${c.reset}`));
  });
  it("marks the selection with the dossier caret and keeps every row inside the box width", () => {
    assert.match(plain, /▸•mail/);
    for (const line of plain.split("\n").slice(0, -1)) assert.ok([...line].length <= 80, line);
  });
  it("uses only colors from the dossier palette", () => {
    const allowed = new Set(Object.values(c));
    for (const code of out.match(/\x1b\[[0-9;]*m/g) || []) assert.ok(allowed.has(code), JSON.stringify(code));
  });
  it("keeps the selected message on screen in a short pane", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ ...msgs[1], id: `imap:g:${i}`, subject: `Subject ${i}`, body: "", ts: `2026-10-${String(10 + i).padStart(2, "0")}T00:00:00Z` }));
    const text = strip(renderInboxView({ messages: many, selected: 15, identity: "g", cols: 80, rows: 12 }));
    assert.match(text, /▸.*Subject 15/);
    assert.ok(text.split("\n").length <= 12);
  });
});

describe("mail read view as labeled fields", () => {
  const parsed = parseMailRead(READ);
  it("parses headers, part summaries and text", () => {
    assert.equal(parsed.headers.subject, "Quarterly report");
    assert.equal(parsed.parts.length, 2);
    assert.equal(parsed.text, "Hello there.\nSecond line.");
    assert.equal(parseMailRead("Open with: gotchibot mail read 2"), null);
  });
  const out = renderInboxView({ view: "read", messages: msgs, message: { ...msgs[0], body: READ }, identity: "gotchibot.xyz", cols: 80, rows: 30 });
  const plain = strip(out);
  it("shows from, to, subject, date and attach as dim labels in a MESSAGE box and the text under BODY", () => {
    assert.match(plain, /┌─ MESSAGE [─]+┐/);
    assert.match(plain, /├─ BODY [─]+┤/);
    assert.match(plain, /from\s+Pat <pat@x\.test>/);
    assert.match(plain, /to\s+gotchibot@gotchibot\.xyz/);
    assert.match(plain, /subject\s+Quarterly report/);
    assert.match(plain, /date\s+10-09 10:00/);
    assert.match(plain, /attach\s+application\/pdf \(12 KB\) report\.pdf/);
    assert.match(plain, /Hello there\./);
    assert.ok(!/\[1\] text\/plain/.test(plain), "raw part line is a field now, not body text");
    assert.ok(out.includes(`${c.dim}${"from".padEnd(10)}${c.reset}`));
  });
  it("says none when there is no attachment and ends with the dossier hint line", () => {
    const one = renderInboxView({ view: "read", messages: msgs, message: { ...msgs[0], body: READ.replace(/\[2\].*\n/, "") }, identity: "gotchibot.xyz", cols: 80 });
    assert.match(strip(one), /attach\s+none/);
    assert.equal(plain.split("\n").at(-1), "esc back · j/k scroll · r reply · c compose · i identity · s sync · q chat");
  });
  it("an unopened message still renders (placeholder body)", () => {
    const p = strip(renderInboxView({ view: "read", messages: msgs, message: msgs[0], cols: 80 }));
    assert.match(p, /Open with: gotchibot mail read 2/);
  });
});
