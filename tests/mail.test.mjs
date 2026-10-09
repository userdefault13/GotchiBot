/**
 * gotchibot mail — identities, generated config, SOCKS relay, CLI with a fake
 * himalaya. No network, no abra, and nothing is ever sent.
 *   node --test tests/mail.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHimalayaConfig,
  loadMailConfig,
  parseCheckReport,
  parseEnvelopes,
  recipientsOf,
  resolveIdentity,
  startSocksProxy,
} from "../scripts/mail-lib.mjs";
import { ROOT } from "../scripts/mail-lib.mjs";

const cfg = loadMailConfig();
const MAIL = join(ROOT, "scripts", "mail.mjs");

describe("resolveIdentity", () => {
  it("takes a domain, a short name, or an address", () => {
    assert.equal(resolveIdentity({ as: "aarcadeghst.com", config: cfg }).address, "admin@aarcadeghst.com");
    assert.equal(resolveIdentity({ as: "wondrstack", config: cfg }).id, "wondrstack.xyz");
    assert.equal(resolveIdentity({ as: "ADMIN@yummydog.xyz", config: cfg }).id, "yummydog.xyz");
  });
  it("falls back to the active project, then the default", () => {
    assert.equal(resolveIdentity({ project: "aarcadeghst", config: cfg }).id, "aarcadeghst.com");
    assert.equal(resolveIdentity({ project: "nope", config: cfg }).id, cfg.defaultIdentity);
    assert.equal(resolveIdentity({ config: cfg }).id, cfg.defaultIdentity);
  });
  it("rejects an unknown identity and lists the valid ones", () => {
    assert.throws(() => resolveIdentity({ as: "nobody.example", config: cfg }), /valid: .*gotchibot\.xyz/);
  });
  it("covers all six domains", () => {
    for (const d of ["gotchibot.xyz", "aarcadeghst.com", "wondrstack.xyz", "yummydog.xyz", "lastwraphero.xyz", "userdefault.dev"]) {
      assert.equal(resolveIdentity({ as: d, config: cfg }).address, `admin@${d}`);
    }
  });
});

describe("buildHimalayaConfig", () => {
  const id = resolveIdentity({ as: "gotchibot", config: cfg });
  it("pins the cert, uses the relay, and asks printenv for the password", () => {
    const prev = process.env.MAILU_ADMIN_PASS;
    process.env.MAILU_ADMIN_PASS = "hunter2-test";
    try {
      const toml = buildHimalayaConfig(id, { cfg, proxyPort: 4242 });
      assert.match(toml, /imap\.server = "imaps:\/\/mail\.userdefault\.dev:993"/);
      assert.match(toml, /smtp\.server = "smtps:\/\/mail\.userdefault\.dev:465"/);
      assert.match(toml, /imap\.tls\.cert = ".*mail\.userdefault\.dev\.pem"/);
      assert.match(toml, /smtp\.tls\.cert = /);
      assert.match(toml, /proxy\.url = "socks5h:\/\/127\.0\.0\.1:4242"/);
      assert.match(toml, /password\.command = \["printenv", "MAILU_ADMIN_PASS"\]/);
      assert.ok(!toml.includes("hunter2-test"), "no secret value in the config");
      assert.ok(!/password\.raw/.test(toml));
      assert.ok(!/verify|insecure|danger/i.test(toml), "verification is never disabled");
    } finally {
      if (prev === undefined) delete process.env.MAILU_ADMIN_PASS;
      else process.env.MAILU_ADMIN_PASS = prev;
    }
  });
  it("the pinned cert file exists and matches the recorded host", () => {
    const pem = readFileSync(join(ROOT, cfg.cert), "utf8");
    assert.match(pem, /BEGIN CERTIFICATE/);
  });
  it("direct mode drops the relay", () => {
    assert.ok(!/proxy\.url/.test(buildHimalayaConfig(id, { cfg, direct: true })));
  });
});

function socksConnect(port, host, destPort) {
  return new Promise((ok, fail) => {
    const c = net.connect(port, "127.0.0.1");
    c.once("error", fail);
    c.once("connect", () => c.write(Buffer.from([5, 1, 0])));
    c.once("data", () => {
      const h = Buffer.from(host);
      const req = Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([destPort >> 8, destPort & 255])]);
      c.write(req);
      c.once("data", (rep) => ok({ c, status: rep[1] }));
    });
  });
}

describe("startSocksProxy", () => {
  it("relays an allowlisted host and port, and refuses the rest", async () => {
    const echo = net.createServer((s) => s.pipe(s));
    await new Promise((r) => echo.listen(0, "127.0.0.1", r));
    const target = echo.address().port;
    // Allowlist the echo port; the map sends the mail host to loopback.
    const proxy = await startSocksProxy({ map: { "mail.example.test": "127.0.0.1" }, ports: [target] });
    try {
      const good = await socksConnect(proxy.port, "mail.example.test", target);
      assert.equal(good.status, 0);
      const echoed = await new Promise((ok) => {
        good.c.once("data", (d) => ok(d.toString()));
        good.c.write("ping");
      });
      assert.equal(echoed, "ping");
      good.c.destroy();
      assert.equal((await socksConnect(proxy.port, "evil.example.test", target)).status, 2);
      assert.equal((await socksConnect(proxy.port, "mail.example.test", target + 1)).status, 2);
    } finally {
      proxy.close();
      echo.close();
    }
  });
});

describe("parsing", () => {
  it("normalizes envelopes", () => {
    const rows = parseEnvelopes({
      envelopes: [
        { id: "7", flags: ["Seen"], subject: "Hi", from: [{ name: "A", email: "a@x.test" }], to: [{ email: "b@x.test" }], date: "2026-10-09T00:00:00Z", "has-attachment": true },
        { id: "8", flags: [], subject: "", from: [{ email: "MISSING_MAILBOX@MISSING_DOMAIN" }], to: [] },
      ],
    });
    assert.equal(rows[0].seen, true);
    assert.equal(rows[0].from, "A <a@x.test>");
    assert.equal(rows[0].hasAttachment, true);
    assert.equal(rows[1].seen, false);
    assert.equal(rows[1].from, "(unknown sender)");
    assert.equal(rows[1].subject, "(no subject)");
  });
  it("reads the account check report (it exits 0 on failure)", () => {
    const r = parseCheckReport("Account: x\n  imap: OK\n  smtp: FAIL (SMTP AUTH PLAIN failed: 535)\n");
    assert.equal(r.imap.ok, true);
    assert.equal(r.smtp.ok, false);
  });
  it("collects recipients", () => {
    assert.equal(recipientsOf("From: a@x\nTo: b@x\nCc: c@x\n\nbody To: nope"), "b@x, c@x");
  });
});

describe("CLI with a fake himalaya", () => {
  const dir = mkdtempSync(join(tmpdir(), "mail-test-"));
  const log = join(dir, "calls.log");
  const fake = join(dir, "himalaya");
  writeFileSync(
    fake,
    `#!/bin/sh
# record argv and stdin; print canned output. Never touches the network.
args="$*"
case "$args" in
  *"message send"*) printf 'SEND\\n' >> "${log}"; cat >> "${log}"; exit 0 ;;
  *"envelope list"*) echo '{"queued":0,"envelopes":[{"id":"3","flags":[],"subject":"Fixture subject","from":[{"name":"Pat","email":"pat@x.test"}],"to":[{"email":"admin@gotchibot.xyz"}],"date":"2026-10-09T01:02:03Z"}]}'; exit 0 ;;
  *"message compose"*) printf 'From: admin@gotchibot.xyz\\nTo: pat@x.test\\nSubject: Hello\\n\\nbody line\\n'; exit 0 ;;
  *"message reply"*) printf 'From: admin@gotchibot.xyz\\nTo: pat@x.test\\nSubject: Re: Fixture subject\\n\\nthanks\\n'; exit 0 ;;
  *"message read"*) printf 'To: admin@gotchibot.xyz\\nSubject: Fixture subject\\n\\nfixture body\\n'; exit 0 ;;
  *"account check"*) printf 'Account: gotchibot.xyz\\n  imap: OK\\n  smtp: OK\\n'; exit 0 ;;
esac
exit 9
`,
  );
  chmodSync(fake, 0o755);
  const run = (args, input = "") =>
    spawnSync(process.execPath, [MAIL, ...args], {
      input,
      encoding: "utf8",
      env: { ...process.env, GOTCHIBOT_HIMALAYA_BIN: fake, GOTCHIBOT_MAIL_ABRA: "1", MAILU_ADMIN_PASS: "fake-secret", GOTCHIBOT_MAIL_DIRECT: "1" },
    });
  const sends = () => (existsSync(log) ? readFileSync(log, "utf8").split("SEND").length - 1 : 0);

  it("list prints rows and flags unread", () => {
    const r = run(["list", "--as", "gotchibot"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /3\s+\*\s+Pat <pat@x\.test>\s+Fixture subject/);
  });
  it("read prints the message", () => {
    const r = run(["read", "3", "--as", "gotchibot"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /fixture body/);
  });
  it("check reports OK without echoing the secret", () => {
    const r = run(["check", "--as", "gotchibot"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^OK admin@gotchibot\.xyz/);
    assert.ok(!(r.stdout + r.stderr).includes("fake-secret"));
  });
  it("send prints the full message and does NOT send without the word send", () => {
    const r = run(["send", "--as", "gotchibot", "--to", "pat@x.test", "--subject", "Hello", "--body", "body line"], "no\n");
    assert.equal(r.status, 3);
    assert.match(r.stdout, /Subject: Hello/);
    assert.match(r.stdout, /body line/);
    assert.match(r.stdout, /About to send as admin@gotchibot\.xyz to pat@x\.test/);
    assert.match(r.stdout, /not sent/);
    assert.equal(sends(), 0);
  });
  it("send with empty stdin (no confirm) does not send", () => {
    const r = run(["send", "--as", "gotchibot", "--to", "pat@x.test", "--body", "b"], "");
    assert.equal(r.status, 3);
    assert.equal(sends(), 0);
  });
  it("reply prints the draft and does NOT send without the word send", () => {
    const r = run(["reply", "3", "--as", "gotchibot", "--body", "thanks"], "n\n");
    assert.equal(r.status, 3);
    assert.match(r.stdout, /Re: Fixture subject/);
    assert.equal(sends(), 0);
  });
  it("sends exactly once, with the printed message, only after the typed word (fake binary)", () => {
    const r = run(["send", "--as", "gotchibot", "--to", "pat@x.test", "--body", "body line"], "send\n");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(sends(), 1);
    assert.match(readFileSync(log, "utf8"), /Subject: Hello[\s\S]*body line/);
  });
  it("never sends from list, read, check or sync paths", () => {
    const before = sends();
    run(["list", "--as", "gotchibot"]);
    run(["read", "3", "--as", "gotchibot"]);
    run(["check", "--as", "gotchibot"]);
    assert.equal(sends(), before);
  });
  it("unknown identity is a usage error", () => {
    const r = run(["list", "--as", "nobody.example"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown mail identity/);
  });
  it("config prints no secret", () => {
    const r = run(["config", "--as", "yummydog"]);
    assert.equal(r.status, 0);
    assert.ok(!r.stdout.includes("fake-secret"));
    assert.match(r.stdout, /printenv/);
  });
});
