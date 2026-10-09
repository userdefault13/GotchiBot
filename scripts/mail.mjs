#!/usr/bin/env node
/**
 * gotchibot mail — terminal mail for the self-hosted Mailu (himalaya).
 *
 *   gotchibot mail list|read|reply|send|check|sync|identities|config --as <identity>
 *
 * send and reply print the whole message and send only after the word
 * `send` is typed. Nothing here sends on its own, and nothing auto-replies.
 * Exit codes: 0 ok, 1 error, 2 usage, 3 not sent.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import readline from "node:readline";
import { isMainModule } from "./is-main.mjs";
import {
  ROOT,
  buildHimalayaConfig,
  failStage,
  formatMessageForConfirm,
  loadMailConfig,
  parseCheckReport,
  parseEnvelopes,
  recipientsOf,
  resolveIdentity,
  runHimalaya,
} from "./mail-lib.mjs";

const USAGE = `usage: gotchibot mail <command> [--as <identity>]

  list [-n N] [--mailbox M] [--json]       newest first, * = unread
  read <id> [--mailbox M] [--raw] [--seen] read one message (leaves it unread unless --seen)
  reply <id> [--body T | --body-file F]    draft a reply, print it, send only after you type "send"
  send --to A [--cc A] [--subject S] (--body T | --body-file F)
                                           print the message, send only after you type "send"
  check                                    prove login + pinned TLS (no mail is read or sent)
  sync [--all]                             cache the newest 25 headers for the inbox pane (read-only)
  identities                               list identities
  config                                   print the generated himalaya config (no password in it)

--as takes a domain (aarcadeghst.com), a short name (aarcadeghst) or an address.
Without --as the active project picks the identity. Credentials come from abra.
`;

export function parseArgs(argv) {
  const out = { _: [], flags: {} };
  const valued = new Set(["as", "n", "mailbox", "to", "cc", "bcc", "subject", "body", "body-file"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-n") out.flags.n = argv[++i];
    else if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) out.flags[k] = v;
      else if (valued.has(k)) out.flags[k] = argv[++i];
      else out.flags[k] = true;
    } else out._.push(a);
  }
  return out;
}

function projectSlug() {
  try {
    return process.env.GOTCHIBOT_PROJECT || readFileSync(join(ROOT, "sessions", ".current-project"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

async function currentSlug() {
  try {
    const m = await import("./project-context.mjs");
    return m.currentProjectSlug();
  } catch {
    return projectSlug();
  }
}

/** Re-run once under abra so the password env exists. Never echoes it. */
function ensureCredentials(identity, cfg) {
  if (process.env[identity.passwordEnv] || process.env.GOTCHIBOT_MAIL_ABRA === "1") return;
  const r = spawnSync(
    "abra",
    ["run", "-p", cfg.abraProject || "gotchibot", "--", process.execPath, ...process.argv.slice(1)],
    { stdio: "inherit", env: { ...process.env, GOTCHIBOT_MAIL_ABRA: "1" } },
  );
  process.exit(r.status ?? 1);
}

function readLine(prompt) {
  return new Promise((ok) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: false });
    process.stderr.write(prompt);
    let done = false;
    rl.once("line", (l) => {
      done = true;
      rl.close();
      ok(l);
    });
    rl.once("close", () => !done && ok(""));
  });
}

async function confirmAndSend(raw, identity, cfg, io) {
  const recipients = recipientsOf(raw);
  io.out(`${formatMessageForConfirm(raw, { address: identity.address, recipients })}\n`);
  if (!recipients) {
    io.err("not sent: message has no recipients\n");
    return 3;
  }
  const answer = String(await readLine('Type "send" to send this message, anything else cancels: ')).trim();
  if (answer !== "send") {
    io.out("not sent\n");
    return 3;
  }
  const r = await runHimalaya(["message", "send"], { identity, input: raw, cfg });
  if (r.code !== 0) {
    io.err(`send failed (${failStage(r.stderr)}): ${r.stderr.trim().split("\n").slice(-2).join(" ")}\n`);
    return 1;
  }
  io.out(`sent as ${identity.address} to ${recipients}\n`);
  return 0;
}

function bodyOf(flags) {
  if (flags["body-file"]) return readFileSync(flags["body-file"], "utf8");
  if (typeof flags.body === "string") return flags.body;
  return null;
}

function pad(s, n) {
  const t = String(s);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t.padEnd(n);
}

export function formatList(rows) {
  if (!rows.length) return "(no messages)\n";
  return (
    rows
      .map((m) => `${pad(m.id, 5)} ${m.seen ? " " : "*"} ${pad(m.from, 28)} ${pad(m.subject, 46)} ${String(m.date).slice(0, 16)}`)
      .join("\n") + "\n"
  );
}

export function syncDoc(identity, rows, now = new Date().toISOString()) {
  return {
    identity: identity.id,
    address: identity.address,
    syncedAt: now,
    messages: rows.map((m) => ({
      id: `imap:${identity.id}:${m.id}`,
      uid: m.id,
      from: m.from,
      to: m.to,
      kind: "mail",
      subject: m.subject,
      body: "",
      ts: m.date || "",
      readAt: m.seen ? now : null,
      source: "mail",
      identity: identity.id,
    })),
  };
}

export function writeSyncDoc(dir, doc) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${doc.identity}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
  return file;
}

async function listRows(identity, cfg, { n = 25, mailbox } = {}) {
  const args = ["envelope", "list", "--json", "-s", String(n)];
  if (mailbox) args.push("-m", mailbox);
  const r = await runHimalaya(args, { identity, cfg });
  if (r.code !== 0) throw new Error(`list failed (${failStage(r.stderr)}): ${r.stderr.trim().split("\n").slice(-2).join(" ")}`);
  return parseEnvelopes(r.stdout);
}

export async function main(argv = process.argv.slice(2), io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  const { _: pos, flags } = parseArgs(argv);
  const cmd = pos[0];
  if (!cmd || flags.help || flags.h || cmd === "help") {
    io.out(USAGE);
    return cmd || flags.help ? 0 : 2;
  }
  const cfg = loadMailConfig();
  if (cmd === "identities") {
    const mark = (d) => (d === cfg.defaultIdentity ? " (default)" : "");
    for (const [d, v] of Object.entries(cfg.identities)) io.out(`${d.padEnd(18)} ${v.address}${mark(d)}\n`);
    return 0;
  }
  let identity;
  try {
    identity = resolveIdentity({ as: flags.as, project: await currentSlug(), config: cfg });
  } catch (e) {
    io.err(`${e.message}\n`);
    return 2;
  }
  if (cmd === "config") {
    io.out(buildHimalayaConfig(identity, { cfg, proxyPort: "<ephemeral>" }));
    return 0;
  }
  if (!["list", "read", "reply", "send", "check", "sync"].includes(cmd)) {
    io.err(USAGE);
    return 2;
  }
  ensureCredentials(identity, cfg);
  try {
    if (cmd === "check") {
      // account check opens IMAP and SMTP and authenticates on both; no mail moves.
      const r = await runHimalaya(["account", "check"], { identity, cfg });
      const rep = parseCheckReport(r.stdout);
      const bad = Object.entries(rep).filter(([, v]) => !v.ok);
      if (r.code !== 0 || !Object.keys(rep).length || bad.length) {
        const why = bad.map(([k, v]) => `${k}=${failStage(v.reason)}`).join(" ") || `stage=${failStage(r.stderr)}`;
        io.err(`FAIL ${identity.address} ${why}\n`);
        return 1;
      }
      io.out(`OK ${identity.address} (imaps ${cfg.host}:${cfg.imapPort} + smtps :${cfg.smtpPort}, pinned cert)\n`);
      return 0;
    }
    if (cmd === "list") {
      const rows = await listRows(identity, cfg, { n: Number(flags.n) || 25, mailbox: flags.mailbox });
      io.out(flags.json ? `${JSON.stringify(rows, null, 2)}\n` : formatList(rows));
      return 0;
    }
    if (cmd === "sync") {
      const targets = flags.all ? Object.keys(cfg.identities).map((d) => resolveIdentity({ as: d, config: cfg })) : [identity];
      let failed = 0;
      for (const t of targets) {
        try {
          const rows = await listRows(t, cfg, { n: 25 });
          writeSyncDoc(join(ROOT, "sessions", "mail"), syncDoc(t, rows));
          io.out(`synced ${t.address}: ${rows.length}\n`);
        } catch (e) {
          failed++;
          io.err(`${t.address}: ${e.message}\n`);
        }
      }
      return failed ? 1 : 0;
    }
    if (cmd === "read") {
      if (!pos[1]) return io.err("read needs an id\n"), 2;
      const args = ["message", "read", pos[1]];
      for (const f of ["raw", "seen"]) if (flags[f]) args.push(`--${f}`);
      if (flags.mailbox) args.push("-m", flags.mailbox);
      const r = await runHimalaya(args, { identity, cfg });
      if (r.code !== 0) return io.err(`read failed (${failStage(r.stderr)})\n`), 1;
      io.out(r.stdout);
      return 0;
    }
    if (cmd === "send") {
      const body = bodyOf(flags);
      if (!flags.to || body === null) return io.err("send needs --to and --body or --body-file\n"), 2;
      const args = ["message", "compose", "--from", identity.address, "--to", flags.to];
      if (flags.cc) args.push("--cc", flags.cc);
      if (flags.bcc) args.push("--bcc", flags.bcc);
      if (flags.subject) args.push("--subject", flags.subject);
      args.push("--body", body);
      const r = await runHimalaya(args, { identity, cfg });
      if (r.code !== 0) return io.err(`compose failed (${failStage(r.stderr)})\n`), 1;
      return confirmAndSend(r.stdout, identity, cfg, io);
    }
    if (cmd === "reply") {
      if (!pos[1]) return io.err("reply needs an id\n"), 2;
      const body = bodyOf(flags);
      if (body === null) return io.err("reply needs --body or --body-file\n"), 2;
      const args = ["message", "reply", pos[1], "--from", identity.address, "--body", body];
      if (flags.mailbox) args.push("-m", flags.mailbox);
      const r = await runHimalaya(args, { identity, cfg });
      if (r.code !== 0) return io.err(`reply draft failed (${failStage(r.stderr)})\n`), 1;
      return confirmAndSend(r.stdout, identity, cfg, io);
    }
  } catch (e) {
    io.err(`${e.message}\n`);
    return 1;
  }
  return 2;
}

if (isMainModule(import.meta.url)) {
  main().then((c) => process.exit(c), (e) => {
    process.stderr.write(`${e?.message || e}\n`);
    process.exit(1);
  });
}
