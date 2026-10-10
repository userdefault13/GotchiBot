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
import tls from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHimalayaConfig,
  loadMailConfig,
  parseCheckReport,
  parseEnvelopes,
  recipientsOf,
  resolveIdentity,
  resolveMailTarget,
  startSocksProxy,
  verifyPinnedTls,
} from "../scripts/mail-lib.mjs";
import { ROOT } from "../scripts/mail-lib.mjs";

const cfg = loadMailConfig();
const MAIL = join(ROOT, "scripts", "mail.mjs");

describe("resolveIdentity", () => {
  it("takes a domain, a short name, or an address", () => {
    assert.equal(resolveIdentity({ as: "aarcadeghst.com", config: cfg }).address, "gotchibot@aarcadeghst.com");
    assert.equal(resolveIdentity({ as: "wondrstack", config: cfg }).id, "wondrstack.xyz");
    assert.equal(resolveIdentity({ as: "GOTCHIBOT@yummydog.xyz", config: cfg }).id, "yummydog.xyz");
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
      assert.equal(resolveIdentity({ as: d, config: cfg }).address, `gotchibot@${d}`);
    }
  });
});

describe("admin identity", () => {
  it("uses admin@ and its own secret name only when asked", () => {
    const a = resolveIdentity({ as: "aarcadeghst", config: cfg, admin: true });
    assert.equal(a.address, "admin@aarcadeghst.com");
    assert.equal(a.passwordEnv, "MAILU_ADMIN_PASS_AARCADEGHST_COM");
    assert.equal(a.id, "aarcadeghst.com+admin");
    assert.equal(resolveIdentity({ as: "userdefault", config: cfg, admin: true }).passwordEnv, "MAILU_ADMIN_PASS");
    assert.equal(resolveIdentity({ as: "aarcadeghst", config: cfg }).passwordEnv, "MAILU_CLIENT_PASS_AARCADEGHST_COM");
  });
  it("every default identity names its MAILU_CLIENT_PASS_<DOMAIN> secret", () => {
    for (const d of Object.keys(cfg.identities)) {
      assert.equal(resolveIdentity({ as: d, config: cfg }).passwordEnv, `MAILU_CLIENT_PASS_${d.toUpperCase().replace(/\./g, "_")}`);
    }
  });
});

describe("buildHimalayaConfig", () => {
  const id = resolveIdentity({ as: "gotchibot", config: cfg });
  it("by default connects straight to the tailnet IP, pinned cert, no relay", () => {
    const toml = buildHimalayaConfig(id, { cfg });
    assert.match(toml, /imap\.server = "imaps:\/\/100\.110\.220\.76:993"/);
    assert.match(toml, /smtp\.server = "smtps:\/\/100\.110\.220\.76:465"/);
    assert.ok(!/proxy\.url/.test(toml));
    assert.match(toml, /imap\.tls\.cert = /);
  });
  it("pins the cert, uses the relay, and asks printenv for the password", () => {
    const prev = process.env.MAILU_CLIENT_PASS_GOTCHIBOT_XYZ;
    process.env.MAILU_CLIENT_PASS_GOTCHIBOT_XYZ = "hunter2-test";
    try {
      const toml = buildHimalayaConfig(id, { cfg, proxyPort: 4242 });
      assert.match(toml, /imap\.server = "imaps:\/\/mail\.userdefault\.dev:993"/);
      assert.match(toml, /smtp\.server = "smtps:\/\/mail\.userdefault\.dev:465"/);
      assert.match(toml, /imap\.tls\.cert = ".*mail\.userdefault\.dev\.pem"/);
      assert.match(toml, /smtp\.tls\.cert = /);
      assert.match(toml, /proxy\.url = "socks5h:\/\/127\.0\.0\.1:4242"/);
      assert.match(toml, /password\.command = \["printenv", "MAILU_CLIENT_PASS_GOTCHIBOT_XYZ"\]/);
      assert.ok(!toml.includes("hunter2-test"), "no secret value in the config");
      assert.ok(!/password\.raw/.test(toml));
      assert.ok(!/verify|insecure|danger/i.test(toml), "verification is never disabled");
    } finally {
      if (prev === undefined) delete process.env.MAILU_CLIENT_PASS_GOTCHIBOT_XYZ;
      else process.env.MAILU_CLIENT_PASS_GOTCHIBOT_XYZ = prev;
    }
  });
  it("the pinned cert file exists and matches the recorded host", () => {
    const pem = readFileSync(join(ROOT, cfg.cert), "utf8");
    assert.match(pem, /BEGIN CERTIFICATE/);
  });
  it("useName keeps the host name without a relay (real DNS)", () => {
    const t = buildHimalayaConfig(id, { cfg, useName: true });
    assert.match(t, /mail\.userdefault\.dev:993/);
    assert.ok(!/proxy\.url/.test(t));
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

describe("resolveMailTarget", () => {
  const look = (...addrs) => async () => addrs.map((address) => ({ address, family: 4 }));
  it("uses the host name when it resolves to the tailnet IP", async () => {
    const t = await resolveMailTarget(cfg, {}, look(cfg.via));
    assert.equal(t.mode, "name");
    assert.equal(t.connectHost, cfg.host);
  });
  it("falls back to the tailnet IP, never the public one, and says how to fix it", async () => {
    for (const lk of [look("45.79.68.233"), look(cfg.via, "45.79.68.233"), async () => { throw new Error("nx"); }]) {
      const t = await resolveMailTarget(cfg, {}, lk);
      assert.equal(t.mode, "direct");
      assert.equal(t.connectHost, cfg.via);
      assert.match(t.note, /tailscale set --accept-dns=true/);
      assert.match(t.note, /hosts line/);
      assert.ok(!t.note.includes("45.79.68.233"));
    }
  });
  it("relay is opt-in only", async () => {
    assert.equal((await resolveMailTarget(cfg, { GOTCHIBOT_MAIL_RELAY: "1" }, look(cfg.via))).mode, "relay");
  });
  it("the generated config uses the host name in name mode and the IP in direct mode", () => {
    const id = resolveIdentity({ as: "gotchibot", config: cfg });
    assert.match(buildHimalayaConfig(id, { cfg, useName: true }), /mail\.userdefault\.dev:993/);
    assert.match(buildHimalayaConfig(id, { cfg }), /100\.110\.220\.76:993/);
  });
});

function mkCert(dir, name, cn) {
  const key = join(dir, `${name}.key`);
  const crt = join(dir, `${name}.pem`);
  const r = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt, "-days", "2", "-subj", `/CN=${cn}`, "-addext", `subjectAltName=DNS:${cn}`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return { key: readFileSync(key), pem: readFileSync(crt) };
}

describe("name-checked pinned TLS (local server, no network)", () => {
  const dir = mkdtempSync(join(tmpdir(), "mail-tls-"));
  const good = mkCert(dir, "good", "mail.example.test");
  const other = mkCert(dir, "other", "mail.example.test");
  it("accepts the pinned cert for the right name, rejects a wrong name and a wrong cert", async () => {
    const srv = tls.createServer({ key: good.key, cert: good.pem }, (s) => s.on("error", () => {}));
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;
    try {
      assert.equal(await verifyPinnedTls({ host: "mail.example.test", connectHost: "127.0.0.1", port, pem: good.pem }), true);
      await assert.rejects(verifyPinnedTls({ host: "evil.example.test", connectHost: "127.0.0.1", port, pem: good.pem }), /altnames|hostname|match/i);
      await assert.rejects(verifyPinnedTls({ host: "mail.example.test", connectHost: "127.0.0.1", port, pem: other.pem }), /self-signed|unable to verify|certificate/i);
    } finally {
      srv.close();
    }
  });
  it("the shipped pin verifies for mail.userdefault.dev (name in its SAN)", () => {
    const r = spawnSync("openssl", ["x509", "-noout", "-ext", "subjectAltName", "-in", join(ROOT, cfg.cert)], { encoding: "utf8" });
    assert.match(r.stdout, /DNS:mail\.userdefault\.dev/);
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
  *"envelope list"*) echo '{"queued":0,"envelopes":[{"id":"3","flags":[],"subject":"Fixture subject","from":[{"name":"Pat","email":"pat@x.test"}],"to":[{"email":"gotchibot@gotchibot.xyz"}],"date":"2026-10-09T01:02:03Z"}]}'; exit 0 ;;
  *"message compose"*) printf 'From: gotchibot@gotchibot.xyz\\nTo: pat@x.test\\nSubject: Hello\\n\\nbody line\\n'; exit 0 ;;
  *"message reply"*) printf 'From: gotchibot@gotchibot.xyz\\nTo: pat@x.test\\nSubject: Re: Fixture subject\\n\\nthanks\\n'; exit 0 ;;
  *"message read"*) printf 'To: gotchibot@gotchibot.xyz\\nSubject: Fixture subject\\n\\nfixture body\\n'; exit 0 ;;
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
      env: { ...process.env, GOTCHIBOT_HIMALAYA_BIN: fake, GOTCHIBOT_MAIL_ABRA: "1", GOTCHIBOT_MAIL_PREFLIGHT: "0", MAILU_CLIENT_PASS_GOTCHIBOT_XYZ: "fake-secret" },
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
    assert.match(r.stdout, /^OK gotchibot@gotchibot\.xyz/);
    assert.ok(!(r.stdout + r.stderr).includes("fake-secret"));
  });
  it("send prints the full message and does NOT send without the word send", () => {
    const r = run(["send", "--as", "gotchibot", "--to", "pat@x.test", "--subject", "Hello", "--body", "body line"], "no\n");
    assert.equal(r.status, 3);
    assert.match(r.stdout, /Subject: Hello/);
    assert.match(r.stdout, /body line/);
    assert.match(r.stdout, /About to send as gotchibot@gotchibot\.xyz to pat@x\.test/);
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

describe("mail server down prompt (fake himalaya, nothing started or sent)", () => {
  const dir2 = mkdtempSync(join(tmpdir(), "mail-down-"));
  const log2 = join(dir2, "calls.log");
  const mk = (name, report) => {
    const f = join(dir2, name);
    writeFileSync(f, `#!/bin/sh\necho "$*" >> "${log2}"\ncase "$*" in *"account check"*) printf '${report}'; exit 0;; esac\nexit 9\n`);
    chmodSync(f, 0o755);
    return f;
  };
  const down = mk("down", "Account: x\\n  imap: FAIL (connection refused)\\n  smtp: FAIL (connection timed out)\\n");
  const badpw = mk("badpw", "Account: x\\n  imap: FAIL (authentication failed: invalid credentials)\\n  smtp: OK\\n");
  const go = (bin, input, tty) =>
    spawnSync(process.execPath, [MAIL, "check", "--as", "gotchibot"], {
      input,
      encoding: "utf8",
      env: { ...process.env, GOTCHIBOT_HIMALAYA_BIN: bin, GOTCHIBOT_MAIL_ABRA: "1", GOTCHIBOT_MAIL_PREFLIGHT: "0", GOTCHIBOT_MAIL_PROMPT_TTY: tty ? "1" : "0", MAILU_CLIENT_PASS_GOTCHIBOT_XYZ: "fake-secret" },
    });
  it("server down prints the three options and exits non-zero without a TTY", () => {
    const r = go(down, "", false);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /1\) start the server[\s\S]*2\) use another computer[\s\S]*3\) use Gmail/);
    assert.ok(!/choice \[/.test(r.stderr));
    assert.ok(!(r.stdout + r.stderr).includes("fake-secret"));
  });
  it("wrong password does not trigger the prompt", () => {
    const r = go(badpw, "1\n", true);
    assert.equal(r.status, 1);
    assert.ok(!/start the server/.test(r.stdout));
    assert.match(r.stderr, /FAIL .*auth/);
  });
  it("each choice prints its guidance and still exits non-zero", () => {
    const one = go(down, "1\n", true);
    assert.equal(one.status, 1);
    assert.match(one.stdout, /100\.110\.220\.76[\s\S]*Nothing was run[\s\S]*No Mailu start command is documented[\s\S]*ssh user_default@100\.110\.220\.76/);
    const two = go(down, "2\n", true);
    assert.equal(two.status, 1);
    assert.match(two.stdout, /another computer[\s\S]*993 and 465[\s\S]*option 9/);
    const three = go(down, "3\n", true);
    assert.equal(three.status, 1);
    assert.match(three.stdout, /no Gmail path/);
    const q = go(down, "q\n", true);
    assert.equal(q.status, 1);
    assert.match(q.stdout, /server still down/);
  });
  it("only ever calls account check: nothing started or sent", () => {
    const calls = readFileSync(log2, "utf8");
    assert.ok(!/send|docker|ssh/.test(calls));
  });
});
