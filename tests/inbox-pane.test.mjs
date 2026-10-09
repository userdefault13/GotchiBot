/**
 * Inbox pane — project mail on sessions/pstack/<slug>/mail.json.
 * Fixture data only. Does not read the live desk sessions tree.
 *   node --test tests/inbox-pane.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { kindLabel } from "../scripts/desk-active.mjs";
import {
  listMailMessages,
  openMailMessage,
  renderInboxView,
} from "../scripts/inbox-pane.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const FIXTURE = {
  project: "alpha",
  provider: "agentmail",
  abraProject: "gotchibot",
  abraKey: "AGENT_MAIL_API_KEY",
  address: "alpha@agentmail.to",
  inboxId: "inb_alpha",
  apiKey: "not-a-real-key",
  messages: [
    {
      id: "m1",
      from: "courier",
      to: "userdefault",
      kind: "fyi",
      subject: "Hello",
      body: "Full body text that is definitely longer than a list preview and must show when opened.",
      ts: "2026-09-01T00:00:00.000Z",
      readAt: null,
    },
    {
      id: "m2",
      from: "orch",
      to: "userdefault",
      kind: "alert",
      subject: "Newer",
      body: "Alert body",
      ts: "2026-10-01T00:00:00.000Z",
      readAt: "2026-10-01T01:00:00.000Z",
    },
  ],
};

function fixtureFile() {
  const dir = mkdtempSync(join(tmpdir(), "inbox-pane-"));
  const file = join(dir, "mail.json");
  assert.equal(file.includes(`${path.sep}sessions${path.sep}pstack${path.sep}`), false);
  writeFileSync(file, `${JSON.stringify(FIXTURE, null, 2)}\n`);
  return file;
}

describe("project mail.json", () => {
  it("lists newest first and opens one message body", () => {
    const file = fixtureFile();
    const doc = JSON.parse(readFileSync(file, "utf8"));
    const listed = listMailMessages(doc);
    assert.deepEqual(
      listed.map((m) => m.id),
      ["m2", "m1"],
    );

    const list = renderInboxView({
      messages: listed,
      selected: 1,
      address: doc.address,
      activeLine: "DAI · factory",
      cols: 72,
    });
    assert.match(list, /DAI · factory/);
    assert.match(list, /INBOX/);
    assert.match(list, /Newer/);
    assert.match(list, /Hello/);
    assert.match(list, /•/);
    assert.ok(list.indexOf("Newer") < list.indexOf("Hello"));
    assert.doesNotMatch(list, /not-a-real-key/);

    const opened = openMailMessage(file, "m1", "2026-10-01T12:00:00.000Z");
    assert.equal(opened.id, "m1");
    assert.equal(opened.readAt, "2026-10-01T12:00:00.000Z");
    assert.match(opened.body, /definitely longer/);

    const read = renderInboxView({
      view: "read",
      messages: listMailMessages(JSON.parse(readFileSync(file, "utf8"))),
      message: opened,
      activeLine: "DAI · factory",
      cols: 40,
    });
    // The read view is now boxed like the dossier: drop colors and the │ borders before joining wrapped lines.
    const flat = read.replace(/\x1b\[[0-9;]*m/g, "").replace(/│/g, " ").replace(/\s+/g, " ");
    assert.match(flat, /Full body text that is definitely longer/);
    assert.match(read, /esc back/);
    assert.doesNotMatch(read, /not-a-real-key/);

    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(saved.address, "alpha@agentmail.to");
    assert.equal(saved.inboxId, "inb_alpha");
    assert.equal(saved.abraKey, "AGENT_MAIL_API_KEY");
    assert.equal(saved.apiKey, undefined);
    assert.equal(saved.messages.find((m) => m.id === "m1").readAt, "2026-10-01T12:00:00.000Z");
    assert.equal(saved.messages.find((m) => m.id === "m2").readAt, "2026-10-01T01:00:00.000Z");
  });

  it("renders an empty project mailbox without inventing messages", () => {
    const text = renderInboxView({
      messages: [],
      address: "alpha@agentmail.to",
      cols: 60,
    });
    assert.match(text, /\(inbox empty\)/);
    assert.match(text, /alpha@agentmail\.to/);
    assert.equal(listMailMessages({ address: "alpha@agentmail.to" }).length, 0);
  });
});

describe("inbox desk pane wiring", () => {
  it("places the pane and a desk-active collapsed bar", () => {
    const layout = readFileSync(join(root, "scripts/orchestrator-layout.sh"), "utf8");
    assert.match(layout, /DESK_PANE_COUNT=10/);
    assert.match(layout, /enter-inbox\|inbox\)/);
    assert.match(layout, /toggle-inbox\)/);
    assert.match(layout, /label-bar-pane\.sh Inbox/);
    assert.match(layout, /exec \.\/scripts\/inbox-pane\.sh/);
    assert.match(layout, /bind-key -T prefix I/);
    const label = readFileSync(join(root, "scripts/label-bar-pane.sh"), "utf8");
    const desk = readFileSync(join(root, "scripts/lib/desk-label.sh"), "utf8");
    assert.match(label, /desk-label\.sh/);
    assert.match(desk, /sessions\/\.desk-active\.line/);
    assert.equal(kindLabel("./scripts/inbox-pane.sh", "inbox", "gotchibot"), "Inbox");
    assert.equal(
      kindLabel("./scripts/label-bar-pane.sh Inbox", "chat", "gotchibot"),
      "Inbox",
    );
  });

  it("bash -n inbox pane and layout", () => {
    execFileSync("bash", ["-n", join(root, "scripts/inbox-pane.sh")]);
    execFileSync("bash", ["-n", join(root, "scripts/orchestrator-layout.sh")]);
  });
});
