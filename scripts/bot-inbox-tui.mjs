#!/usr/bin/env node
/**
 * Bot inbox TUI — iMessage-style thread (same language as # meet).
 *
 *   node scripts/bot-inbox-tui.mjs
 *   ./scripts/gotchibot inbox tui
 *
 * Keys: j/k or ↑↓ select · Enter/r mark read · a archive · u unread-only ·
 *       t cycle to-filter · q quit
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
import { orchestratorHeroId } from "./openclaw-fleet.mjs";
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
  bold: `${ESC}[1m`,
};

const THUMB_W = 14;
const TO_CYCLE = ["userdefault", "orch", "all"];

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
  return n >= w ? s : `${s}${" ".repeat(w - n)}`;
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

function displayName(id) {
  const s = String(id || "");
  if (!s || s === "userdefault") return "UserDefault";
  if (isProfLinkCubeId(s)) return "Prof. Link-Cube";
  if (s === orchestratorHeroId() || s === "owned-954") return "Gotchi";
  if (s.startsWith("starter-")) {
    const m = s.match(/starter-([a-z0-9]+)-/i);
    if (m) return m[1].toUpperCase();
  }
  return s;
}

function nameColor(id) {
  if (id === "userdefault") return C.user;
  if (id === orchestratorHeroId() || id === "owned-954") return C.chair;
  return C.agent;
}

function kindTag(kind) {
  const k = String(kind || "fyi");
  if (k === "alert") return `${C.alert}${k}${C.reset}`;
  if (k === "ask") return `${C.chair}${k}${C.reset}`;
  if (k === "report") return `${C.topic}${k}${C.reset}`;
  return `${C.dim}${k}${C.reset}`;
}

function resolveToFilter(key) {
  if (key === "all") return null;
  if (key === "orch") return normalizeAddress("orch");
  return normalizeAddress(key);
}

function loadRows(state) {
  return listMessages({
    to: resolveToFilter(state.toKey),
    unread: state.unreadOnly,
  });
}

/** One iMessage-style bubble: thumb | name · time · kind · subject + body. */
function renderBubble(msg, cols, { selected = false } = {}) {
  const thumb = getThumb(msg.from);
  const bodyW = Math.max(16, cols - THUMB_W - 3);
  const name = displayName(msg.from);
  const when = formatTime(msg.ts);
  const unreadDot = msg.readAt ? "" : `${C.unread}●${C.reset} `;
  const selMark = selected ? `${C.sel}▌${C.reset}` : " ";
  const subject = msg.subject ? `${C.bold}${msg.subject}${C.reset}` : "";
  const meta = `${selMark}${unreadDot}${nameColor(msg.from)}${name}${C.reset} ${C.dim}${when}${C.reset} · ${kindTag(msg.kind)}${subject ? ` · ${subject}` : ""}`;

  const text = String(msg.body || "").trim();
  const bodyLines = wrapLines(text, bodyW);
  // Cap per-bubble height so the thread stays scannable.
  const maxBody = selected ? 12 : 3;
  const shown = bodyLines.slice(0, maxBody);
  if (bodyLines.length > maxBody) shown.push("…");

  const blockH = Math.max(thumb.length, 1 + shown.length);
  const rows = [];
  for (let i = 0; i < blockH; i++) {
    const thumbPart = padVis(thumb[i] || "", THUMB_W);
    if (i === 0) {
      rows.push(`${thumbPart}${meta}`);
      continue;
    }
    const line = shown[i - 1];
    if (line != null) {
      rows.push(`${thumbPart} ${C.body}${line}${C.reset}`);
    } else if (stripAnsi(thumb[i] || "").trim()) {
      rows.push(thumbPart);
    }
  }
  rows.push("");
  rows.push(""); // air between bubbles (meet-channel style)
  return rows;
}

function buildFrame(state) {
  const { cols, rows } = paneSize();
  const paths = inboxPaths();
  const d = digest();
  const msgs = loadRows(state);
  if (state.idx >= msgs.length) state.idx = Math.max(0, msgs.length - 1);

  const header = [
    `${C.chair}${C.bold}Bot inbox${C.reset}${C.dim} · ${paths.project || "desk"} · unread ${d.unread}${C.reset}`,
    `${C.dim}to:${state.toKey}${state.unreadOnly ? " · unread" : ""} · iMessage thread · not AgentMail${C.reset}`,
    `${C.bar}${"─".repeat(Math.max(8, Math.min(cols - 2, 56)))}${C.reset}`,
  ];
  const footer = [
    `${C.dim}j/k select · Enter read · a archive · u unread · t filter · q back${C.reset}`,
  ];

  const budget = Math.max(4, rows - header.length - footer.length);
  let bubbles = [];
  if (!msgs.length) {
    bubbles = [`${C.dim}(inbox empty — bots: gotchibot inbox send)${C.reset}`, ""];
  } else {
    for (let i = 0; i < msgs.length; i++) {
      bubbles.push(...renderBubble(msgs[i], cols, { selected: i === state.idx }));
    }
  }

  // Keep selected bubble in view (anchor near bottom of viewport).
  let start = 0;
  if (bubbles.length > budget) {
    // Estimate line offset of selected bubble.
    let selLine = 0;
    for (let i = 0; i < state.idx && i < msgs.length; i++) {
      selLine += renderBubble(msgs[i], cols, { selected: false }).length;
    }
    const selH = msgs[state.idx]
      ? renderBubble(msgs[state.idx], cols, { selected: true }).length
      : 4;
    start = Math.max(0, selLine + selH - budget);
    if (start + budget > bubbles.length) start = Math.max(0, bubbles.length - budget);
  }
  const view = bubbles.slice(start, start + budget);
  while (view.length < budget) view.push("");

  return [...header, ...view, ...footer].slice(0, rows);
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
    idx: 0,
    unreadOnly: true,
    toKey: "userdefault",
  };

  // Warm thumbs for visible senders (async; redraw picks them up on next key).
  const ids = [...new Set(listMessages({}).map((m) => m.from))];
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

  const selected = () => loadRows(state)[state.idx] || null;

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
            state.idx = Math.max(0, state.idx - 1);
            redraw();
          } else if (seq === "\x1b[B") {
            state.idx += 1;
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
        state.idx += 1;
        redraw();
        continue;
      }
      if (ch === "k" || ch === "K") {
        state.idx = Math.max(0, state.idx - 1);
        redraw();
        continue;
      }
      if (ch === "u" || ch === "U") {
        state.unreadOnly = !state.unreadOnly;
        state.idx = 0;
        redraw();
        continue;
      }
      if (ch === "t" || ch === "T") {
        const ix = TO_CYCLE.indexOf(state.toKey);
        state.toKey = TO_CYCLE[(ix + 1) % TO_CYCLE.length];
        state.idx = 0;
        redraw();
        continue;
      }
      if (ch === "\r" || ch === "\n" || ch === "r" || ch === "R") {
        const m = selected();
        if (m) {
          try {
            readMessage(m.id, { markRead: true });
          } catch {
            /* ok */
          }
          redraw();
        }
        continue;
      }
      if (ch === "a" || ch === "A") {
        const m = selected();
        if (m) {
          try {
            archiveMessage(m.id);
          } catch {
            /* ok */
          }
          redraw();
        }
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
