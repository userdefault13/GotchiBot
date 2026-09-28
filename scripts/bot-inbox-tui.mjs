#!/usr/bin/env node
/**
 * Bot inbox TUI — iMessage layout: left = agents, right = text chain.
 *
 *   node scripts/bot-inbox-tui.mjs
 *   ./scripts/gotchibot inbox tui
 *
 * Keys: j/k or ↑↓ agents · [/] or PgUp/PgDn scroll thread · Enter mark read ·
 *       a archive latest · u unread-only · t cycle to-filter · Tab focus · q quit
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stdin as input, stdout as output } from "node:process";
import { isMainModule } from "./is-main.mjs";
import {
  listMessages,
  readMessage,
  archiveMessage,
  digest,
  inboxPaths,
  normalizeAddress,
} from "./bot-inbox.mjs";
import { currentProjectSlug } from "./project-context.mjs";
import { heroDisplayName, orchestratorHeroId } from "./openclaw-fleet.mjs";
import { getThumb, warmThumbs } from "./meet-channel.mjs";
import { isProfLinkCubeId } from "./gotchi-art.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
void ROOT;

const ESC = "\x1b";
const C = {
  reset: `${ESC}[0m`,
  dim: `${ESC}[38;5;245m`,
  user: `${ESC}[38;5;117m`,
  chair: `${ESC}[38;5;213m`,
  agent: `${ESC}[38;5;51m`,
  topic: `${ESC}[38;5;184m`,
  bar: `${ESC}[38;5;240m`,
  body: `${ESC}[38;5;252m`,
  unread: `${ESC}[38;5;220m`,
  alert: `${ESC}[38;5;203m`,
  sel: `${ESC}[38;5;213m`,
  mine: `${ESC}[38;5;157m`,
  bold: `${ESC}[1m`,
  reverse: `${ESC}[7m`,
};

const THUMB_W = 14;
const TO_CYCLE = ["userdefault", "orch", "all"];
const LEFT_MIN = 22;
const LEFT_MAX = 34;

function paneSize() {
  return { cols: output.columns || 80, rows: output.rows || 24 };
}

function stripAnsi(s) {
  return String(s || "").replace(/\x1b\[[0-9;]*m/g, "");
}

function visLen(s) {
  return stripAnsi(s).length;
}

function padVis(s, w) {
  const n = visLen(s);
  if (n >= w) {
    // Truncate visible text carefully
    let out = "";
    let len = 0;
    const raw = String(s || "");
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === "\x1b") {
        const m = raw.slice(i).match(/^\x1b\[[0-9;]*m/);
        if (m) {
          out += m[0];
          i += m[0].length - 1;
          continue;
        }
      }
      if (len >= w - 1) {
        out += "…";
        break;
      }
      out += raw[i];
      len += 1;
    }
    return out + C.reset;
  }
  return `${s}${" ".repeat(w - n)}`;
}

function wrapLines(text, width) {
  const out = [];
  for (const para of String(text || "").split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) {
      out.push("");
      continue;
    }
    let line = "";
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (next.length > width && line) {
        out.push(line);
        line = w;
      } else {
        line = next;
      }
    }
    if (line) out.push(line);
  }
  return out.length ? out : [""];
}

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

const GOTCHI_NAMES = new Map();

function displayName(id) {
  const s = String(id || "");
  if (!s || s === "userdefault") return "UserDefault";
  if (isProfLinkCubeId(s)) return "Prof. Link-Cube";
  const orchId = orchestratorHeroId();
  const hero = s === "orch" || s === "gotchi" ? orchId : s;
  if (!GOTCHI_NAMES.has(hero)) GOTCHI_NAMES.set(hero, heroDisplayName(hero));
  const gotchiName = GOTCHI_NAMES.get(hero);
  if (gotchiName) return gotchiName;
  if (s === orchId || s === "owned-954" || s === "orch" || s === "gotchi") return "Gotchi";
  if (s.startsWith("starter-")) {
    const m = s.match(/starter-([a-z0-9]+)-/i);
    if (m) return m[1].toUpperCase();
  }
  if (s.startsWith("owned-")) return s.replace("owned-", "#");
  return s.length > 16 ? `${s.slice(0, 14)}…` : s;
}

function nameColor(id) {
  if (id === "userdefault") return C.user;
  if (id === orchestratorHeroId() || id === "owned-954" || id === "orch") return C.chair;
  return C.agent;
}

function kindTag(kind) {
  const k = String(kind || "fyi");
  if (k === "alert") return `${C.alert}${k}${C.reset}`;
  if (k === "ask") return `${C.chair}${k}${C.reset}`;
  if (k === "report") return `${C.topic}${k}${C.reset}`;
  return `${C.dim}${k}${C.reset}`;
}

/** Whose mailbox we're browsing — drives "mine" vs peer in the thread. */
function mailboxMe(toKey) {
  if (toKey === "orch") return normalizeAddress("orch");
  if (toKey === "all") return normalizeAddress("userdefault");
  return normalizeAddress(toKey || "userdefault");
}

function peerOf(msg, me) {
  const from = String(msg.from || "");
  const to = String(msg.to || "");
  if (from === me) return to || from;
  if (to === me) return from || to;
  // Message not addressed to me — still group by sender.
  return from || to || "unknown";
}

function isMine(msg, me) {
  return String(msg.from || "") === me;
}

function loadRows(state) {
  const me = mailboxMe(state.toKey);
  // Full mailbox for chat chains (both directions). Unread toggle still applies.
  let msgs = listMessages({ unread: state.unreadOnly });
  if (state.toKey !== "all") {
    msgs = msgs.filter((m) => String(m.to) === me || String(m.from) === me);
  }
  return msgs;
}

/**
 * Build conversation list: one row per peer agent.
 * Sorted by latest message time (newest first).
 */
function buildConversations(msgs, me) {
  const map = new Map();
  for (const m of msgs) {
    const peer = peerOf(m, me);
    if (!peer || peer === me) continue;
    let row = map.get(peer);
    if (!row) {
      row = { peer, messages: [], unread: 0, latest: null };
      map.set(peer, row);
    }
    row.messages.push(m);
    if (!m.readAt) row.unread += 1;
    if (!row.latest || String(m.ts) > String(row.latest.ts)) row.latest = m;
  }
  const list = [...map.values()];
  for (const row of list) {
    row.messages.sort((a, b) => String(a.ts).localeCompare(String(b.ts))); // chat order
  }
  list.sort((a, b) => String(b.latest?.ts || "").localeCompare(String(a.latest?.ts || "")));
  return list;
}

function leftWidth(cols) {
  return Math.max(LEFT_MIN, Math.min(LEFT_MAX, Math.floor(cols * 0.32)));
}

function renderLeftList(convs, state, leftW, bodyRows) {
  const lines = [];
  const title = padVis(`${C.bold}Agents${C.reset}`, leftW);
  lines.push(title);
  lines.push(padVis(`${C.bar}${"─".repeat(Math.max(4, leftW - 1))}${C.reset}`, leftW));

  if (!convs.length) {
    lines.push(padVis(`${C.dim}(no threads)${C.reset}`, leftW));
    while (lines.length < bodyRows) lines.push(padVis("", leftW));
    return lines.slice(0, bodyRows);
  }

  const listBudget = bodyRows - 2;
  let start = 0;
  if (convs.length > listBudget) {
    start = Math.max(0, state.convIdx - Math.floor(listBudget / 2));
    if (start + listBudget > convs.length) start = Math.max(0, convs.length - listBudget);
  }

  for (let i = start; i < convs.length && lines.length < bodyRows; i++) {
    const c = convs[i];
    const sel = i === state.convIdx;
    const mark = sel ? `${C.sel}▌${C.reset}` : " ";
    const dot = c.unread ? `${C.unread}●${C.reset}` : `${C.dim}○${C.reset}`;
    const name = displayName(c.peer);
    const count = c.unread ? `${C.unread}${c.unread}${C.reset}` : `${C.dim}${c.messages.length}${C.reset}`;
    const line1 = `${mark}${dot} ${nameColor(c.peer)}${name}${C.reset}`;
    const preview = String(c.latest?.subject || c.latest?.body || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, Math.max(8, leftW - 4));
    const line2 = `  ${C.dim}${preview || "—"}${C.reset}`;

    if (sel) {
      lines.push(padVis(`${C.reverse}${stripAnsi(line1)}${C.reset} ${count}`, leftW));
    } else {
      lines.push(padVis(`${line1} ${count}`, leftW));
    }
    if (lines.length < bodyRows) lines.push(padVis(line2, leftW));
  }
  while (lines.length < bodyRows) lines.push(padVis("", leftW));
  return lines.slice(0, bodyRows);
}

/** One chat bubble — mine right-aligned, theirs left with thumb. */
function renderChatBubble(msg, me, rightW) {
  const mine = isMine(msg, me);
  const when = formatTime(msg.ts);
  const unreadDot = msg.readAt ? "" : `${C.unread}●${C.reset} `;
  const subject = msg.subject ? `${C.bold}${msg.subject}${C.reset}` : "";
  const kind = kindTag(msg.kind);
  const text = String(msg.body || "").trim();
  const rows = [];

  if (mine) {
    const bubbleW = Math.max(20, Math.min(rightW - 4, Math.floor(rightW * 0.72)));
    const meta = `${unreadDot}${C.mine}You${C.reset} ${C.dim}${when}${C.reset} · ${kind}${subject ? ` · ${subject}` : ""}`;
    const bodyLines = wrapLines(text, bubbleW - 2).slice(0, 10);
    const metaPad = Math.max(0, rightW - visLen(meta) - 1);
    rows.push(`${" ".repeat(metaPad)}${meta}`);
    for (const line of bodyLines) {
      const content = `${C.mine}╭ ${line}${C.reset}`;
      const pad = Math.max(0, rightW - visLen(content) - 1);
      rows.push(`${" ".repeat(pad)}${content}`);
    }
    rows.push("");
    return rows;
  }

  const thumb = getThumb(msg.from);
  const bodyW = Math.max(16, rightW - THUMB_W - 3);
  const name = displayName(msg.from);
  const meta = `${unreadDot}${nameColor(msg.from)}${name}${C.reset} ${C.dim}${when}${C.reset} · ${kind}${subject ? ` · ${subject}` : ""}`;
  const bodyLines = wrapLines(text, bodyW).slice(0, 10);
  const blockH = Math.max(thumb.length, 1 + bodyLines.length);
  for (let i = 0; i < blockH; i++) {
    const thumbPart = padVis(thumb[i] || "", THUMB_W);
    if (i === 0) {
      rows.push(`${thumbPart}${meta}`);
      continue;
    }
    const line = bodyLines[i - 1];
    if (line != null) rows.push(`${thumbPart} ${C.body}${line}${C.reset}`);
    else if (stripAnsi(thumb[i] || "").trim()) rows.push(thumbPart);
  }
  rows.push("");
  return rows;
}

function renderThread(conv, me, rightW, bodyRows, scroll) {
  const lines = [];
  if (!conv) {
    lines.push(`${C.dim}Select an agent on the left.${C.reset}`);
    while (lines.length < bodyRows) lines.push("");
    return { lines: lines.slice(0, bodyRows), maxScroll: 0 };
  }

  const header = `${nameColor(conv.peer)}${C.bold}${displayName(conv.peer)}${C.reset}${C.dim} · ${conv.messages.length} msgs${conv.unread ? ` · ${conv.unread} unread` : ""}${C.reset}`;
  lines.push(header);
  lines.push(`${C.bar}${"─".repeat(Math.max(8, Math.min(rightW - 2, 48)))}${C.reset}`);

  const bubbles = [];
  for (const m of conv.messages) {
    bubbles.push(...renderChatBubble(m, me, rightW));
  }
  if (!bubbles.length) bubbles.push(`${C.dim}(no messages)${C.reset}`, "");

  const budget = Math.max(1, bodyRows - 2);
  const maxScroll = Math.max(0, bubbles.length - budget);
  // Default: stick to bottom (latest). scroll offsets upward from bottom.
  const fromBottom = Math.min(maxScroll, Math.max(0, scroll));
  const start = Math.max(0, bubbles.length - budget - fromBottom);
  const view = bubbles.slice(start, start + budget);
  while (view.length < budget) view.push("");
  lines.push(...view);
  return { lines: lines.slice(0, bodyRows), maxScroll };
}

function buildFrame(state) {
  const { cols, rows } = paneSize();
  const paths = inboxPaths();
  const d = digest();
  const me = mailboxMe(state.toKey);
  const msgs = loadRows(state);
  const convs = buildConversations(msgs, me);
  if (state.convIdx >= convs.length) state.convIdx = Math.max(0, convs.length - 1);
  const conv = convs[state.convIdx] || null;

  const leftW = leftWidth(cols);
  const gap = ` ${C.bar}│${C.reset} `;
  const gapVis = 3;
  const rightW = Math.max(24, cols - leftW - gapVis);

  const header = [
    `${C.chair}${C.bold}Bot inbox${C.reset}${C.dim} · ${paths.project || "desk"} · unread ${d.unread}${C.reset}`,
    `${C.dim}to:${state.toKey}${state.unreadOnly ? " · unread" : ""} · iMessage · agents | thread · not AgentMail${C.reset}`,
  ];
  const footer = [
    `${C.dim}j/k agents · [/] scroll · Enter read · a archive · u unread · t filter · q back${C.reset}`,
  ];
  const bodyRows = Math.max(6, rows - header.length - footer.length);

  const left = renderLeftList(convs, state, leftW, bodyRows);
  const { lines: right, maxScroll } = renderThread(conv, me, rightW, bodyRows, state.scroll);
  state._maxScroll = maxScroll;
  state._convs = convs;

  const mid = [];
  for (let i = 0; i < bodyRows; i++) {
    mid.push(`${padVis(left[i] || "", leftW)}${gap}${padVis(right[i] || "", rightW)}`);
  }

  return [...header, ...mid, ...footer].slice(0, rows);
}

function draw(state) {
  const lines = buildFrame(state);
  output.write(`${ESC}[H${ESC}[J${lines.join("\n")}`);
}

function runTui() {
  if (!input.isTTY || !output.isTTY) {
    const rows = listMessages({ to: "userdefault", unread: true });
    console.log(`Bot inbox · ${currentProjectSlug() || "desk"} · ${rows.length} unread for userdefault\n`);
    for (const m of rows) {
      console.log(`• ${m.id}  [${m.kind}]  ${displayName(m.from)} → ${displayName(m.to)}  ${m.subject}`);
      console.log(`  ${String(m.body || "").replace(/\n/g, " ").slice(0, 100)}`);
      console.log("");
    }
    if (!rows.length) console.log("(empty)");
    console.log("(tty required for interactive TUI — cockpit → Bot inbox)");
    return;
  }

  const state = {
    convIdx: 0,
    scroll: 0,
    unreadOnly: false, // show full chains by default (iMessage)
    toKey: "userdefault",
    _maxScroll: 0,
    _convs: [],
  };

  const ids = [
    ...new Set(
      listMessages({})
        .flatMap((m) => [m.from, m.to])
        .filter(Boolean),
    ),
  ];
  warmThumbs(ids, () => draw(state));

  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  output.write(`${ESC}[?25l`);

  let esc = "";
  const redraw = () => draw(state);
  redraw();

  const onResize = () => redraw();
  output.on("resize", onResize);

  const teardown = (code = 0) => {
    try {
      input.setRawMode(false);
    } catch {
      /* ok */
    }
    output.removeListener("resize", onResize);
    output.write(`${ESC}[?25h${ESC}[0m\n`);
    process.exit(code);
  };

  const selectedConv = () => state._convs[state.convIdx] || null;

  const markConvRead = () => {
    const conv = selectedConv();
    if (!conv) return;
    for (const m of conv.messages) {
      if (!m.readAt) {
        try {
          readMessage(m.id, { markRead: true });
        } catch {
          /* ok */
        }
      }
    }
  };

  const archiveLatest = () => {
    const conv = selectedConv();
    if (!conv?.messages?.length) return;
    const last = conv.messages[conv.messages.length - 1];
    try {
      archiveMessage(last.id);
    } catch {
      /* ok */
    }
  };

  input.on("data", (chunk) => {
    const s = String(chunk);
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (esc || ch === "\x1b") {
        esc += ch;
        if (esc.length > 1 && /[A-Za-z~]$/.test(esc)) {
          const seq = esc;
          esc = "";
          if (seq === "\x1b[A") {
            state.convIdx = Math.max(0, state.convIdx - 1);
            state.scroll = 0;
            redraw();
          } else if (seq === "\x1b[B") {
            state.convIdx += 1;
            state.scroll = 0;
            redraw();
          } else if (seq === "\x1b[5~") {
            state.scroll = Math.min(state._maxScroll || 0, state.scroll + 5);
            redraw();
          } else if (seq === "\x1b[6~") {
            state.scroll = Math.max(0, state.scroll - 5);
            redraw();
          }
        } else if (esc.length > 8) esc = "";
        continue;
      }
      if (ch === "\x03" || ch === "q" || ch === "Q") {
        teardown(0);
        return;
      }
      if (ch === "j" || ch === "J") {
        state.convIdx += 1;
        state.scroll = 0;
        redraw();
        continue;
      }
      if (ch === "k" || ch === "K") {
        state.convIdx = Math.max(0, state.convIdx - 1);
        state.scroll = 0;
        redraw();
        continue;
      }
      if (ch === "[" || ch === "{") {
        state.scroll = Math.min(state._maxScroll || 0, state.scroll + 3);
        redraw();
        continue;
      }
      if (ch === "]" || ch === "}") {
        state.scroll = Math.max(0, state.scroll - 3);
        redraw();
        continue;
      }
      if (ch === "u" || ch === "U") {
        state.unreadOnly = !state.unreadOnly;
        state.convIdx = 0;
        state.scroll = 0;
        redraw();
        continue;
      }
      if (ch === "t" || ch === "T") {
        const ix = TO_CYCLE.indexOf(state.toKey);
        state.toKey = TO_CYCLE[(ix + 1) % TO_CYCLE.length];
        state.convIdx = 0;
        state.scroll = 0;
        redraw();
        continue;
      }
      if (ch === "\r" || ch === "\n" || ch === "r" || ch === "R") {
        markConvRead();
        redraw();
        continue;
      }
      if (ch === "a" || ch === "A") {
        archiveLatest();
        redraw();
        continue;
      }
    }
  });
}

if (isMainModule(import.meta.url)) {
  try {
    void orchestratorHeroId();
    runTui();
  } catch (e) {
    console.error(e?.message || e);
    process.exit(1);
  }
}
