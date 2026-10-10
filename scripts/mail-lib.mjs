/**
 * gotchibot mail — library. himalaya CLI against the self-hosted Mailu.
 *
 * No secret ever lands in a file or argv: the generated himalaya config asks
 * `printenv <passwordEnv>` for the password, and the env comes from abra at
 * invocation. TLS is verified end to end against the pinned cert for the
 * Mailu host; reaching the tailnet box is done by an allowlisted loopback
 * SOCKS5 relay that only maps that one host name to its tailnet IP.
 */
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import dns from "node:dns";
import net from "node:net";
import tls from "node:tls";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MAIL_CONFIG = join(ROOT, "config", "mail", "identities.json");

export function loadMailConfig(path = MAIL_CONFIG) {
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  if (!cfg.identities || typeof cfg.identities !== "object") throw new Error("mail config has no identities");
  return cfg;
}

function validList(cfg) {
  return Object.keys(cfg.identities).join(", ");
}

/** --as accepts a domain, a short name (aarcadeghst), or a full address. */
export function resolveIdentity({ as, project, config, admin = false } = {}) {
  const cfg = config || loadMailConfig();
  const ids = cfg.identities;
  const want = String(as || "").trim().toLowerCase();
  let domain = null;
  if (want) {
    if (ids[want]) domain = want;
    else {
      const byAddr = Object.keys(ids).find((d) => String(ids[d].address).toLowerCase() === want);
      const byShort = Object.keys(ids).find((d) => d.split(".")[0] === want);
      domain = byAddr || byShort || null;
    }
    if (!domain) throw new Error(`unknown mail identity "${as}" (valid: ${validList(cfg)})`);
  } else {
    const slug = String(project || "").trim();
    domain = (slug && cfg.projects?.[slug]) || cfg.defaultIdentity;
    if (!domain || !ids[domain]) throw new Error(`no default mail identity (valid: ${validList(cfg)})`);
  }
  const base = ids[domain];
  // The default login is the per-use mailbox; admin@ only when asked (--admin).
  const id = admin ? { ...base, ...(base.admin || {}) } : base;
  return {
    id: admin ? `${domain}+admin` : domain,
    domain,
    admin: Boolean(admin),
    address: id.address,
    displayName: id.displayName || domain,
    passwordEnv: id.passwordEnv || cfg.passwordEnv || "MAILU_ADMIN_PASS",
  };
}

const q = (s) => JSON.stringify(String(s));

/** himalaya v2 TOML. Holds no password, only the command that asks for it. */
export function buildHimalayaConfig(identity, { cfg, certPath, proxyPort = null, useName = false } = {}) {
  const c = cfg || loadMailConfig();
  const cert = certPath || (isAbsolute(c.cert) ? c.cert : join(ROOT, c.cert));
  // Default: connect straight to the tailnet IP and trust only the pinned cert.
  // himalaya has no separate TLS server-name setting, so name-based routing
  // needs the relay (proxyPort) or real DNS (useName).
  const host = proxyPort || useName ? c.host : c.via;
  const cmd = `["printenv", ${q(identity.passwordEnv)}]`;
  const lines = [
    `[accounts.${q(identity.id)}]`,
    "default = true",
    `email = ${q(identity.address)}`,
    `display-name = ${q(identity.displayName)}`,
    'message.send.save-copy = "sent"',
  ];
  if (proxyPort) lines.push(`proxy.url = ${q(`socks5h://127.0.0.1:${proxyPort}`)}`);
  lines.push(
    `imap.server = ${q(`imaps://${host}:${c.imapPort || 993}`)}`,
    `imap.tls.cert = ${q(cert)}`,
    `imap.sasl.plain.username = ${q(identity.address)}`,
    `imap.sasl.plain.password.command = ${cmd}`,
    `smtp.server = ${q(`smtps://${host}:${c.smtpPort || 465}`)}`,
    `smtp.tls.cert = ${q(cert)}`,
    `smtp.sasl.plain.username = ${q(identity.address)}`,
    `smtp.sasl.plain.password.command = ${cmd}`,
    "",
  );
  return lines.join("\n");
}

/**
 * Loopback SOCKS5 (no auth, domain-name CONNECT only). `map` is host -> ip,
 * `ports` the allowed destination ports. Everything else is refused.
 */
export function startSocksProxy({ map, ports = [993, 465, 587] } = {}) {
  const allowed = new Set(ports);
  const sockets = new Set();
  const refuse = (c, code) => c.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]));
  const server = net.createServer((c) => {
    sockets.add(c);
    c.on("close", () => sockets.delete(c));
    c.on("error", () => {});
    c.once("data", (hello) => {
      if (hello[0] !== 5) return c.destroy();
      c.write(Buffer.from([5, 0]));
      c.once("data", (b) => {
        if (b[0] !== 5 || b[1] !== 1 || b[3] !== 3) return refuse(c, 8);
        const n = b[4];
        const host = b.subarray(5, 5 + n).toString().toLowerCase();
        const port = b.readUInt16BE(5 + n);
        const target = map[host];
        if (!target || !allowed.has(port)) return refuse(c, 2);
        const [ip, portOverride] = Array.isArray(target) ? target : [target, port];
        const u = net.connect(portOverride, ip, () => {
          c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          c.pipe(u);
          u.pipe(c);
        });
        sockets.add(u);
        u.on("close", () => sockets.delete(u));
        u.on("error", () => c.destroy());
        c.on("close", () => u.destroy());
      });
    });
  });
  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () =>
      ok({
        port: server.address().port,
        close: () => {
          for (const s of sockets) s.destroy();
          server.close();
        },
      }),
    );
  });
}

export function parseEnvelopes(json) {
  const doc = typeof json === "string" ? JSON.parse(json) : json;
  const list = Array.isArray(doc) ? doc : doc?.envelopes || [];
  const who = (arr) =>
    (Array.isArray(arr) ? arr : [])
      .map((a) => {
        const email = String(a?.email || "");
        if (!email || email.startsWith("MISSING_MAILBOX")) return "";
        return a.name ? `${a.name} <${email}>` : email;
      })
      .filter(Boolean)
      .join(", ");
  return list.map((e) => ({
    id: String(e.id),
    from: who(e.from) || "(unknown sender)",
    to: who(e.to),
    subject: String(e.subject || "(no subject)"),
    date: e.date || "",
    seen: (e.flags || []).some((f) => String(f).replace(/^\\/, "").toLowerCase() === "seen"),
    hasAttachment: e["has-attachment"] === true,
  }));
}

export function formatMessageForConfirm(raw, { address, recipients } = {}) {
  const bar = "─".repeat(60);
  const tail = address ? `\nAbout to send as ${address}${recipients ? ` to ${recipients}` : ""}.` : "";
  return `${bar}\n${String(raw).replace(/\r\n/g, "\n").trimEnd()}\n${bar}${tail}`;
}

export function recipientsOf(raw) {
  const head = String(raw).replace(/\r\n/g, "\n").split(/\n\n/)[0].replace(/\n[ \t]+/g, " ");
  const out = [];
  for (const m of head.matchAll(/^(to|cc|bcc):\s*(.*)$/gim)) out.push(m[2].trim());
  return out.join(", ");
}

/**
 * himalaya trusts a pinned cert but does not compare its name to the host
 * (proved: a pinned other.example cert was accepted for localhost). So the name
 * check is done here, in Node, with the same pinned cert and the stock
 * hostname check, before himalaya connects.
 */
export function verifyPinnedTls({ host, connectHost, port, pem, timeoutMs = 8000 }) {
  return new Promise((ok, fail) => {
    const sock = tls.connect({ host: connectHost || host, port, servername: host, ca: pem, rejectUnauthorized: true, timeout: timeoutMs });
    const done = (err) => {
      sock.destroy();
      err ? fail(err) : ok(true);
    };
    sock.once("secureConnect", () => done(null));
    sock.once("timeout", () => done(new Error("tls preflight timed out")));
    sock.once("error", (e) => done(e));
  });
}

/**
 * Pick how to reach the mail host. Name mode needs the name to resolve to the
 * tailnet IP; otherwise direct-IP (never the public address). Relay is opt-in.
 */
export async function resolveMailTarget(cfg, env = process.env, lookup = (h) => dns.promises.lookup(h, { all: true, family: 4 })) {
  if (env.GOTCHIBOT_MAIL_RELAY === "1") return { mode: "relay" };
  let addrs = [];
  try {
    addrs = (await lookup(cfg.host)).map((a) => a.address);
  } catch {
    /* unresolved: fall back */
  }
  if (addrs.length && addrs.every((a) => a === cfg.via)) return { mode: "name", connectHost: cfg.host };
  return {
    mode: "direct",
    connectHost: cfg.via,
    note: `note: ${cfg.host} does not resolve to ${cfg.via} on this desk; using the tailnet IP. Run \`tailscale set --accept-dns=true\` or add the hosts line "${cfg.via} ${cfg.host}".`,
  };
}

/**
 * Run himalaya for one identity. Starts the loopback relay, writes the
 * credential-free config to a 0600 temp dir, removes both afterwards.
 * Returns { code, stdout, stderr }.
 */
let noted = false;

export async function runHimalaya(args, { identity, input, cfg, env = process.env } = {}) {
  const c = cfg || loadMailConfig();
  const target = await resolveMailTarget(c, env);
  if (target.note && !noted) {
    noted = true;
    process.stderr.write(`${target.note}\n`);
  }
  // The fake-binary tests run offline; the preflight is never skipped for real himalaya.
  const skip = env.GOTCHIBOT_MAIL_PREFLIGHT === "0" && env.GOTCHIBOT_HIMALAYA_BIN;
  if (target.mode !== "relay" && !skip) {
    const pem = readFileSync(isAbsolute(c.cert) ? c.cert : join(ROOT, c.cert));
    try {
      await verifyPinnedTls({ host: c.host, connectHost: target.connectHost, port: c.imapPort || 993, pem });
    } catch (e) {
      return { code: 1, stdout: "", stderr: `certificate check failed (${e.code || e.message})` };
    }
  }
  const proxy = target.mode === "relay" ? await startSocksProxy({ map: { [c.host.toLowerCase()]: c.via } }) : null;
  const dir = mkdtempSync(join(tmpdir(), "gotchibot-mail-"));
  try {
    chmodSync(dir, 0o700);
    const file = join(dir, "config.toml");
    writeFileSync(file, buildHimalayaConfig(identity, { cfg: c, proxyPort: proxy?.port, useName: target.mode === "name" }), { mode: 0o600 });
    const bin = env.GOTCHIBOT_HIMALAYA_BIN || "himalaya";
    return await new Promise((ok) => {
      const p = spawn(bin, ["-c", file, "-a", identity.id, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (d) => (stdout += d));
      p.stderr.on("data", (d) => (stderr += d));
      p.on("error", (e) => ok({ code: 127, stdout, stderr: `${bin}: ${e.message}` }));
      p.on("close", (code) => ok({ code: code ?? 1, stdout, stderr }));
      p.stdin.on("error", () => {});
      p.stdin.end(input ?? "");
    });
  } finally {
    proxy?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Classify a himalaya failure without ever echoing credentials. */
export function failStage(stderr) {
  const s = String(stderr || "").toLowerCase();
  if (/socks|proxy|refused|unreachable|timed out|timeout/.test(s)) return "network/proxy";
  if (/certificate|tls|handshake|unknownissuer|notvalidforname/.test(s)) return "tls/cert";
  if (/auth|login|credentials|password|no\b.*\bpermission/.test(s)) return "auth";
  return "other";
}

/** True when the server could not be reached (not a wrong password, not a bad cert). */
export function isServerDown(text) {
  const s = String(text || "").toLowerCase();
  return /socks|proxy|refused|unreachable|timed out|timeout|no route|name or service not known|nodename|getaddrinfo|enotfound|dns|resolve|tailscale|network is down|connection reset/.test(s);
}

/** `himalaya account check` exits 0 even on failure; read its report. */
export function parseCheckReport(stdout) {
  const out = {};
  for (const m of String(stdout).matchAll(/^\s*(\w+):\s*(OK|FAIL)(?:\s*\((.*)\))?\s*$/gim)) {
    out[m[1].toLowerCase()] = { ok: m[2].toUpperCase() === "OK", reason: m[3] || "" };
  }
  return out;
}
