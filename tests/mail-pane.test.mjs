/**
 * Inbox pane as a mail client: pure helpers, the CLI prompts the pane drives,
 * and a real pty session of the pane against a fake himalaya.
 * Nothing here can send: the fake binary only records a SEND marker, and the
 * assertions require zero of them.   node --test tests/mail-pane.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderInboxView, nextMailIdentity, mailPaneArgs, isMailMessage, mailBodyFromRead } from "../scripts/inbox-pane.mjs";
import { syncDoc, writeSyncDoc } from "../scripts/mail.mjs";
import { ROOT } from "../scripts/mail-lib.mjs";

const strip = (t) => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

describe("pane helpers", () => {
  it("cycles identities and wraps", () => {
    assert.equal(nextMailIdentity(["a", "b", "c"], "a"), "b");
    assert.equal(nextMailIdentity(["a", "b", "c"], "c"), "a");
    assert.equal(nextMailIdentity(["a", "b"], "zzz"), "a");
    assert.equal(nextMailIdentity([], "a"), null);
  });
  it("maps pane actions to gotchibot mail argv; reply and compose are prompt-driven, never --yes", () => {
    assert.deepEqual(mailPaneArgs("read", { identity: "x.test", uid: 5 }), ["mail", "read", "5", "--as", "x.test"]);
    assert.deepEqual(mailPaneArgs("reply", { identity: "x.test", uid: 5 }), ["mail", "reply", "5", "--as", "x.test", "--prompt"]);
    assert.deepEqual(mailPaneArgs("compose", { identity: "x.test" }), ["mail", "compose", "--as", "x.test"]);
    for (const a of ["read", "reply", "compose", "sync"]) {
      assert.ok(!mailPaneArgs(a, { identity: "x", uid: 1 }).some((v) => /--yes|--send|--body/.test(v)));
    }
    assert.throws(() => mailPaneArgs("send", { identity: "x" }));
  });
  it("recognizes mail messages", () => {
    assert.equal(isMailMessage({ kind: "mail", id: "imap:gotchibot.xyz:3" }), true);
    assert.equal(isMailMessage({ kind: "fyi", id: "m1" }), false);
  });
  it("trims read output", () => assert.equal(mailBodyFromRead("\r\nTo: a\r\n\r\nhi\r\n"), "To: a\n\nhi"));
  it("renders the identity and key hints only for mail", () => {
    const msgs = [{ id: "imap:g:1", from: "Pat", to: "", kind: "mail", subject: "S", body: "b", ts: "2026-10-09T00:00:00Z", readAt: null }];
    const withMail = strip(renderInboxView({ messages: msgs, identity: "gotchibot.xyz", notice: "synced" }));
    assert.match(withMail, /mail as gotchibot\.xyz/);
    assert.match(withMail, /r reply · c compose · i identity · s sync/);
    assert.match(withMail, /synced/);
    const plain = strip(renderInboxView({ messages: msgs }));
    assert.ok(!/compose/.test(plain));
    assert.match(plain, /j\/k select · enter read · q chat/);
  });
});

const dir = mkdtempSync(join(tmpdir(), "mail-pane-"));
const log = join(dir, "calls.log");
const fake = join(dir, "himalaya");
writeFileSync(
  fake,
  `#!/bin/sh
args="$*"
case "$args" in
  *"message send"*) printf 'SEND\\n' >> "${log}"; cat >> "${log}"; exit 0 ;;
  *"envelope list"*) echo '{"queued":0,"envelopes":[{"id":"3","flags":[],"subject":"Fixture subject","from":[{"name":"Pat","email":"pat@x.test"}],"to":[{"email":"gotchibot@gotchibot.xyz"}],"date":"2026-10-09T01:02:03Z"}]}'; exit 0 ;;
  *"message compose"*) printf 'From: gotchibot@gotchibot.xyz\\nTo: pat@x.test\\nSubject: Hello\\n\\n%s\\n' "composed body"; exit 0 ;;
  *"message reply"*) printf 'From: gotchibot@gotchibot.xyz\\nTo: pat@x.test\\nSubject: Re: Fixture subject\\n\\nthanks\\n'; exit 0 ;;
  *"message read"*) printf 'To: gotchibot@gotchibot.xyz\\nSubject: Fixture subject\\n\\n[1] text/plain (12 B)\\n\\nfixture body\\n'; exit 0 ;;
  *"account check"*) printf 'Account: g\\n  imap: OK\\n  smtp: OK\\n'; exit 0 ;;
esac
exit 9
`,
);
chmodSync(fake, 0o755);
const wrapper = join(dir, "gotchibot-cli");
writeFileSync(wrapper, `#!/bin/sh\nshift\nexec "${process.execPath}" "${join(ROOT, "scripts/mail.mjs")}" "$@"\n`);
chmodSync(wrapper, 0o755);
const sessions = join(dir, "sessions");
mkdirSync(sessions, { recursive: true });
writeSyncDoc(
  join(sessions, "mail"),
  syncDoc(
    { id: "gotchibot.xyz", address: "gotchibot@gotchibot.xyz" },
    [{ id: "3", from: "Pat <pat@x.test>", to: "gotchibot@gotchibot.xyz", subject: "Fixture subject", date: "2026-10-09T01:02:03Z", seen: false }],
    "2026-10-09T12:00:00Z",
  ),
);
const sends = () => (existsSync(log) ? readFileSync(log, "utf8").split("SEND").length - 1 : 0);
const env = {
  ...process.env,
  GOTCHIBOT_HIMALAYA_BIN: fake,
  GOTCHIBOT_MAIL_ABRA: "1",
  GOTCHIBOT_MAIL_PREFLIGHT: "0",
  MAILU_CLIENT_PASS_GOTCHIBOT_XYZ: "fake-secret",
  GOTCHIBOT_MAIL_SESSIONS: sessions,
  GOTCHIBOT_MAIL_CLI: wrapper,
  GOTCHIBOT_MAIL_PANE_SYNC: "0",
  GOTCHIBOT_PROJECT: "no-such-project",
};
const MAIL = join(ROOT, "scripts/mail.mjs");
const cli = (args, input) => spawnSync(process.execPath, [MAIL, ...args], { input, encoding: "utf8", env });

describe("CLI prompts the pane drives (piped stdin, fake himalaya)", () => {
  it("reply --prompt reads the body, prints the message, and a non-'send' answer sends nothing", () => {
    const r = cli(["reply", "3", "--as", "gotchibot", "--prompt"], "thanks a lot\nsecond line\n.\nno\n");
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stdout, /Re: Fixture subject/);
    assert.match(r.stdout, /About to send as gotchibot@gotchibot\.xyz to pat@x\.test/);
    assert.match(r.stdout, /not sent/);
    assert.equal(sends(), 0);
  });
  it("compose asks To, Subject and body, prints, and does not send on 'no'", () => {
    const r = cli(["compose", "--as", "gotchibot"], "pat@x.test\nHello\nline one\n.\nnope\n");
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /To: /);
    assert.match(r.stdout, /Subject: Hello/);
    assert.match(r.stdout, /not sent/);
    assert.equal(sends(), 0);
  });
  it("compose with input that ends before the confirm sends nothing", () => {
    const r = cli(["compose", "--as", "gotchibot"], "pat@x.test\nHello\nbody\n.\n");
    assert.equal(r.status, 3);
    assert.equal(sends(), 0);
  });
  it("there is no --yes path: the flag is ignored and nothing is sent", () => {
    const r = cli(["send", "--as", "gotchibot", "--to", "pat@x.test", "--body", "b", "--yes"], "");
    assert.equal(r.status, 3);
    assert.equal(sends(), 0);
  });
});

const PTY = `
import os, pty, sys, time, select, re
env = dict(os.environ)
pid, fd = pty.fork()
if pid == 0:
    os.chdir(${JSON.stringify(ROOT)})
    os.execvpe(${JSON.stringify(process.execPath)}, [${JSON.stringify(process.execPath)}, "scripts/inbox-pane.mjs", "watch"], env)
buf = b""
def pump(t=1.5):
    global buf
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                d = os.read(fd, 65536)
            except OSError:
                return
            if not d: return
            buf += d
def send(s, wait=2.5):
    os.write(fd, s.encode()); pump(wait)
os.environ["COLUMNS"] = "100"
pump(2.5)
send("\\r", 4)              # open first message (fetches body through the CLI)
send("r", 3)                # reply: CLI asks for the body
send("my reply\\n.\\n", 3)   # body, then the CLI prints the message and asks
send("no\\n", 2)            # anything but the word send
send("\\n", 2)              # back to the pane
send("\\x7f", 2)            # back to the list
send("c", 3)                # compose: To / Subject / body
send("pat@x.test\\nHi\\ntext\\n.\\n", 3)
send("no\\n", 2)
send("\\n", 2)
send("i", 3)               # next identity
send("\\x03", 1)
sys.stdout.write(buf.decode("utf8", "replace"))
`;

describe("pane in a real pty (fake himalaya)", () => {
  it("opens, reads, replies, composes and switches identity; the send step only prints and asks", () => {
    const r = spawnSync("python3", ["-c", PTY], { encoding: "utf8", env, timeout: 90000 });
    assert.equal(r.status, 0, r.stderr);
    const out = strip(r.stdout);
    assert.match(out, /mail as gotchibot\.xyz/);
    assert.match(out, /fixture body/, "message body is read through gotchibot mail read");
    assert.match(out, /Body \(finish with a line containing only/);
    assert.match(out, /About to send as gotchibot@gotchibot\.xyz to pat@x\.test/);
    assert.match(out, /Type "send" to send this message/);
    assert.match(out, /not sent/);
    assert.match(out, /To: /);
    assert.match(out, /mail as aarcadeghst\.com/, "i switches identity");
    assert.equal(sends(), 0, "the pane session never sent");
    assert.ok(!out.includes("fake-secret"));
  });
});
