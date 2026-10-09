#!/usr/bin/env node
/**
 * Inbox pane — read project mail on the terminal desk.
 *
 * Store: sessions/pstack/<slug>/mail.json (the project mail binding).
 * Messages are that file's `messages` array. Shape matches the dossier INBOX
 * box: id, from, to, kind, subject, body, ts, readAt. No second mail file.
 *
 *   node scripts/inbox-pane.mjs watch
 *   node scripts/inbox-pane.mjs once
 *
 * Keys: j/k select · enter read · esc back · q leave
 * Open from the desk: orchestrator-layout.sh enter-inbox
 * Collapsed: label-bar-pane.sh Inbox (desk-active line).
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { isMainModule } from "./is-main.mjs";
import { currentProjectSlug, mailPath } from "./project-context.mjs";
import { loadMailConfig, resolveIdentity } from "./mail-lib.mjs";
import { publishProjectWrite, pullOpenProject, startHubProjectMirror } from "./hub-project-sync.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ESC = "\x1b";
const c = {
  reset: `${ESC}[0m`,
  dim: `${ESC}[38;5;245m`,
  bold: `${ESC}[1m`,
  yellow: `${ESC}[33m`,
  cyan: `${ESC}[36m`,
  orange: `${ESC}[38;5;208m`,
  gold: `${ESC}[38;5;220m`,
  pink: `${ESC}[38;5;213m`,
};

const SECRET_KEYS = new Set([
  "apiKey",
  "api_key",
  "AGENT_MAIL_API_KEY",
  "AGENTMAIL_API_KEY",
  "token",
  "secret",
]);

export function mailTsShort(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

function trunc(s, n) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (!t) return "—";
  return t.length > n ? `${t.slice(0, Math.max(0, n - 1))}…` : t;
}

function pkmKind(msg) {
  const sub = String(msg?.subject || "");
  const body = String(msg?.body || "");
  const m1 = sub.match(/pkm:(delegated|submitted|reviewed)\b/i);
  if (m1) return m1[1].toLowerCase();
  const m2 = body.match(/\bevent:\s*(delegated|submitted|reviewed)\b/i);
  if (m2) return m2[1].toLowerCase();
  return null;
}

function kindColor(kind, pkm) {
  if (pkm) return c.orange;
  const k = String(kind || "").toLowerCase();
  if (k === "alert") return c.orange;
  if (k === "ask") return c.yellow;
  if (k === "report") return c.cyan;
  return c.dim;
}

export function normalizeMailMessage(raw, index = 0) {
  const body = String(raw?.body ?? raw?.snippet ?? "").replace(/\r\n/g, "\n");
  const subjectRaw = String(raw?.subject || "").trim();
  const subject = subjectRaw || (body.trim() ? trunc(body, 80) : "(no subject)");
  return {
    id: String(raw?.id || `mail-${index}`),
    from: String(raw?.from || "?"),
    to: raw?.to ? String(raw.to) : "",
    kind: String(raw?.kind || "fyi").toLowerCase(),
    subject,
    body: body.trim(),
    ts: String(raw?.ts || raw?.createdAt || ""),
    readAt: raw?.readAt || null,
  };
}

/** Newest first. Does not reorder the file. */
export function listMailMessages(doc) {
  const raw = Array.isArray(doc?.messages) ? doc.messages : [];
  return raw
    .map((m, i) => normalizeMailMessage(m, i))
    .sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
}

/**
 * Mark one message read on a copy of the mail document.
 * Other binding fields (address, inboxId, …) stay put.
 */
export function markMailRead(doc, id, now = new Date().toISOString()) {
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.messages)) return null;
  const needle = String(id || "");
  if (!needle) return null;
  let message = null;
  let changed = false;
  const messages = doc.messages.map((raw, index) => {
    const norm = normalizeMailMessage(raw, index);
    if (norm.id !== needle || message) return raw;
    const readAt = raw.readAt || now;
    message = { ...norm, readAt };
    if (raw.readAt) return raw;
    changed = true;
    return { ...raw, id: norm.id, readAt: now };
  });
  if (!message) return null;
  return { mail: { ...doc, messages }, message, changed };
}

export function readMailDocument(file) {
  if (!file) return null;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const j = JSON.parse(text);
    if (!j || typeof j !== "object" || Array.isArray(j)) return { messages: [] };
    return j;
  } catch {
    return { messages: [] };
  }
}

export function writeMailDocument(file, doc) {
  const safe = { ...doc };
  for (const key of SECRET_KEYS) delete safe[key];
  writeFileSync(file, `${JSON.stringify(safe, null, 2)}\n`, "utf8");
  publishProjectWrite(file, { root: ROOT });
  return safe;
}

/**
 * Project mail (mail.json) wins when it has messages. Otherwise the pane shows
 * the bot inbox (inbox/inbox.json), which is what the Hub keeps for the room.
 */
export function chooseInboxDocument(mailDoc, botDoc) {
  const mail = listMailMessages(mailDoc);
  const bot = listMailMessages(botDoc);
  if (mail.length) return { which: "mail", doc: mailDoc, messages: mail };
  if (bot.length) return { which: "bot", doc: botDoc, messages: bot };
  return { which: "mail", doc: mailDoc || { messages: [] }, messages: [] };
}

/** Load, mark read, write back. Returns the opened message, or null. */
export function openMailMessage(file, id, now = new Date().toISOString()) {
  const doc = readMailDocument(file);
  if (!doc) return null;
  const marked = markMailRead(doc, id, now);
  if (!marked) return null;
  if (marked.changed) writeMailDocument(file, marked.mail);
  return marked.message;
}

function wrapText(text, width) {
  const w = Math.max(8, width);
  const out = [];
  for (const para of String(text || "").split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (next.length > w && line) {
        out.push(line);
        line = word.length > w ? trunc(word, w) : word;
      } else {
        line = next.length > w ? trunc(next, w) : next;
      }
    }
    if (line) out.push(line);
  }
  return out.length ? out : [""];
}

function listRow(m, cols, selected) {
  const pkm = pkmKind(m);
  const color = kindColor(m.kind, pkm);
  const kindLabel = (pkm ? `pkm:${pkm}` : String(m.kind || "?")).slice(0, 12);
  const mark = m.readAt ? " " : `${c.yellow}•${c.reset}`;
  const caret = selected ? `${c.pink}›${c.reset}` : " ";
  const from = trunc(m.from || "?", 12);
  const to = m.to ? trunc(m.to, 10) : "";
  const rawSubj = String(m.subject || "(no subject)").replace(
    /^pkm:(delegated|submitted|reviewed)\s*[—\-]\s*/i,
    "",
  );
  const when = mailTsShort(m.ts);
  const subjW = Math.max(10, cols - 42);
  const head =
    `${caret}${mark}${color}${kindLabel.padEnd(12)}${c.reset} ` +
    `${c.dim}${from}${c.reset}${to ? `${c.dim}→${to}${c.reset}` : ""} ` +
    `${trunc(rawSubj, subjW)} ${c.dim}${when}${c.reset}`;
  const rows = [head];
  const preview = String(m.body || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^pkm:(delegated|submitted|reviewed)\s*[—\-]\s*/i, "");
  if (preview) {
    rows.push(`    ${c.dim}scope${c.reset} ${trunc(preview, Math.max(12, cols - 12))}`);
  }
  return rows;
}

/**
 * Paint the list or one open message.
 * `view` is "list" or "read".
 */
export function renderInboxView({
  view = "list",
  messages = [],
  selected = 0,
  message = null,
  activeLine = "",
  address = "",
  cols = 72,
  rows = 0,
  scroll = 0,
  identity = "",
  notice = "",
} = {}) {
  const keys = identity ? " · r reply · c compose · i identity · s sync" : "";
  const lines = [];
  if (activeLine) lines.push(`${c.dim}${activeLine}${c.reset}`);
  const msgs = Array.isArray(messages) ? messages : [];
  const unread = msgs.filter((m) => !m.readAt).length;
  lines.push(
    `${c.bold}INBOX${c.reset}  ${c.gold}${msgs.length}${c.reset} msg${msgs.length === 1 ? "" : "s"}` +
      (unread ? ` · ${c.yellow}${unread} unread${c.reset}` : ` · ${c.dim}all read${c.reset}`),
  );
  if (identity) {
    lines.push(`  ${c.dim}mail as${c.reset} ${c.cyan}${identity}${c.reset}${notice ? `  ${c.yellow}${notice}${c.reset}` : ""}`);
  }
  if (view === "read" && message) {
    const pkm = pkmKind(message);
    const color = kindColor(message.kind, pkm);
    const kindLabel = pkm ? `pkm:${pkm}` : String(message.kind || "fyi");
    const who = `${message.from || "?"}${message.to ? ` → ${message.to}` : ""}`;
    lines.push(`${color}${kindLabel}${c.reset}  ${c.dim}${who}${c.reset}  ${c.dim}${mailTsShort(message.ts)}${c.reset}`);
    lines.push(`${c.bold}${message.subject || "(no subject)"}${c.reset}`);
    lines.push("");
    const body = wrapText(message.body || "(no body)", Math.max(8, cols - 2));
    const start = Math.max(0, scroll);
    lines.push(...body.slice(start));
    lines.push("");
    lines.push(`${c.dim}esc back · j/k scroll${keys} · q chat${c.reset}`);
  } else if (!msgs.length) {
    lines.push(`  ${c.dim}(inbox empty)${c.reset}`);
    lines.push(
      `  ${c.dim}scope${c.reset} project mail${address ? ` · ${address}` : ""}`,
    );
    lines.push(`${c.dim}j/k select · enter read${keys} · q chat${c.reset}`);
  } else {
    lines.push(`  ${c.dim}scope${c.reset} project mail · kind, from, subject`);
    const sel = Math.max(0, Math.min(selected, msgs.length - 1));
    for (let i = 0; i < msgs.length; i++) {
      lines.push(...listRow(msgs[i], cols, i === sel));
    }
    lines.push("");
    lines.push(`${c.dim}j/k select · enter read${keys} · q chat${c.reset}`);
  }
  if (rows > 0 && lines.length > rows) return lines.slice(0, rows).join("\n");
  return lines.join("\n");
}


// Tests point this at a fixture dir; the cache is the only thing it moves.
const MAIL_SESSIONS = process.env.GOTCHIBOT_MAIL_SESSIONS || join(ROOT, "sessions");
const MAIL_SYNC_STALE_MS = 5 * 60 * 1000;

/**
 * Read-only mail source: the headers `gotchibot mail sync` cached under
 * sessions/mail/<identity>.json. Bodies are not cached; the read view says how
 * to open one. Sending never happens from the pane.
 */
export function mailSourceMessages(sessionsDir, identityId) {
  const out = [];
  let doc = null;
  try {
    doc = JSON.parse(readFileSync(join(sessionsDir, "mail", `${identityId}.json`), "utf8"));
  } catch {
    return out;
  }
  const ident = doc?.identity || identityId;
  for (const raw of Array.isArray(doc?.messages) ? doc.messages : []) {
    const uid = raw.uid ?? String(raw.id || "").split(":").pop();
    out.push(
      normalizeMailMessage(
        {
          ...raw,
          kind: "mail",
          body:
            raw.body ||
            `Open with: gotchibot mail read ${uid} --as ${ident}\nReply: gotchibot mail reply ${uid} --as ${ident} --body "..."  (asks before sending)`,
        },
        out.length,
      ),
    );
  }
  return out;
}

export function mergeMailSource(messages, mailMessages) {
  return [...messages, ...mailMessages].sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
}

let identityOverride = null;

function activeMailIdentity() {
  if (identityOverride) return identityOverride;
  try {
    return resolveIdentity({ project: currentProjectSlug(), config: loadMailConfig() }).id;
  } catch {
    return null;
  }
}

/** Next identity in config order (wraps). Pure. */
export function nextMailIdentity(ids, current) {
  const list = Array.isArray(ids) ? ids : [];
  if (!list.length) return null;
  const i = list.indexOf(current);
  return list[(i + 1) % list.length];
}

/**
 * argv for `gotchibot mail …` for each pane action. The pane never talks to the
 * mail server or sends itself: these run the CLI, whose send step prints the
 * whole message and waits for the typed word "send".
 */
export function mailPaneArgs(action, { identity, uid } = {}) {
  const as = ["--as", String(identity)];
  if (action === "read") return ["mail", "read", String(uid), ...as];
  if (action === "reply") return ["mail", "reply", String(uid), ...as, "--prompt"];
  if (action === "compose") return ["mail", "compose", ...as];
  if (action === "sync") return ["mail", "sync", ...as];
  throw new Error(`unknown mail action: ${action}`);
}

/** The CLI prints headers, a part summary line, then the text. Keep it as the body. */
export function mailBodyFromRead(stdout) {
  return String(stdout || "").replace(/\r\n/g, "\n").trim();
}

export function isMailMessage(m) {
  return Boolean(m && m.kind === "mail" && (m.uid || String(m.id).startsWith("imap:")));
}

function mailIdentityOf(m) {
  const parts = String(m.id).split(":");
  return parts.length >= 3 ? parts[1] : null;
}

function mailUid(m) {
  return m.uid ?? String(m.id).split(":").pop();
}


/** Refresh the cache in the background at most every 5 minutes. Opt out: GOTCHIBOT_MAIL_PANE_SYNC=0. */
function maybeSyncMail(identityId) {
  if (!identityId || process.env.GOTCHIBOT_MAIL_PANE_SYNC === "0") return;
  const file = join(MAIL_SESSIONS, "mail", `${identityId}.json`);
  try {
    if (Date.now() - statSync(file).mtimeMs < MAIL_SYNC_STALE_MS) return;
  } catch {
    /* no cache yet */
  }
  try {
    const p = spawn(join(ROOT, "scripts", "gotchibot"), ["mail", "sync", "--as", identityId], {
      detached: true,
      stdio: "ignore",
      timeout: 30000,
    });
    p.on("error", () => {});
    p.unref();
  } catch {
    /* pane stays usable without mail */
  }
}

function inboxFiles() {
  const slug = currentProjectSlug();
  if (!slug) return { mail: null, bot: null };
  return {
    mail: mailPath(slug),
    bot: join(ROOT, "sessions", "pstack", slug, "inbox", "inbox.json"),
  };
}

function loadInbox() {
  const files = inboxFiles();
  const mailDoc = files.mail ? readMailDocument(files.mail) : null;
  const botDoc = files.bot ? readMailDocument(files.bot) : null;
  const choice = chooseInboxDocument(mailDoc, botDoc);
  const file = choice.which === "bot" ? files.bot : files.mail;
  const ident = activeMailIdentity();
  const mailMsgs = ident ? mailSourceMessages(MAIL_SESSIONS, ident) : [];
  return { file, doc: choice.doc, messages: mergeMailSource(choice.messages, mailMsgs), mailIdentity: ident };
}

function readActiveLine() {
  try {
    return readFileSync(join(ROOT, "sessions/.desk-active.line"), "utf8").trim();
  } catch {
    return "";
  }
}

function termSize() {
  return {
    cols: output.columns || Number(process.env.COLUMNS) || 72,
    rows: output.rows || Number(process.env.LINES) || 24,
  };
}

function leaveToChat() {
  spawnSync("bash", [join(ROOT, "scripts/orchestrator-layout.sh"), "leave-inbox"], {
    cwd: ROOT,
    stdio: "ignore",
    env: process.env,
  });
}

async function runOnce() {
  try {
    await pullOpenProject({ root: ROOT });
  } catch {
    /* local copy */
  }
  const loaded = loadInbox();
  const doc = loaded.doc;
  const messages = loaded.messages;
  const text = renderInboxView({
    messages,
    address: doc?.address || "",
    activeLine: readActiveLine(),
    ...termSize(),
  });
  output.write(`${text}\n`);
}

function runWatch() {
  maybeSyncMail(activeMailIdentity());
  readline.emitKeypressEvents(input);
  if (input.isTTY) input.setRawMode(true);
  output.write(`${ESC}[?25l`);

  let view = "list";
  let selected = 0;
  let scroll = 0;
  let doc = null;
  let messages = [];
  let open = null;
  let notice = "";
  let identity = activeMailIdentity();
  const bodies = new Map();
  const cli = process.env.GOTCHIBOT_MAIL_CLI || join(ROOT, "scripts", "gotchibot");

  // Run the mail CLI with the terminal handed over (prompts, the printed
  // message and the typed "send" all happen there), then take the pane back.
  const external = (args, { pause = true } = {}) => {
    if (input.isTTY) input.setRawMode(false);
    input.pause();
    output.write(`${ESC}[2J${ESC}[H${ESC}[?25h`);
    const r = spawnSync(cli, args, { stdio: "inherit", env: { ...process.env, GOTCHIBOT_PROJECT: currentProjectSlug() || "" } });
    if (pause) {
      output.write(`\n${c.dim}— press enter to return to the inbox —${c.reset} `);
      spawnSync("sh", ["-c", "read _"], { stdio: "inherit" });
    }
    output.write(`${ESC}[?25l`);
    input.resume();
    if (input.isTTY) input.setRawMode(true);
    return r.status;
  };

  const captureMail = (args) => {
    const r = spawnSync(cli, args, { encoding: "utf8", timeout: 60000, env: { ...process.env, GOTCHIBOT_PROJECT: currentProjectSlug() || "" } });
    return { code: r.status, out: mailBodyFromRead(String(r.stdout || "").split("\n").filter((l) => !l.includes("injecting")).join("\n")) };
  };

  const load = () => {
    const loaded = loadInbox();
    doc = loaded.doc;
    messages = loaded.messages.map((m) => (bodies.has(m.id) ? { ...m, body: bodies.get(m.id) } : m));
    if (selected >= messages.length) selected = Math.max(0, messages.length - 1);
    if (view === "read" && open) {
      open = messages.find((m) => m.id === open.id) || open;
    }
  };

  const paint = () => {
    const term = termSize();
    const text = renderInboxView({
      view,
      messages,
      selected,
      message: open,
      activeLine: readActiveLine(),
      address: doc?.address || "",
      cols: term.cols,
      rows: Math.max(1, term.rows - 1),
      scroll,
      identity,
      notice,
    });
    output.write(`${ESC}[2J${ESC}[H${text}`);
  };

  const cleanup = () => {
    stopMirror();
    if (input.isTTY) input.setRawMode(false);
    output.write(`${ESC}[?25h${ESC}[0m`);
  };

  const signature = () => {
    const files = inboxFiles();
    const mt = (file) => {
      try {
        return String(statSync(file).mtimeMs);
      } catch {
        return "0";
      }
    };
    return `${files.mail}|${mt(files.mail)}|${files.bot}|${mt(files.bot)}|${readActiveLine()}`;
  };

  let stamp = signature();
  load();
  paint();
  const stopMirror = startHubProjectMirror({
    root: ROOT,
    onChange() {
      stamp = signature();
      load();
      paint();
    },
  });

  const onUsr = () => {
    stamp = signature();
    load();
    paint();
  };
  process.on("SIGUSR1", onUsr);
  output.on("resize", paint);
  const timer = setInterval(() => {
    const next = signature();
    if (next === stamp) return;
    stamp = next;
    load();
    paint();
  }, 1000);
  timer.unref?.();

  const stop = (code = 0) => {
    clearInterval(timer);
    cleanup();
    process.exit(code);
  };

  process.on("SIGINT", () => stop(0));
  process.on("SIGTERM", () => stop(0));

  input.on("keypress", (_str, key) => {
    if (!key) return;
    if (key.ctrl && key.name === "c") {
      stop(0);
      return;
    }
    if (key.name === "q") {
      cleanup();
      leaveToChat();
      process.exit(0);
    }
    const mailAction = (name) => {
      if (!identity) return false;
      if (name === "compose") {
        external(mailPaneArgs("compose", { identity }));
      } else if (name === "reply") {
        const m = view === "read" ? open : messages[selected];
        if (!isMailMessage(m)) {
          notice = "select a mail message to reply";
          paint();
          return true;
        }
        external(mailPaneArgs("reply", { identity: mailIdentityOf(m) || identity, uid: mailUid(m) }));
      } else if (name === "sync") {
        notice = "syncing…";
        paint();
        const r = captureMail(mailPaneArgs("sync", { identity }));
        notice = r.code === 0 ? "synced" : "sync failed";
      } else if (name === "identity") {
        const ids = Object.keys(loadMailConfig().identities);
        identityOverride = identity = nextMailIdentity(ids, String(identity).replace(/\+admin$/, ""));
        selected = 0;
        open = null;
        view = "list";
        notice = `switched to ${identity}`;
        maybeSyncMail(identity);
      }
      load();
      paint();
      return true;
    };
    if (key.name === "c" && !key.ctrl) return void mailAction("compose");
    if (key.name === "r" && !key.ctrl) return void mailAction("reply");
    if (key.name === "s" && !key.ctrl) return void mailAction("sync");
    if (key.name === "i" && !key.ctrl) return void mailAction("identity");
    if (view === "read") {
      if (key.name === "escape" || key.name === "backspace") {
        view = "list";
        scroll = 0;
        load();
        paint();
        return;
      }
      if (key.name === "j" || key.name === "down") {
        scroll += 1;
        paint();
        return;
      }
      if (key.name === "k" || key.name === "up") {
        scroll = Math.max(0, scroll - 1);
        paint();
        return;
      }
      return;
    }
    if (key.name === "j" || key.name === "down") {
      if (messages.length) selected = Math.min(messages.length - 1, selected + 1);
      paint();
      return;
    }
    if (key.name === "k" || key.name === "up") {
      selected = Math.max(0, selected - 1);
      paint();
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      const msg = messages[selected];
      if (!msg) return;
      if (isMailMessage(msg)) {
        if (!bodies.has(msg.id)) {
          notice = "opening…";
          paint();
          const r = captureMail(mailPaneArgs("read", { identity: mailIdentityOf(msg) || identity, uid: mailUid(msg) }));
          bodies.set(msg.id, r.code === 0 && r.out ? r.out : "(could not open this message; is abra unlocked and the tailnet up?)");
          notice = "";
        }
        open = { ...msg, body: bodies.get(msg.id) };
        view = "read";
        scroll = 0;
        load();
        paint();
        return;
      }
      const file = loadInbox().file;
      const opened = file ? openMailMessage(file, msg.id) : msg;
      open = opened || msg;
      view = "read";
      scroll = 0;
      load();
      if (open) {
        const fresh = messages.find((m) => m.id === open.id);
        if (fresh) open = fresh;
      }
      paint();
    }
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    output.write(`usage:
  inbox-pane.mjs watch     # desk pane (j/k select · enter read · q chat)
  inbox-pane.mjs once      # print the list

Mail keys (home Mailu via gotchibot mail): enter read · r reply · c compose · i next identity
  · s sync now. Reply and compose print the whole message and send only after you type "send".

Project mail: sessions/pstack/<slug>/mail.json
Bot inbox (shown when mail is empty): sessions/pstack/<slug>/inbox/inbox.json
Hub copy is pulled before paint when this desk is paired.
Desk: ./scripts/orchestrator-layout.sh enter-inbox
      Ctrl+Space then Shift+I
`);
    return;
  }
  const wantOnce = args.includes("once") || args.includes("--once");
  if (wantOnce || !input.isTTY) {
    await runOnce();
    return;
  }
  runWatch();
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    output.write(`${err?.message || err}\n`);
    process.exit(1);
  });
}
