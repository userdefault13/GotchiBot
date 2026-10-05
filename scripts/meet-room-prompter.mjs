#!/usr/bin/env node
/**
 * Meet room TUI — iMessage transcript + OpenCode-style prompter.
 *
 *   node scripts/meet-room-prompter.mjs
 *   node scripts/meet-room-prompter.mjs --inline   # single terminal (no tmux)
 */
import { spawn, spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  statSync,
  watch,
} from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stdin, stdout } from "node:process";
import { listMeetMembers } from "./meet-room.mjs";
import {
  setMeetStatus,
  loadMeetStatus,
  statusFor,
  statusLabel,
} from "./meet-status.mjs";
import {
  warmThumbs,
  readTranscript,
  loadCurrentMeeting,
  renderMeetChannel,
  maxScrollFromBottom,
  getMini,
  listMeetings,
  listMeetThreads,
} from "./meet-channel.mjs";
import {
  stripPardonPrefix,
  isPardonTrigger,
  isContinueTrigger,
  writePardonRequest,
  clearPardonRequest,
  readPardonRound,
  writePardonStack,
  hasPardonStack,
  stackFromRound,
} from "./lib/meet-pardon.mjs"; // pardon-me-v1
import { runLayout } from "./tmux-layout.mjs";
import { resolveMeetingsRoot } from "./project-context.mjs";
import { isMainModule } from "./is-main.mjs";
import { startHubProjectMirror } from "./hub-project-sync.mjs";
import { downgradeAnsi, renderMode, toAsciiGlyphs } from "./lib/term-color.mjs";
import { mouseEnabled } from "./lib/term-caps.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STAMP = `${ROOT}/sessions/.meet-room.stamp`;
const LEAVE = `${ROOT}/sessions/.meet-leave`;
const PENDING = `${ROOT}/sessions/.meet-pending.json`;
const EDIT_REQUEST = `${ROOT}/sessions/.meet-edit-request.json`;
const STATUS_FILE = `${ROOT}/sessions/.meet-status.json`;
const PROMPT_INPUT_ROWS = 6;
const PROMPT_FOOTER_ROWS = 1;
const PROMPT_PANEL_ROWS = PROMPT_INPUT_ROWS + PROMPT_FOOTER_ROWS;
/** Blank row above and below the input panel (dropped on short panes). */
const PROMPT_PAD_Y = 1;
/** Gutter bar + one space before text (matches OpenCode prompt). */
const INPUT_LEFT = 2;
/** Purple input bar inset so it does not touch the pane edges. */
const INPUT_PAD_X = 2;
/** Chat-list column: mini gotchi, name, short status. Last column is the rule. */
export const MEET_SIDEBAR_COLS = 28;
/** Lines per sidebar card: 4 of the round head, then a blank row. */
export const SIDEBAR_CARD_ROWS = 6;
/** Which meet surface keys drive. Tab (empty prompt) / m / n switch it. */
let meetPaneFocus = "chat";
let sideScroll = 0;
/** Sidebar selector: index into listMeetThreads(). */
let sideSel = 0;
/** Thread shown in the chat column ("group" / "direct:<ids>"). null = the one with the open meeting. */
let viewMeetingId = null;
/**
 * /chat picker. null when closed. step "mode" (single/multi) → "agents".
 * sel = cursor, picked = ids toggled in multi mode.
 */
let chatPick = null;

/** Single-terminal mode: no tmux gallery / poke / leave-file. */
const INLINE =
  process.argv.includes("--inline") || process.env.GOTCHIBOT_MEET_INLINE === "1";

const _tui = renderMode();

// Gotchi / OpenCode theme (.opencode/themes/gotchi.json + opencode-palette.ts)
const T_RAW = {
  reset: "\x1b[0m",
  panel: "\x1b[48;2;45;31;66m",
  accentBar: "\x1b[48;2;182;80;255m \x1b[0m",
  brand: "\x1b[38;2;182;80;255m",
  text: "\x1b[38;2;240;230;255m",
  muted: "\x1b[38;2;155;139;184m",
  tick: "\x1b[38;2;74;53;102m",
  cursor: "\x1b[48;2;255;255;255m \x1b[0m",
  mention: "\x1b[38;5;51m",
  menu: "\x1b[38;5;184m",
};

const T = Object.fromEntries(
  Object.entries(T_RAW).map(([k, v]) => [k, downgradeAnsi(v, _tui.color)]),
);

const MODEL_LABELS = {
  "kimi-k3": "Kimi K3",
  "nemotron-3.5-lightning-free": "Nemotron 3.5 Lightning Free",
  "hy3-free": "Hy3 Free",
  "glm-5.3-flash": "GLM 5.3 Flash",
  "glm-5.3": "GLM 5.3",
  "gpt-5.6-luna": "GPT 5.6 Luna",
  "grok-4.6": "Grok 4.6",
};

function stripAnsi(s) {
  return String(s || "").replace(/\x1b\[[0-9;]*m/g, "");
}

function visLen(s) {
  return stripAnsi(s).length;
}

function cropVis(s, width) {
  if (width <= 0) return "";
  const src = String(s || "");
  let vis = 0;
  let out = "";
  for (let i = 0; i < src.length; ) {
    if (src[i] === "\x1b" && src[i + 1] === "[") {
      const end = src.indexOf("m", i);
      if (end < 0) break;
      out += src.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (vis >= width) break;
    out += src[i];
    vis += 1;
    i += 1;
  }
  if (visLen(src) > width) out += "\x1b[0m";
  return out;
}

function padVis(s, width) {
  const cropped = cropVis(s, width);
  const n = visLen(cropped);
  if (n >= width) return cropped;
  return cropped + " ".repeat(width - n);
}

function paneSize() {
  // Inline (and default) use the process TTY — never ask tmux for size here.
  const cols = stdout.columns || 80;
  const rows = stdout.rows || 24;
  return { cols, rows };
}

/**
 * Pure layout math for --inline mode (1-line strip + transcript + prompt).
 * @param {number} cols
 * @param {number} rows
 * @returns {{ cols: number, rows: number, stripRow: number, transcriptTop: number, transcriptRows: number, promptTop: number, promptRows: number, mentionRow: number }}
 */
export function inlineLayout(cols, rows) {
  const c = Math.max(1, Math.floor(Number(cols) || 80));
  const r = Math.max(1, Math.floor(Number(rows) || 24));
  const stripRow = 1;
  // Short panes drop the padding first, then input rows; the transcript keeps
  // at least a third of the pane.
  const pad = r >= 20 ? PROMPT_PAD_Y : 0;
  const budget = Math.max(1, Math.min(PROMPT_PANEL_ROWS, r - 2 - pad * 2, Math.floor((r * 2) / 3) - pad * 2));
  const promptRows = Math.max(1, budget);
  const inputRows = Math.max(1, promptRows - PROMPT_FOOTER_ROWS);
  const promptTop = r - pad - promptRows + 1;
  const transcriptTop = Math.min(stripRow + 1, promptTop);
  const transcriptRows = Math.max(1, promptTop - pad - transcriptTop);
  const mentionRow = Math.max(transcriptTop, promptTop - 1);
  return {
    cols: c,
    rows: r,
    stripRow,
    transcriptTop,
    transcriptRows,
    promptTop,
    promptRows,
    inputRows,
    padY: pad,
    mentionRow,
  };
}

function truncatePlain(s, cols) {
  const plain = String(s || "");
  if (plain.length <= cols) return plain;
  if (cols <= 1) return plain.slice(0, cols);
  const ell = _tui.glyphs === "ascii" ? "..." : "…";
  const keep = Math.max(0, cols - ell.length);
  return plain.slice(0, keep) + ell;
}

function deskActiveLine() {
  try {
    return readFileSync(join(ROOT, "sessions/.desk-active.line"), "utf8").trim();
  } catch {
    return "";
  }
}

function renderRoomStripLine(cols, meeting) {
  const m = meeting || loadCurrentMeeting();
  const topic = m?.topic || "no meeting";
  const status = loadMeetStatus();
  const members = listMeetMembers(m);
  const parts = members.map((mem) => {
    const st = statusFor(mem.id, status);
    if (st.status === "idle") return mem.label;
    return `${mem.label}:${statusLabel(st.status, st.since)}`;
  });
  const body =
    parts.length > 0 ? `${topic} · ${parts.join(" · ")}` : String(topic);
  const active = deskActiveLine();
  const joined = active ? `${active} · ${body}` : body;
  return truncatePlain(joined, cols);
}

/**
 * Top-of-screen frame for inline mode (strip + transcript), as a string.
 * Input panel is drawn separately via drawInputPanel.
 */
function clipSide(text, width) {
  const s = String(text || "");
  if (s.length <= width) return s;
  return width <= 1 ? s.slice(0, width) : `${s.slice(0, width - 1)}…`;
}

/**
 * Thread shown in the chat column: the picked one, else the thread holding the
 * open meeting, else the newest. Group meetings are one combined log.
 */
export function viewedMeeting() {
  const threads = listMeetThreads();
  if (viewMeetingId) {
    const t = threads.find((x) => x.id === viewMeetingId);
    if (t) return t;
    viewMeetingId = null;
  }
  return threads.find((x) => x.isCurrent) || threads[0] || null;
}

function shortDate(iso) {
  const d = new Date(iso || 0);
  if (Number.isNaN(d.getTime()) || !d.getTime()) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Every gotchi on the desk roster (orch first): { id, name, role }. */
export function chatRoster() {
  let r = null;
  try {
    r = JSON.parse(readFileSync(`${ROOT}/sessions/.avatar-roster.json`, "utf8"));
  } catch {
    return [];
  }
  const out = [];
  if (r?.pinned) out.push({ id: r.pinned, name: r.pinnedName || r.pinned, role: "orchestrator" });
  for (const h of r?.others || []) {
    if (h?.id && !out.some((x) => x.id === h.id)) out.push({ id: h.id, name: h.name || h.id, role: h.role || "" });
  }
  return out;
}

export function openChatPicker() {
  chatPick = { step: "mode", mode: "single", sel: 0, picked: [] };
}

/** Test hook. */
export function chatPickerState() {
  return chatPick ? { ...chatPick, picked: [...chatPick.picked] } : null;
}

/**
 * Picker keys: up/down/toggle/enter/back. Returns "redraw" when handled.
 * Enter on the gotchi list opens the chat with that set (gotchi-meet.mjs chat).
 */
export function chatPickerKey(key, { start = startDirectChat } = {}) {
  if (!chatPick) return "";
  const p = chatPick;
  if (p.step === "mode") {
    if (key === "up" || key === "down") p.sel = p.sel === 0 ? 1 : 0;
    else if (key === "enter" || key === "toggle") {
      p.mode = p.sel === 0 ? "single" : "multi";
      p.step = "agents";
      p.sel = 0;
      p.picked = [];
    } else if (key === "back") chatPick = null;
    return "redraw";
  }
  const roster = chatRoster();
  const n = roster.length;
  if (key === "up") p.sel = Math.max(0, p.sel - 1);
  else if (key === "down") p.sel = Math.min(Math.max(0, n - 1), p.sel + 1);
  else if (key === "back") {
    p.step = "mode";
    p.sel = p.mode === "multi" ? 1 : 0;
  } else if (key === "toggle" && p.mode === "multi") {
    const id = roster[p.sel]?.id;
    if (id) p.picked = p.picked.includes(id) ? p.picked.filter((x) => x !== id) : [...p.picked, id];
  } else if (key === "enter" || (key === "toggle" && p.mode === "single")) {
    const ids = p.mode === "multi" && p.picked.length ? p.picked : [roster[p.sel]?.id].filter(Boolean);
    if (!ids.length) return "redraw";
    chatPick = null;
    start(ids);
  }
  return "redraw";
}

function startDirectChat(ids) {
  viewMeetingId = null;
  scrollFromBottom = 0;
  runMeetHelper(["chat", ...ids], {
    failLabel: "could not open that chat",
    env: { GOTCHIBOT_MEET_LAYOUT_SKIP: "1" },
    onDone() {
      viewMeetingId = null;
      sideSel = 0;
      sideScroll = 0;
    },
  });
}

/** Box over the chat column. Plain overwrite — no clear-to-EOL past the box. */
function drawChatPicker(left, width, top, height) {
  if (!chatPick) return;
  const p = chatPick;
  const rows = [];
  if (p.step === "mode") {
    rows.push(["title", "chat with…"], ["", ""]);
    rows.push([p.sel === 0 ? "sel" : "", "Single · one gotchi"]);
    rows.push([p.sel === 1 ? "sel" : "", "Multi · pick several"]);
    rows.push(["", ""], ["dim", "↑↓ move · ⏎ choose · esc cancel"]);
  } else {
    const roster = chatRoster();
    rows.push(["title", p.mode === "multi" ? `pick gotchis (${p.picked.length} picked)` : "pick a gotchi"], ["", ""]);
    const win = Math.max(3, Math.min(14, height - 8));
    let topI = Math.max(0, p.sel - Math.floor(win / 2));
    topI = Math.min(topI, Math.max(0, roster.length - win));
    for (let i = topI; i < roster.length && i < topI + win; i++) {
      const h = roster[i];
      const box = p.mode === "multi" ? (p.picked.includes(h.id) ? "[x] " : "[ ] ") : "";
      const role = h.role ? ` · ${String(h.role).replace(/-/g, " ")}` : "";
      rows.push([i === p.sel ? "sel" : "", `${box}${h.name}${role}`]);
    }
    if (!roster.length) rows.push(["dim", "no roster yet"]);
    rows.push(["", ""]);
    rows.push([
      "dim",
      p.mode === "multi" ? "space toggle · ⏎ start chat · esc back" : "↑↓ move · ⏎ chat · esc back",
    ]);
  }
  const inner = Math.max(20, Math.min(54, width - 6));
  const boxW = inner + 2;
  const x = left + Math.max(0, Math.floor((width - boxW) / 2));
  const y = top + Math.max(0, Math.floor((height - (rows.length + 2)) / 2));
  const put = (row, text) => stdout.write(`\x1b[${row};${x}H${text}`);
  const bar = "─".repeat(inner);
  put(y, `${T.panel}${T.muted}┌${bar}┐${T.reset}`);
  rows.forEach(([kind, text], i) => {
    const lead = kind === "sel" ? " ▸ " : kind === "title" || kind === "dim" ? " " : "   ";
    const t = clipSide(String(text), inner - lead.length);
    const cell = `${lead}${t}${" ".repeat(Math.max(0, inner - lead.length - t.length))}`;
    const edge = `${T.panel}${T.muted}│${T.reset}`;
    let body;
    if (kind === "sel") body = `${edge}\x1b[7m${cell}\x1b[27m${edge}`;
    else if (kind === "title") body = `${edge}${T.panel}${T.brand}${cell}${T.reset}${edge}`;
    else if (kind === "dim") body = `${edge}${T.panel}${T.muted}${cell}${T.reset}${edge}`;
    else body = `${edge}${T.panel}${T.text}${cell}${T.reset}${edge}`;
    put(y + 1 + i, body);
  });
  put(y + 1 + rows.length, `${T.panel}${T.muted}└${bar}┘${T.reset}`);
}

/** Sidebar card title + kind for one thread. */
function meetCardLabels(t) {
  const n = t.segments?.length || 1;
  if (t.direct || t.solo) {
    const agents = (t.participants || []).filter((p) => p.role !== "user");
    const chats = `${n} chat${n === 1 ? "" : "s"}`;
    return {
      title: agents.map((p) => p.name || p.id).join(", ") || t.chairId || "gotchi",
      kind: agents.length > 1 ? `${agents.length} gotchis · ${chats}` : `1:1 · ${chats}`,
      faceId: agents[0]?.id || t.chairId,
    };
  }
  return { title: "Group meetings", kind: `${n} meeting${n === 1 ? "" : "s"}`, faceId: t.chairId };
}

/**
 * Meet list. One card per saved meet (group or 1:1), newest first: the chair's
 * (or 1:1 partner's) mini head, title, kind, date. ▸ marks the selector; the
 * open meet carries ●. `scroll` skips that many cards.
 */
export function renderMeetSidebar(rows, width = MEET_SIDEBAR_COLS - 1, scroll = sideScroll) {
  const blank = " ".repeat(Math.max(0, width));
  if (rows <= 0 || width < 16) return Array(Math.max(0, rows)).fill(blank);
  const meets = listMeetThreads();
  const maxStart = Math.max(0, meets.length - 1);
  const start = Math.max(0, Math.min(maxStart, Number(scroll) || 0));
  const viewing = viewedMeeting()?.id || null;
  const lines = [];
  if (!meets.length) {
    lines.push(padVis(`${T.muted}no saved meets${T.reset}`, width));
  }
  meets.slice(start).forEach((m, k) => {
    if (lines.length + SIDEBAR_CARD_ROWS > rows && lines.length > 0) return;
    if (lines.length >= rows) return;
    const i = start + k;
    const { title, kind, faceId } = meetCardLabels(m);
    const face = getMini(faceId);
    const selected = i === sideSel;
    // Selector: a bar down the card, bright while the list has focus.
    const mark = selected ? (meetPaneFocus === "sidebar" ? `${T.brand}▌${T.reset}` : `${T.muted}▌${T.reset}`) : " ";
    // Clip plain text, then color it — clipping through an escape code breaks it.
    const row = (fi, extra = "", color = T.text, prefix = "", prefixLen = 0) => {
      const faceLine = face[fi] || "";
      let body = `${mark}${faceLine}`;
      if (extra) {
        const room = width - visLen(body) - 1 - prefixLen;
        if (room > 0) body += ` ${prefix}${color}${clipSide(extra, room)}${T.reset}`;
      }
      return padVis(body, width);
    };
    const titleColor = m.id === viewing ? T.brand : T.text;
    lines.push(row(0, title, titleColor));
    lines.push(row(1));
    lines.push(
      m.isCurrent
        ? row(2, kind, T.muted, `${T.brand}●${T.reset} `, 2)
        : m.status === "paused"
          ? row(2, kind, T.muted, `${T.muted}‖${T.reset} `, 2)
          : row(2, kind, T.muted),
    );
    lines.push(row(3, shortDate(m.createdAt), T.muted));
    lines.push(row(4));
    lines.push(blank);
  });
  while (lines.length < rows) lines.push(blank);
  return lines.slice(0, rows);
}

/** m focuses the sidebar. n focuses the meeting chat. "" is not a focus key. */
export function meetFocusTarget(key) {
  if (key === "m" || key === "M") return "sidebar";
  if (key === "n" || key === "N") return "chat";
  return "";
}

export function renderInlineFrame({
  cols = 80,
  rows = 24,
  meeting = null,
  scrollFromBottom = 0,
} = {}) {
  const layout = inlineLayout(cols, rows);
  const m = meeting || viewedMeeting();
  const saved = Boolean(m && m.status !== "open");
  const strip = saved
    ? truncatePlain(`viewing saved · ${m.topic || m.id} · last ${shortDate(m.createdAt)} · read-only · Tab meets`, layout.cols)
    : renderRoomStripLine(layout.cols, m?.combined ? loadCurrentMeeting() : m);
  const stripStyled = `${T.brand}${strip}${T.reset}`;
  const foldedStrip =
    _tui.glyphs === "ascii" ? toAsciiGlyphs(stripStyled) : stripStyled;
  const sideW = meetSideWidth(layout.cols, m);
  const useSide = sideW > 0;
  const channel = renderMeetChannel({
    cols: layout.cols - sideW,
    rows: layout.transcriptRows,
    scrollFromBottom,
    meeting: m || null,
  });
  const pad = Math.max(0, layout.cols - stripAnsi(foldedStrip).length);
  const stripLine = `${foldedStrip}${" ".repeat(pad)}`;
  if (!useSide) return `${stripLine}\n${channel}`;
  // Sidebar runs the full height; the chat column below the transcript is left
  // blank for the input panel, which drawInputPanel paints beside it.
  const bodyRows = Math.max(1, layout.rows - layout.stripRow);
  const side = renderMeetSidebar(bodyRows, sideW - 1, sideScroll);
  const ruleColor = meetPaneFocus === "sidebar" ? T.brand : T.muted;
  const rule = `${ruleColor}│${T.reset}`;
  const right = channel.split("\n");
  const zipped = side.map((line, i) => `${padVis(line, sideW - 1)}${rule}${right[i] || ""}`);
  return `${stripLine}\n${zipped.join("\n")}`;
}

/** Sidebar width (0 = no sidebar). Shown whenever there is a meet to list. */
export function meetSideWidth(cols, meeting = undefined) {
  const has = meeting !== undefined ? Boolean(meeting) || listMeetings().length > 0 : listMeetings().length > 0;
  if (!has || cols < 64) return 0;
  return Math.min(MEET_SIDEBAR_COLS, cols - 36);
}

/** Keep the selector on screen: scroll the card list to it. */
function revealSideSel(rows) {
  const per = SIDEBAR_CARD_ROWS;
  const visible = Math.max(1, Math.floor(Math.max(per, rows) / per));
  if (sideSel < sideScroll) sideScroll = sideSel;
  if (sideSel >= sideScroll + visible) sideScroll = sideSel - visible + 1;
  sideScroll = Math.max(0, sideScroll);
}

/** Sidebar keys. Returns "redraw" when handled, "" to fall through. */
export function sidebarKey(key) {
  const meets = listMeetThreads();
  const n = meets.length;
  if (key === "down") {
    if (n) sideSel = Math.min(n - 1, sideSel + 1);
  } else if (key === "up") {
    sideSel = Math.max(0, sideSel - 1);
  } else if (key === "open") {
    const m = meets[sideSel];
    if (!m) return "redraw";
    viewMeetingId = m.id;
    scrollFromBottom = 0;
    meetPaneFocus = "chat";
  } else if (key === "leave") {
    meetPaneFocus = "chat";
  } else {
    return "";
  }
  const { rows } = paneSize();
  revealSideSel(Math.max(1, rows - 1));
  return "redraw";
}

/** Test hook: sidebar / viewer state. */
export function meetSidebarState() {
  return { focus: meetPaneFocus, sideSel, sideScroll, viewMeetingId };
}

function mentionTags() {
  const members = listMeetMembers()
    .filter((m) => m.role !== "user")
    .map((m) => ({
      tag: `@${String(m.label || m.id).replace(/\s+/g, "")}`,
      label: m.label,
      id: m.id,
    }));
  if (!members.length) return members;
  // @everyone: the whole room answers (gotchi-meet.mjs sayTurn fans it out).
  return [{ tag: "@everyone", label: "everyone", id: "everyone" }, ...members];
}

function activeMentionQuery(buffer) {
  const m = buffer.match(/@([A-Za-z0-9_-]*)$/);
  return m ? m[1].toLowerCase() : null;
}

function matchingMentions(query) {
  const tags = mentionTags();
  if (query == null) return [];
  if (!query) return tags;
  return tags.filter(
    (t) =>
      t.tag.slice(1).toLowerCase().startsWith(query) ||
      t.label.toLowerCase().startsWith(query),
  );
}

/** Slash cmds shown in the live `/` menu (Tab cycles / completes). */
const SLASH_COMMANDS = [
  { tag: "/cockpit", hint: "fleet menu", needsArg: false },
  { tag: "/chat", hint: "pick gotchis to chat", needsArg: false },
  { tag: "/desk", hint: "back to OpenCode", needsArg: false },
  { tag: "/edit", hint: "edit last msg", needsArg: true },
  { tag: "/start", hint: "start recording", needsArg: true },
  { tag: "/end", hint: "stop recording", needsArg: false },
  { tag: "/help", hint: "list commands", needsArg: false },
  { tag: "/prev", hint: "older messages", needsArg: false },
  { tag: "/next", hint: "newer messages", needsArg: false },
  { tag: "/colabo", hint: "round-robin", needsArg: true },
  { tag: "/pardon", hint: "interrupt round", needsArg: true },
  { tag: "/continue", hint: "resume parked", needsArg: false },
  { tag: "/menu", hint: "alias /cockpit", needsArg: false },
  { tag: "/leave", hint: "alias /desk", needsArg: false },
];

/** Active when the whole buffer is a slash stub: `/` or `/coc…`. */
function activeSlashQuery(buffer) {
  const m = String(buffer || "").match(/^\/([A-Za-z0-9_-]*)$/);
  return m ? m[1].toLowerCase() : null;
}

function matchingSlashCmds(query) {
  if (query == null) return [];
  if (!query) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter((c) => c.tag.slice(1).toLowerCase().startsWith(query));
}

function pokeChannel() {
  const now = `${new Date().toISOString()}\n`;
  try {
    writeFileSync(`${ROOT}/sessions/.meet-channel.stamp`, now);
  } catch {
    /* ok */
  }
  if (INLINE) {
    // Local redraw only — do not poke another checkout's tmux panes.
    draw();
    return;
  }
  spawnSync("bash", [`${ROOT}/scripts/poke-meet-channel.sh`], { stdio: "ignore" });
}

function pokeGallery() {
  const now = `${new Date().toISOString()}\n`;
  try {
    writeFileSync(STAMP, now);
  } catch {
    /* ok */
  }
  if (INLINE) {
    draw();
    return;
  }
  spawnSync("bash", [`${ROOT}/scripts/poke-meet-room.sh`], { stdio: "ignore" });
}

let sendBusy = false;
let sendError = null;
let sendStartedAt = 0;
let sendTimer = null;
/** Active meet send/helper child — Ctrl+C can interrupt. */
let activeChild = null;
/** Last Ctrl+C timestamp for double-tap leave. */
let lastCtrlCAt = 0;
let sendDots = 1;
let drawing = false;
let redrawPending = false;
let statusAnimTimer = null;
/** Inline transcript scroll: lines from bottom (0 = pinned to latest). */
let scrollFromBottom = 0;
let inlineWatchTimer = null;
let inlineWatchers = [];
let lastInlineWatchKey = "";

/** When set, the next submit edits this user turn instead of saying. */
let editTargetTs = null;

function hasActiveMeetStatus() {
  try {
    const j = JSON.parse(readFileSync(`${ROOT}/sessions/.meet-status.json`, "utf8"));
    return Object.keys(j?.byId || {}).length > 0;
  } catch {
    return false;
  }
}

function ensureStatusAnim() {
  if (statusAnimTimer) return;
  statusAnimTimer = setInterval(() => {
    if (!hasActiveMeetStatus()) {
      clearInterval(statusAnimTimer);
      statusAnimTimer = null;
      return;
    }
    draw();
  }, 500);
}

function stopStatusAnim() {
  if (statusAnimTimer) clearInterval(statusAnimTimer);
  statusAnimTimer = null;
}

function writePending(text, { chair = true } = {}) {
  try {
    writeFileSync(
      PENDING,
      JSON.stringify({ text, startedAt: new Date().toISOString() }),
    );
  } catch {
    /* ok */
  }
  if (!chair) return;
  try {
    // User line in flight — show chair thinking until sayTurn updates speakers.
    const mid = String(readFileSync(`${ROOT}/sessions/meetings/.current`, "utf8")).trim();
    if (mid) {
      const meeting = JSON.parse(
        readFileSync(`${ROOT}/sessions/meetings/${mid}/meeting.json`, "utf8"),
      );
      if (meeting?.chairId) {
        setMeetStatus(meeting.chairId, "thinking", { meetingId: meeting.id, poke: true });
      }
    }
  } catch {
    /* ok */
  }
  ensureStatusAnim();
}

function clearPending() {
  try {
    unlinkSync(PENDING);
  } catch {
    /* ok */
  }
}

function currentUserId() {
  try {
    return loadCurrentMeeting()?.participants?.find((p) => p.role === "user")?.id || null;
  } catch {
    return null;
  }
}

/** Most recent user-role turn owned by the current user, or null. */
function lastUserTurn() {
  const id = currentUserId();
  const meeting = loadCurrentMeeting();
  if (!id || !meeting) return null;
  const turns = readTranscript(meeting.id);
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === "user" && turns[i].speaker === id) return turns[i];
  }
  return null;
}

/**
 * Load a user turn (by ISO ts, or the last one) into the editor as an edit
 * target. Only the current user's own user-role turns load. Returns false
 * (leaving the buffer alone) when there is nothing editable.
 */
function loadEditTarget(ts) {
  const id = currentUserId();
  const meeting = loadCurrentMeeting();
  if (!id || !meeting) return false;
  const turns = readTranscript(meeting.id);
  let turn = null;
  if (ts) {
    turn = turns.find((t) => t.ts === ts) || null;
  } else {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === "user" && turns[i].speaker === id) {
        turn = turns[i];
        break;
      }
    }
  }
  if (!turn || turn.role !== "user" || turn.speaker !== id) return false;
  editTargetTs = turn.ts;
  editor.buffer = turn.text;
  editor.cursor = editor.buffer.length;
  return true;
}

/** Edit an existing user turn in place — no re-say, no agent wake. */
function editToRoom(ts, msg) {
  const text = String(msg || "").trim();
  if (!text || sendBusy) return;
  sendBusy = true;
  sendError = null;
  startSendTimer();
  draw();

  const child = spawn(
    process.execPath,
    [`${ROOT}/scripts/gotchi-meet.mjs`, "edit", ts, text],
    { cwd: ROOT, stdio: "ignore", env: { ...process.env, GOTCHIBOT_MEET_QUIET: "1" } },
  );
  activeChild = child;
  child.on("error", () => {
    if (activeChild === child) activeChild = null;
    sendBusy = false;
    stopSendTimer();
    sendError = "edit failed";
    pokeChannel();
    draw();
  });
  child.on("close", (code) => {
    if (activeChild === child) activeChild = null;
    sendBusy = false;
    stopSendTimer();
    pokeChannel();
    if (code !== 0) sendError = "edit failed";
    draw();
  });
}

/**
 * Where the input panel sits: the chat column (right of the meet list), padded.
 * The full draw and the send-timer footer redraw both use this — the footer
 * redraw used to paint a second, full-width panel over the sidebar.
 */
export function inputPanelGeometry(cols, rows, meeting = viewedMeeting()) {
  const layout = inlineLayout(cols, rows);
  const sideW = meetSideWidth(layout.cols, meeting);
  return {
    top: layout.promptTop,
    cols: cols - sideW,
    left: sideW + 1,
    inputRows: layout.inputRows,
    padY: layout.padY,
  };
}

function drawFooterOnly() {
  const { cols, rows } = paneSize();
  const g = inputPanelGeometry(cols, rows);
  drawInputPanel(g.top, g.cols, g.left, g.inputRows, g.padY);
}

function startSendTimer() {
  if (sendTimer) return;
  sendTimer = setInterval(() => {
    sendDots = (sendDots % 3) + 1;
    drawFooterOnly();
  }, 400);
}

function stopSendTimer() {
  if (sendTimer) clearInterval(sendTimer);
  sendTimer = null;
  sendDots = 1;
}


function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function currentMeetId() {
  try {
    return String(readFileSync(`${ROOT}/sessions/meetings/.current`, "utf8")).trim() || null;
  } catch {
    return null;
  }
}

/** Cooperative pause then run gotchi-meet pardon (side turn). //pardon-me-v1 */
async function runPardonInterrupt(rawLine) {
  const mid = currentMeetId();
  const question = stripPardonPrefix(rawLine) || String(rawLine || "").trim();
  if (!question) {
    sendError = "pardon needs a question";
    draw();
    return;
  }

  if (sendBusy || activeChild) {
    if (mid) {
      writePardonRequest(mid, { question, raw: rawLine });
    }
    // Grace for cooperative pause (finish current speaker, write stack, exit).
    const graceMs = Number(process.env.GOTCHIBOT_PARDON_GRACE_MS || 12000);
    const started = Date.now();
    while ((sendBusy || activeChild) && Date.now() - started < graceMs) {
      await sleep(200);
      if (mid && hasPardonStack(mid) && !activeChild) break;
    }
    if (activeChild) {
      try {
        activeChild.kill("SIGTERM");
      } catch {
        /* ok */
      }
      // Recover stack from in-flight round if sayTurn died mid-speaker.
      if (mid && !hasPardonStack(mid)) {
        const stack = stackFromRound(readPardonRound(mid), { reason: "sigterm" });
        if (stack?.remainingSpeakerIds?.length) writePardonStack(mid, stack);
      }
      await sleep(400);
      activeChild = null;
      sendBusy = false;
      clearPending();
      stopSendTimer();
    }
    if (mid) clearPardonRequest(mid);
  }

  // Side turn — chair or @mentions only.
  sendBusy = true;
  sendError = null;
  startSendTimer();
  draw();
  const child = spawn(
    process.execPath,
    [`${ROOT}/scripts/gotchi-meet.mjs`, "pardon", question],
    {
      cwd: ROOT,
      stdio: "ignore",
      env: { ...process.env, GOTCHIBOT_MEET_QUIET: "1" },
    },
  );
  activeChild = child;
  child.on("error", () => {
    if (activeChild === child) activeChild = null;
    sendBusy = false;
    stopSendTimer();
    sendError = "pardon failed";
    pokeChannel();
    draw();
  });
  child.on("close", (code) => {
    if (activeChild === child) activeChild = null;
    sendBusy = false;
    stopSendTimer();
    pokeChannel();
    if (code !== 0) sendError = "pardon failed";
    else if (mid && hasPardonStack(mid)) sendError = "paused · /continue";
    draw();
  });
}

function runContinueParked() {
  const mid = currentMeetId();
  if (!mid || !hasPardonStack(mid)) {
    sendError = "no parked round";
    draw();
    return;
  }
  if (sendBusy) return;
  sendBusy = true;
  sendError = null;
  startSendTimer();
  draw();
  const child = spawn(
    process.execPath,
    [`${ROOT}/scripts/gotchi-meet.mjs`, "continue"],
    {
      cwd: ROOT,
      stdio: "ignore",
      env: { ...process.env, GOTCHIBOT_MEET_QUIET: "1" },
    },
  );
  activeChild = child;
  child.on("error", () => {
    if (activeChild === child) activeChild = null;
    sendBusy = false;
    stopSendTimer();
    sendError = "continue failed";
    pokeChannel();
    draw();
  });
  child.on("close", (code) => {
    if (activeChild === child) activeChild = null;
    sendBusy = false;
    stopSendTimer();
    pokeChannel();
    if (code !== 0) sendError = "continue failed";
    draw();
  });
}

function sayToRoom(msg) {
  const text = String(msg || "").trim();
  if (!text || sendBusy) return;
  sendBusy = true;
  sendError = null;
  writePending(text);
  pokeChannel();
  startSendTimer();
  draw();

  const child = spawn(process.execPath, [`${ROOT}/scripts/gotchi-meet.mjs`, "say", text], {
    cwd: ROOT,
    stdio: "ignore",
    env: { ...process.env, GOTCHIBOT_MEET_QUIET: "1" },
  });
  activeChild = child;
  child.on("error", () => {
    if (activeChild === child) activeChild = null;
    sendBusy = false;
    clearPending();
    stopSendTimer();
    sendError = "send failed";
    pokeChannel();
    draw();
  });
  child.on("close", (code) => {
    if (activeChild === child) activeChild = null;
    sendBusy = false;
    clearPending();
    stopSendTimer();
    pokeChannel();
    if (code !== 0) sendError = "send failed";
    draw();
  });
}

/** morning-recap / colabo helpers (async, redraw on finish). */
function runMeetHelper(argv, { pending = null, failLabel = "helper failed", env = {}, onDone = null } = {}) {
  if (sendBusy) return;
  sendBusy = true;
  sendError = null;
  if (pending) writePending(pending, { chair: false });
  startSendTimer();
  draw();
  const child = spawn(process.execPath, [`${ROOT}/scripts/gotchi-meet.mjs`, ...argv], {
    cwd: ROOT,
    stdio: "ignore",
    env: { ...process.env, GOTCHIBOT_MEET_QUIET: "1", ...env },
  });
  activeChild = child;
  child.on("error", () => {
    if (activeChild === child) activeChild = null;
    sendBusy = false;
    if (pending) clearPending();
    stopSendTimer();
    sendError = failLabel;
    pokeChannel();
    draw();
  });
  child.on("close", (code) => {
    if (activeChild === child) activeChild = null;
    sendBusy = false;
    if (pending) clearPending();
    stopSendTimer();
    pokeChannel();
    if (code !== 0) sendError = failLabel;
    else if (onDone) onDone();
    draw();
  });
}

/**
 * `!cmd` — run a shell command right here (Claude Code / OpenCode style) and post
 * the command + output to the room, so the gotchis see it too. No model turn.
 */
function runShellInRoom(cmd) {
  runMeetHelper(["shell", cmd], { pending: `$ ${cmd}`, failLabel: "shell post failed" });
}

/** Ctrl+C in raw mode: cancel busy send → clear line → leave to chat (double-tap or empty). */
function handleCtrlC() {
  const now = Date.now();
  const doubleTap = now - lastCtrlCAt < 900;
  lastCtrlCAt = now;

  if (sendBusy || activeChild) {
    try {
      activeChild?.kill("SIGTERM");
    } catch {
      /* ok */
    }
    activeChild = null;
    sendBusy = false;
    clearPending();
    stopSendTimer();
    sendError = "interrupted";
    pokeChannel();
    draw();
    return "redraw";
  }

  if (editor.buffer.length > 0 && !doubleTap) {
    editor.clear();
    return "redraw";
  }

  // Empty line or second Ctrl+C → leave meet UI (meeting stays open; /end to close).
  requestLeave("chat");
  return "chat";
}

function requestLeave(kind) {
  const mode = kind === "cockpit" ? "cockpit" : kind === "chat" ? "chat" : "end";
  // Inline has no tmux layout consumer for the leave file — skip it.
  if (!INLINE) {
    try {
      writeFileSync(LEAVE, `${mode}\n`);
    } catch {
      /* ok */
    }
  }
  stopSendTimer();
  clearPending();
  stopInlineWatch();
  teardown();
  process.exit(0);
}

function endMeeting() {
  requestLeave("end");
}

function backToChat() {
  requestLeave("chat");
}

function backToCockpit() {
  requestLeave("cockpit");
}

/** Scroll the iMessage transcript toward older turns. */
/** Half a transcript page; dir 1 = older (up), -1 = newer (down). */
function scrollHalf(dir) {
  const { cols, rows } = paneSize();
  const layout = inlineLayout(cols, rows);
  const step = Math.max(1, Math.floor(layout.transcriptRows / 2));
  scrollFromBottom = Math.max(0, scrollFromBottom + dir * step);
  clampInlineScroll(layout.cols, layout.transcriptRows);
  return true;
}

/** Open sidebar on the meet in view, so ⏎ right away re-opens it. */
function focusSidebar() {
  meetPaneFocus = "sidebar";
  const meets = listMeetThreads();
  const viewing = viewedMeeting()?.id;
  const at = meets.findIndex((m) => m.id === viewing);
  if (at >= 0) sideSel = at;
  const { rows } = paneSize();
  revealSideSel(Math.max(1, rows - 1));
}

function pagePrev() {
  const { cols, rows } = paneSize();
  const layout = inlineLayout(cols, rows);
  scrollFromBottom += 5;
  clampInlineScroll(layout.cols, layout.transcriptRows);
  return true;
}

/** Scroll the iMessage transcript toward newer turns. */
function pageNext() {
  const { cols, rows } = paneSize();
  const layout = inlineLayout(cols, rows);
  scrollFromBottom = Math.max(0, scrollFromBottom - 5);
  clampInlineScroll(layout.cols, layout.transcriptRows);
  return true;
}

/** 1-based row of the pager in the last draw (for mouse hits). */
let lastPagerRow = 0;
let lastPagerCols = 80;

/** Pick up [edit] clicks from the # meet channel pane. */
function consumeEditRequest() {
  try {
    const raw = readFileSync(EDIT_REQUEST, "utf8");
    unlinkSync(EDIT_REQUEST);
    const req = JSON.parse(raw);
    const ts = String(req?.ts || "").trim();
    if (!ts) return false;
    editTargetTs = ts;
    editor.buffer = String(req.text ?? "");
    editor.cursor = editor.buffer.length;
    editor.menuIdx = 0;
    return true;
  } catch {
    return false;
  }
}

function padPanelLine(text, cols) {
  const inner = Math.max(1, cols - INPUT_PAD_X * 2);
  const n = visLen(text);
  const pad = Math.max(0, inner - n);
  return `${" ".repeat(INPUT_PAD_X)}${text}${T.panel}${" ".repeat(pad)}${T.reset}${" ".repeat(INPUT_PAD_X)}`;
}

function loadPinnedModelId() {
  try {
    const chat = readFileSync(`${ROOT}/sessions/.chat-model`, "utf8").trim();
    if (chat) return chat;
  } catch {
    /* fall through */
  }
  try {
    const pin = readFileSync(`${ROOT}/sessions/.gotchi-model.env`, "utf8");
    const m = pin.match(/^export GOTCHIBOT_OPENCODE_MODEL=(.+)$/m);
    if (m?.[1]?.trim()) return m[1].trim();
  } catch {
    /* fall through */
  }
  return process.env.GOTCHIBOT_OPENCODE_MODEL?.trim() || "opencode-go/kimi-k3";
}

function loadModelFooterLabel() {
  const raw = loadPinnedModelId();
  const slug = raw.split("/").pop() || raw;
  if (MODEL_LABELS[slug]) return MODEL_LABELS[slug];
  return slug
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function footerTicks(cols, used) {
  const n = Math.max(0, cols - used);
  if (n <= 0) return "";
  return `${T.panel}${T.tick}${"╎".repeat(n)}${T.reset}`;
}

/** Split buffer across input rows (OpenCode-style — no meet › prefix). */
function layoutInput(buffer, cursor, cols, inputRows = PROMPT_INPUT_ROWS) {
  const width = Math.max(1, cols - INPUT_LEFT - INPUT_PAD_X * 2);
  const segments = [];
  let pos = 0;
  for (let i = 0; i < inputRows; i++) {
    const text = buffer.slice(pos, pos + width);
    segments.push({ text, start: pos });
    pos += text.length;
  }

  let cursorRow = 0;
  let cursorCol = INPUT_PAD_X + INPUT_LEFT;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const end = seg.start + seg.text.length;
    if (cursor <= end || i === segments.length - 1) {
      cursorRow = i;
      cursorCol = INPUT_PAD_X + INPUT_LEFT + Math.max(0, cursor - seg.start);
      break;
    }
  }
  return { segments, cursorRow, cursorCol };
}

/**
 * Input panel inside the chat column: `left` is its first pane column (1-based),
 * `cols` its width. With the sidebar up it never runs under the meet list.
 */
function drawInputPanel(top, cols, left = 1, inputRows = PROMPT_INPUT_ROWS, padY = 0) {
  const { segments, cursorRow, cursorCol } = layoutInput(editor.buffer, editor.cursor, cols, inputRows);
  // Padding rows above and below the panel, chat column only.
  for (let p = 1; p <= padY; p++) {
    writeAt(top - p, left, "");
    writeAt(top + inputRows + PROMPT_FOOTER_ROWS - 1 + p, left, "");
  }

  for (let i = 0; i < inputRows; i++) {
    const seg = segments[i];
    const off = Math.max(0, editor.cursor - seg.start);
    const before = seg.text.slice(0, off);
    const after = seg.text.slice(off);
    const showCursor = i === cursorRow;
    let body;
    if (showCursor && before.length === 0 && after.length === 0) {
      body = T.cursor;
    } else if (showCursor) {
      body = `${T.text}${before}${T.reset}${T.cursor}${T.text}${after}${T.reset}`;
    } else {
      body = seg.text ? `${T.text}${seg.text}${T.reset}` : "";
    }
    const line = `${T.accentBar}${T.panel} ${body}`;
    writeAt(top + i, left, padPanelLine(line, cols));
  }

  const model = loadModelFooterLabel();
  let footerCore;
  if (sendError) {
    footerCore =
      `${T.accentBar}${T.panel} ${T.brand}Gotchi${T.reset}${T.panel}${T.muted} · ${T.text}${sendError}${T.reset}`;
  } else if (sendBusy) {
    const dots = ".".repeat(sendDots);
    footerCore =
      `${T.accentBar}${T.panel} ${T.brand}Gotchi${T.reset}${T.panel}${T.muted} · ${T.text}Sending${dots}${T.reset}`;
  } else if (editTargetTs) {
    footerCore =
      `${T.accentBar}${T.panel} ${T.brand}Gotchi${T.reset}${T.panel}${T.muted} · ${T.text}editing message${T.reset}` +
      `${T.panel}${T.muted} · Enter saves · Esc/empty cancels${T.reset}`;
  } else {
    footerCore =
      `${T.accentBar}${T.panel} ${T.brand}Gotchi${T.reset}${T.panel}${T.muted} · ${T.text}${model}${T.reset}` +
      (INLINE
        ? `${T.panel}${T.muted} · ${meetPaneFocus === "sidebar" ? "↑↓ pick meet · ⏎ open · Tab chat" : "Tab meets · ↑↓/wheel ^U/^D scroll · ^P/^N history"} · q quit · /help${T.reset}`
        : `${T.panel}${T.muted} · ${meetPaneFocus === "sidebar" ? "↑↓ pick meet · ⏎ open · Tab/Esc chat" : "Tab meets · ↑↓/wheel ^U/^D PgUp/PgDn scroll · ^P/^N history · Home/End"} · /help${T.reset}`);
  }
  writeAt(top + inputRows, left, padPanelLine(footerCore + footerTicks(cols - INPUT_PAD_X * 2, visLen(footerCore)), cols));

  stdout.write(`\x1b[${top + cursorRow};${Math.min(left - 1 + cols, left - 1 + cursorCol + 1)}H`);
}

function writeAt(row, col, text) {
  const t = _tui.glyphs === "ascii" ? toAsciiGlyphs(text) : text;
  stdout.write(`\x1b[${row};${col}H\x1b[K${t}`);
}

class Prompter {
  buffer = "";
  cursor = 0;
  history = [];
  histPos = -1;
  draft = "";
  menuIdx = 0;

  insert(ch) {
    this.buffer = this.buffer.slice(0, this.cursor) + ch + this.buffer.slice(this.cursor);
    this.cursor += ch.length;
    this.histPos = -1;
  }

  backspace() {
    if (this.cursor <= 0) return;
    this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
    this.cursor -= 1;
    this.histPos = -1;
  }

  del() {
    if (this.cursor >= this.buffer.length) return;
    this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
    this.histPos = -1;
  }

  move(delta) {
    this.cursor = Math.max(0, Math.min(this.buffer.length, this.cursor + delta));
  }

  home() {
    this.cursor = 0;
  }

  end() {
    this.cursor = this.buffer.length;
  }

  clear() {
    this.buffer = "";
    this.cursor = 0;
    this.histPos = -1;
    this.draft = "";
  }

  historyUp() {
    if (!this.history.length) return;
    if (this.histPos < 0) this.draft = this.buffer;
    this.histPos = Math.min(this.history.length - 1, this.histPos < 0 ? this.history.length - 1 : this.histPos - 1);
    this.buffer = this.history[this.histPos];
    this.cursor = this.buffer.length;
  }

  historyDown() {
    if (!this.history.length || this.histPos < 0) return;
    this.histPos += 1;
    if (this.histPos >= this.history.length) {
      this.histPos = -1;
      this.buffer = this.draft;
    } else {
      this.buffer = this.history[this.histPos];
    }
    this.cursor = this.buffer.length;
  }

  completeMention() {
    const q = activeMentionQuery(this.buffer);
    if (q == null) return false;
    const matches = matchingMentions(q);
    if (!matches.length) return false;
    this.menuIdx = this.menuIdx % matches.length;
    const pick = matches[this.menuIdx];
    this.menuIdx += 1;
    const head = this.buffer.replace(/@([A-Za-z0-9_-]*)$/, pick.tag + " ");
    this.buffer = head;
    this.cursor = this.buffer.length;
    return true;
  }

  completeSlash() {
    const q = activeSlashQuery(this.buffer);
    if (q == null) return false;
    const matches = matchingSlashCmds(q);
    if (!matches.length) return false;
    this.menuIdx = this.menuIdx % matches.length;
    const pick = matches[this.menuIdx];
    this.menuIdx += 1;
    this.buffer = pick.needsArg ? `${pick.tag} ` : pick.tag;
    this.cursor = this.buffer.length;
    return true;
  }

  /** Tab: slash menu first, then @mentions. */
  completeMenu() {
    if (this.completeSlash()) return true;
    return this.completeMention();
  }

  /** ↑/↓ while a slash/@ menu is open: cycle highlight only. */
  cycleMenu(delta) {
    const sq = activeSlashQuery(this.buffer);
    const slash = sq != null ? matchingSlashCmds(sq) : [];
    if (slash.length) {
      const n = slash.length;
      this.menuIdx = ((this.menuIdx + delta) % n + n) % n;
      return true;
    }
    const mq = activeMentionQuery(this.buffer);
    const mentions = mq != null ? matchingMentions(mq) : [];
    if (mentions.length) {
      const n = mentions.length;
      this.menuIdx = ((this.menuIdx + delta) % n + n) % n;
      return true;
    }
    return false;
  }

  submit() {
    // Enter on a slash stub: accept the highlighted menu pick first.
    const sq = activeSlashQuery(this.buffer);
    if (sq != null) {
      const matches = matchingSlashCmds(sq);
      if (matches.length) {
        const pick = matches[this.menuIdx % matches.length];
        if (pick.needsArg) {
          this.buffer = `${pick.tag} `;
          this.cursor = this.buffer.length;
          return "redraw";
        }
        this.buffer = pick.tag;
        this.cursor = this.buffer.length;
      } else if (this.buffer.trim() === "/" || sq) {
        // No match — show help instead of saying.
        this.clear();
        sendError =
          "/chat pick gotchis · /prev /next · /edit · /start · /end · /desk · /cockpit · /colabo · /pardon · /continue · !cmd · ^C leave";
        return "redraw";
      }
    }
    const line = this.buffer.trim();
    this.clear();
    if (!line) {
      if (editTargetTs) editTargetTs = null; // empty submit cancels edit
      return "noop";
    }
    if (line === "/start" || line.startsWith("/start ")) {
      editTargetTs = null;
      const topic = line.replace(/^\/start\s*/i, "").trim();
      runMeetHelper(topic ? ["start", topic] : ["start"]);
      return "redraw";
    }
    if (line === "/end") {
      // Stop recording only — stay in the room UI.
      editTargetTs = null;
      runMeetHelper(["end"]);
      return "redraw";
    }
    if (line === "/chat") {
      editTargetTs = null;
      openChatPicker();
      return "redraw";
    }
    if (line === "/quit" || line === "/leave" || line === "/opencode" || line === "/desk") {
      editTargetTs = null;
      return "chat";
    }
    if (INLINE && (line === "q" || line === "/q")) {
      editTargetTs = null;
      return "chat";
    }
    if (line === "/cockpit" || line === "/menu") {
      editTargetTs = null;
      return "cockpit";
    }
    if (line === "/help" || line === "/?") {
      editTargetTs = null;
      sendError =
        "/chat pick gotchis · /prev /next · /edit · /start · /end · /desk · /cockpit · /colabo · /pardon · /continue · !cmd · ^C leave";
      return "redraw";
    }
    if (line === "/edit") {
      if (loadEditTarget(null)) return "redraw";
      sendError = "no user message to edit";
      return "redraw";
    }
    if (line.startsWith("/edit ")) {
      const ts = line.slice(6).trim();
      if (loadEditTarget(ts)) return "redraw";
      sendError = `no user message at ${ts}`;
      return "redraw";
    }
    if (line === "/prev" || line === ",") {
      editTargetTs = null;
      pagePrev();
      return "redraw";
    }
    if (line === "/next" || line === ".") {
      editTargetTs = null;
      pageNext();
      return "redraw";
    }
    if (line === "/recap-next" || line === "/agent-next") {
      editTargetTs = null;
      runMeetHelper(["morning", "next"]);
      return "redraw";
    }
    if (line === "/recap-present") {
      editTargetTs = null;
      runMeetHelper(["morning", "present"]);
      return "redraw";
    }
    if (line.startsWith("!")) {
      const cmd = line.slice(1).trim();
      if (!cmd) return "noop";
      editTargetTs = null;
      this.history.push(line);
      if (this.history.length > 100) this.history.shift();
      runShellInRoom(cmd);
      return "redraw";
    }
    if (line.startsWith("/colabo ") || line.startsWith("/collabo ")) {
      const prompt = line.replace(/^\/col+abo\s+/i, "").trim();
      if (prompt) {
        editTargetTs = null;
        runMeetHelper(["colabo", prompt]);
      }
      return "redraw";
    }
    if (isPardonTrigger(line) || line.toLowerCase().startsWith("/pardon")) {
      editTargetTs = null;
      this.history.push(line);
      if (this.history.length > 100) this.history.shift();
      void runPardonInterrupt(line);
      return "redraw";
    }
    if (isContinueTrigger(line) || line === "/resume") {
      editTargetTs = null;
      runContinueParked();
      return "redraw";
    }
    // Never post slash text as a room message — unmatched /cmds used to
    // fall through to say ("Gotchi · send failed" / wake the chair).
    if (line === "/" || line.startsWith("/")) {
      editTargetTs = null;
      const cmd = line.split(/\s+/)[0];
      sendError =
        line === "/" || line === "/?"
          ? "/chat pick gotchis · /prev /next · /edit · /start · /end · /desk · /cockpit · /colabo · /pardon · /continue · !cmd · ^C leave"
          : `unknown ${cmd} · /help`;
      return "redraw";
    }
    this.history.push(line);
    if (this.history.length > 100) this.history.shift();
    if (editTargetTs) {
      // Editing: rewrite the target turn in place — do NOT say / wake agents.
      const ts = editTargetTs;
      editTargetTs = null;
      editToRoom(ts, line);
      return "redraw";
    }
    const v = viewedMeeting();
    if (v && v.status === "paused" && v.parkedId) {
      // Typing in a paused meet resumes it (parks the current one), then sends.
      const r = spawnSync(process.execPath, [`${ROOT}/scripts/gotchi-meet.mjs`, "switch", v.parkedId], {
        cwd: ROOT,
        stdio: "ignore",
        env: { ...process.env, GOTCHIBOT_MEET_QUIET: "1" },
      });
      if (r.status !== 0) {
        sendError = "could not resume that meet";
        return "redraw";
      }
      viewMeetingId = null;
    } else if (v && v.status !== "open") {
      sendError = "ended log is read-only · /chat or /start to talk";
      return "redraw";
    }
    sayToRoom(line);
    return "redraw";
  }
}

const editor = new Prompter();

function clampInlineScroll(cols, transcriptRows) {
  const meeting = viewedMeeting();
  const max = meeting
    ? maxScrollFromBottom({ cols: cols - meetSideWidth(cols, meeting), rows: transcriptRows, meeting })
    : 0;
  scrollFromBottom = Math.max(0, Math.min(max, scrollFromBottom));
}

function drawBodyInline() {
  consumeEditRequest();
  const { cols, rows } = paneSize();
  const layout = inlineLayout(cols, rows);
  clampInlineScroll(layout.cols, layout.transcriptRows);

  const meeting = viewedMeeting();
  const sideW = meetSideWidth(layout.cols, meeting);
  const frame = renderInlineFrame({
    cols: layout.cols,
    rows: layout.rows,
    meeting,
    scrollFromBottom,
  });
  const frameLines = String(frame).split("\n");
  // Home + clear-to-EOL per line (same flash-free pattern as gallery draw).
  // A full-height frame (sidebar down to the last row) must not end in "\n":
  // that would scroll the whole pane up a line.
  const tail = frameLines.length < layout.rows ? "\n\x1b[J" : "";
  stdout.write(`\x1b[H${frameLines.map((l) => `${l}\x1b[K`).join("\n")}${tail}`);

  const slashQ = activeSlashQuery(editor.buffer);
  const slashMatches = slashQ != null ? matchingSlashCmds(slashQ) : [];
  const mentionQ = slashQ == null ? activeMentionQuery(editor.buffer) : null;
  const mentionMatches = mentionQ != null ? matchingMentions(mentionQ) : [];
  const mentionRow = layout.mentionRow;

  if (slashMatches.length && slashQ != null) {
    const n = slashMatches.length;
    const menu = slashMatches
      .slice(0, 8)
      .map((c, i) => {
        const on = i === editor.menuIdx % n;
        const tag = `${on ? T.menu : T.mention}${c.tag}${T.reset}`;
        const hint = on ? `${T.muted} ${c.hint}${T.reset}` : "";
        return `${tag}${hint}`;
      })
      .join(`${T.muted} · ${T.reset}`);
    writeAt(
      Math.max(1, mentionRow),
      sideW + 1,
      padPanelLine(`${T.accentBar}${T.panel} ${menu}`, cols - sideW),
    );
  } else if (mentionMatches.length && mentionQ != null) {
    const menu = mentionMatches
      .slice(0, 6)
      .map((m, i) => `${i === editor.menuIdx % mentionMatches.length ? T.menu : T.mention}${m.tag}${T.reset}`)
      .join(`${T.muted}  ${T.reset}`);
    writeAt(
      Math.max(1, mentionRow),
      sideW + 1,
      padPanelLine(`${T.accentBar}${T.panel} ${T.muted}${menu}${T.reset}`, cols - sideW),
    );
  }

  // Chat column only: start past the sidebar rule.
  const g = inputPanelGeometry(cols, rows, meeting);
  drawInputPanel(g.top, g.cols, g.left, g.inputRows, g.padY);
  if (chatPick) {
    drawChatPicker(sideW + 1, cols - sideW, layout.transcriptTop, layout.transcriptRows);
    stdout.write("\x1b[?25l");
  } else {
    stdout.write("\x1b[?25h");
  }
}

function drawBody() {
  // Desk meet pane and --inline share the iMessage transcript, not the 3×2 seat grid.
  drawBodyInline();
}

function draw() {
  if (drawing) {
    redrawPending = true;
    return;
  }
  drawing = true;
  try {
    drawBody();
  } catch (e) {
    try {
      stdout.write(`\x1b[H\x1b[J${T.text}meet room render error — retrying…${T.reset}\n`);
    } catch {
      /* ok */
    }
  } finally {
    drawing = false;
    if (redrawPending) {
      redrawPending = false;
      setImmediate(() => draw());
    }
  }
}

function teardown() {
  clearPending();
  stopInlineWatch();
  try {
    stdin.setRawMode(false);
  } catch {
    /* ok */
  }
  try {
    stdin.pause();
  } catch {
    /* ok */
  }
  // Disable mouse (if enabled) + show cursor + wrap on + leave alt screen
  try {
    if (mouseEnabled()) stdout.write("\x1b[?1006l\x1b[?1000l");
    stdout.write("\x1b[?25h\x1b[?7h\x1b[?1049l");
  } catch {
    /* ok */
  }
}

function setup() {
  if (!stdin.isTTY || !stdout.isTTY) {
    console.error(
      INLINE
        ? "Meet room --inline needs an interactive terminal (try: ssh -t …)."
        : "Meet room needs an interactive terminal (attach the tmux chat pane).",
    );
    process.exit(1);
  }
  // Alt screen, no wrap. Mouse tracking stays off so wheel cannot flood the pane.
  // Keyboard j/k scroll one line; , [ h and . ] l page when the prompt is empty.
  stdout.write("\x1b[?1049h\x1b[?7l\x1b[?25h");
  try {
    stdin.setRawMode(true);
  } catch (e) {
    console.error(`Meet room TTY setup failed: ${e.message || e}`);
    process.exit(1);
  }
  stdin.resume();
  stdin.setEncoding("utf8");
}

let escBuf = "";

function bufferEmpty() {
  return !String(editor.buffer || "").trim();
}

/**
 * Vim line scroll for the iMessage transcript.
 * +1 is up (older turns). -1 is down (newer turns). 0 is not a scroll key.
 */
export function meetScrollDelta(key) {
  if (key === "j" || key === "J") return -1;
  if (key === "k" || key === "K") return 1;
  return 0;
}

/** Mouse click on pager row: left third = prev, right third = next (1-based x,y). */
function applyPagerClick(x, y) {
  if (!lastPagerRow || y < lastPagerRow || y > lastPagerRow + 1) return false;
  const w = Math.max(1, lastPagerCols || 40);
  const leftEnd = Math.floor(w / 3);
  const rightStart = w - Math.floor(w / 3);
  if (x < leftEnd) return pagePrev();
  if (x >= rightStart) return pageNext();
  return false;
}

function handleKey(chunk) {
  if (escBuf) {
    escBuf += chunk;
    // SGR mouse: \x1b[<b;x;yM  or  \x1b[<b;x;ym
    if (escBuf.startsWith("\x1b[<")) {
      const m = escBuf.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
      if (m) {
        escBuf = "";
        const btn = Number(m[1]);
        const x = Number(m[2]);
        const y = Number(m[3]);
        const release = m[4] === "m";
        if (btn === 64 || btn === 65 || btn === 4 || btn === 5) return "noop";
        if (!release && (btn === 0 || btn === 32)) {
          if (applyPagerClick(x, y)) return "redraw";
        }
        return "noop";
      }
      if (escBuf.length > 32) escBuf = "";
      return;
    }
    // X10 mouse: \x1b[MCbCxCy  (3 bytes after M)
    if (escBuf.startsWith("\x1b[M") && escBuf.length >= 6) {
      const b = escBuf.charCodeAt(3) - 32;
      const x = escBuf.charCodeAt(4) - 32;
      const y = escBuf.charCodeAt(5) - 32;
      escBuf = "";
      if (b === 64 || b === 65) return "noop";
      if ((b & 3) === 0 && applyPagerClick(x, y)) return "redraw";
      return "noop";
    }
    if (/[A-Za-z~]$/.test(escBuf) || escBuf.length > 12) {
      const seq = escBuf;
      escBuf = "";
      return handleEsc(seq);
    }
    return;
  }

  if (chunk === "\x1b") {
    escBuf = "\x1b";
    return;
  }

  // /chat picker owns the keyboard while open.
  if (chatPick) {
    if (chunk === "j" || chunk === "J") return chatPickerKey("down");
    if (chunk === "k" || chunk === "K") return chatPickerKey("up");
    if (chunk === " ") return chatPickerKey("toggle");
    if (chunk === "\r" || chunk === "\n") return chatPickerKey("enter");
    if (chunk === "\x03") return handleCtrlC();
    return "noop";
  }

  // Sidebar focus: j/k pick a meet, Enter opens its log, Tab goes back to chat.
  // Any other typing returns to the chat and lands in the prompt.
  if (meetPaneFocus === "sidebar") {
    if (chunk === "j" || chunk === "J") return sidebarKey("down");
    if (chunk === "k" || chunk === "K") return sidebarKey("up");
    if (chunk === "\r" || chunk === "\n") return sidebarKey("open");
    if (chunk === "\t") return sidebarKey("leave");
    if (chunk === "m" || chunk === "M") return "noop";
    if (chunk.length === 1 && chunk >= " ") meetPaneFocus = "chat";
  }

  // Scroll the transcript while typing: Ctrl+U up / Ctrl+D down, half a page.
  if (chunk === "\x15") {
    scrollHalf(1);
    return "redraw";
  }
  if (chunk === "\x04" && !(INLINE && bufferEmpty() && !editTargetTs)) {
    scrollHalf(-1);
    return "redraw";
  }

  // Immediate scroll keys when the prompt is empty (no Enter needed).
  // j/k match the channel and factory panes: j down (newer), k up (older), one line.
  if (bufferEmpty() && !editTargetTs) {
    const focus = meetFocusTarget(chunk);
    if (focus) {
      if (focus === "sidebar") focusSidebar();
      else meetPaneFocus = focus;
      return "redraw";
    }
    const line = meetScrollDelta(chunk);
    if (line) {
      if (meetPaneFocus === "sidebar") {
        sideScroll = Math.max(0, sideScroll + (line < 0 ? 1 : -1));
      } else {
        scrollFromBottom = Math.max(0, scrollFromBottom + line);
      }
      return "redraw";
    }
    if (chunk === "," || chunk === "[" || chunk === "h") {
      pagePrev();
      return "redraw";
    }
    if (chunk === "." || chunk === "]" || chunk === "l") {
      pageNext();
      return "redraw";
    }
  }

  switch (chunk) {
    case "\r":
    case "\n":
      return editor.submit();
    case "\x7f":
    case "\b":
      editor.backspace();
      return "redraw";
    case "\t":
      if (editor.completeMenu()) return "redraw";
      // Tab on an empty prompt: jump to the meet list.
      if (bufferEmpty() && !editTargetTs) {
        focusSidebar();
        return "redraw";
      }
      return "noop";
    case "\x03":
      return handleCtrlC();
    case "\x04":
      // Ctrl+D on empty buffer → leave (inline); non-inline unchanged.
      if (INLINE && bufferEmpty() && !editTargetTs) {
        return "chat";
      }
      return "noop";
    case "\x10": // Ctrl+P — prompt history back (↑ scrolls the messages)
      if (editor.cycleMenu(-1)) return "redraw";
      editor.historyUp();
      return "redraw";
    case "\x0e": // Ctrl+N — prompt history forward
      if (editor.cycleMenu(1)) return "redraw";
      editor.historyDown();
      return "redraw";
    case "\x0c":
      return "redraw";
    default:
      if (chunk.length === 1 && chunk >= " ") {
        editor.insert(chunk);
        editor.menuIdx = 0;
        return "redraw";
      }
      return "noop";
  }
}

function handleEsc(seq) {
  if (chatPick) {
    if (seq === "\x1b[A" || seq === "\x1bOA") return chatPickerKey("up");
    if (seq === "\x1b[B" || seq === "\x1bOB") return chatPickerKey("down");
    if (seq === "\x1b[D" || seq === "\x1bOD") return chatPickerKey("back");
    if (seq === "\x1b[C" || seq === "\x1bOC") return chatPickerKey("enter");
    return "noop";
  }
  if (meetPaneFocus === "sidebar") {
    if (seq === "\x1b[A" || seq === "\x1bOA") return sidebarKey("up");
    if (seq === "\x1b[B" || seq === "\x1bOB") return sidebarKey("down");
    if (seq === "\x1b[C" || seq === "\x1bOC") return sidebarKey("open");
    if (seq === "\x1b[D" || seq === "\x1bOD") return "noop";
  }
  // Shift+↑/↓ one line; End jumps to the latest turn (empty prompt).
  if (seq === "\x1b[1;2A") {
    scrollFromBottom += 1;
    return "redraw";
  }
  if (seq === "\x1b[1;2B") {
    scrollFromBottom = Math.max(0, scrollFromBottom - 1);
    return "redraw";
  }
  if ((seq === "\x1b[F" || seq === "\x1b[4~" || seq === "\x1bOF") && bufferEmpty() && !editTargetTs) {
    scrollFromBottom = 0;
    return "redraw";
  }
  // Home jumps to the oldest line (the first meeting's start marker).
  if ((seq === "\x1b[H" || seq === "\x1b[1~" || seq === "\x1bOH") && bufferEmpty() && !editTargetTs) {
    const { cols, rows } = paneSize();
    const layout = inlineLayout(cols, rows);
    scrollFromBottom = Number.MAX_SAFE_INTEGER;
    clampInlineScroll(layout.cols, layout.transcriptRows);
    return "redraw";
  }
  if (seq === "\x1b[5~" || seq === "\x1b[6~") {
    scrollHalf(seq === "\x1b[5~" ? 1 : -1);
    return "redraw";
  }
  // Inline: PgUp/PgDn (and Shift+Up/Down) scroll the transcript.
  if (INLINE) {
    if (seq === "\x1b[5~" || seq === "\x1b[1;2A") {
      scrollFromBottom += seq === "\x1b[5~" ? 5 : 1;
      return "redraw";
    }
    if (seq === "\x1b[6~" || seq === "\x1b[1;2B") {
      scrollFromBottom = Math.max(0, scrollFromBottom - (seq === "\x1b[6~" ? 5 : 1));
      return "redraw";
    }
  }
  // PageUp / PageDown — scroll the iMessage transcript.
  if (seq === "\x1b[5~" || seq === "\x1b[6~") {
    if (seq === "\x1b[5~") pagePrev();
    else pageNext();
    return "redraw";
  }
  // Left / Right: page when prompt empty; otherwise move cursor.
  if (seq === "\x1b[C" || seq === "\x1bOC") {
    if (bufferEmpty() && !editTargetTs) {
      pageNext();
      return "redraw";
    }
    editor.move(1);
    return "redraw";
  }
  if (seq === "\x1b[D" || seq === "\x1bOD") {
    if (bufferEmpty() && !editTargetTs) {
      pagePrev();
      return "redraw";
    }
    editor.move(-1);
    return "redraw";
  }
  // ↑/↓ scroll the messages, never the prompt. With tmux mouse off, Terminal
  // turns the mouse wheel into arrow keys, so arrows recalling history used to
  // make the wheel rewrite the prompt. History is Ctrl+P / Ctrl+N; /edit edits.
  if (seq === "\x1b[A" || seq === "\x1bOA") {
    if (editor.cycleMenu(-1)) return "redraw";
    scrollFromBottom += 1;
    return "redraw";
  }
  if (seq === "\x1b[B" || seq === "\x1bOB") {
    if (editor.cycleMenu(1)) return "redraw";
    scrollFromBottom = Math.max(0, scrollFromBottom - 1);
    return "redraw";
  }
  if (seq === "\x1b[H" || seq === "\x1b[1~" || seq === "\x1bOH") {
    editor.home();
    return "redraw";
  }
  if (seq === "\x1b[F" || seq === "\x1b[4~" || seq === "\x1bOF") {
    editor.end();
    return "redraw";
  }
  if (seq === "\x1b[3~") {
    editor.del();
    return "redraw";
  }
  return "noop";
}

function ensureMeetGalleryLayout() {
  if (INLINE) return;
  if (!process.env.TMUX) return;
  runLayout("refresh-meet-gallery", {
    env: { GOTCHIBOT_MEET_LAYOUT_ONLY: "1" },
  });
}

function markTmuxPane() {
  if (INLINE) return;
  if (!process.env.TMUX) return;
  const tgt = process.env.TMUX_PANE || "";
  if (!tgt) return;
  spawnSync("tmux", ["set-option", "-p", "-t", tgt, "@gotchibot-meet-room", "1"], { stdio: "ignore" });
  spawnSync("tmux", ["set-option", "-p", "-t", tgt, "-u", "@gotchibot-chat"], { stdio: "ignore" });
  const active = deskActiveLine();
  const border = active
    ? ` #{?pane_active,●, }Meet · room · ${active.replace(/[{}#]/g, "")} `
    : " #{?pane_active,●, }Meet · room ";
  spawnSync("tmux", ["set-option", "-p", "-t", tgt, "pane-border-format", border], {
    stdio: "ignore",
  });
}

function mtimeKey(path) {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "";
  }
}

function inlineWatchPaths() {
  // Same root meet-channel uses (project-scoped when a project is selected).
  let root = join(ROOT, "sessions", "meetings");
  try {
    root = resolveMeetingsRoot().root || root;
  } catch {
    /* default */
  }
  const currentPtr = join(root, ".current");
  const paths = [currentPtr, STATUS_FILE];
  try {
    if (existsSync(currentPtr)) {
      const id = String(readFileSync(currentPtr, "utf8")).trim();
      if (id) {
        const dir = join(root, id);
        paths.push(join(dir, "meeting.json"), join(dir, "transcript.jsonl"));
      }
    }
  } catch {
    /* ok */
  }
  paths.push(join(ROOT, "sessions/.desk-active.line"));
  return paths;
}

function inlineWatchSnapshot() {
  return inlineWatchPaths().map((p) => `${p}=${mtimeKey(p)}`).join("|");
}

function stopInlineWatch() {
  if (inlineWatchTimer) {
    clearInterval(inlineWatchTimer);
    inlineWatchTimer = null;
  }
  for (const w of inlineWatchers) {
    try {
      w.close();
    } catch {
      /* ok */
    }
  }
  inlineWatchers = [];
}

function startInlineWatch() {
  stopInlineWatch();
  lastInlineWatchKey = inlineWatchSnapshot();

  const onChange = () => {
    const key = inlineWatchSnapshot();
    if (key === lastInlineWatchKey) return;
    lastInlineWatchKey = key;
    // New messages: stay pinned only when already at bottom (scrollFromBottom===0).
    // When scrolled up, clampInlineScroll keeps the offset within range.
    ensureStatusAnim();
    draw();
  };

  // Cheap mtime poll (unref so it won't keep the process alive alone).
  inlineWatchTimer = setInterval(onChange, 750);
  if (typeof inlineWatchTimer.unref === "function") inlineWatchTimer.unref();

  // Best-effort fs.watch; fall back is the poll above.
  for (const p of inlineWatchPaths()) {
    try {
      if (!existsSync(p) && !p.endsWith(".current") && !p.endsWith(".meet-status.json")) {
        continue;
      }
      const w = watch(p, { persistent: false }, () => onChange());
      inlineWatchers.push(w);
    } catch {
      /* poll covers it */
    }
  }
}

function restoreTerminalAndExit(code = 0) {
  try {
    stopSendTimer();
    stopStatusAnim();
    stopInlineWatch();
    teardown();
  } catch {
    /* ok */
  }
  process.exit(code);
}

function main() {
  ensureMeetGalleryLayout();
  markTmuxPane();
  setup();
  draw();
  startHubProjectMirror({
    root: ROOT,
    onChange() {
      try {
        draw();
      } catch {
        /* keep the room up */
      }
    },
  });
  if (!INLINE) {
    // Thumbs for the iMessage transcript. File reads, not a spawn per tile.
    try {
      warmThumbs(listMeetMembers().map((m) => m.id));
    } catch {
      /* ok */
    }
  }
  startInlineWatch();

  process.on("SIGUSR1", () => {
    ensureStatusAnim();
    draw();
  });
  process.on("SIGWINCH", () => draw());
  process.on("SIGTERM", () => restoreTerminalAndExit(0));
  process.on("SIGHUP", () => restoreTerminalAndExit(0));
  process.on("uncaughtException", (err) => {
    try {
      stopSendTimer();
      stopStatusAnim();
      stopInlineWatch();
      teardown();
    } catch {
      /* ok */
    }
    try {
      console.error(err?.stack || err);
    } catch {
      /* ok */
    }
    process.exit(1);
  });
  process.on("exit", () => {
    stopSendTimer();
    stopStatusAnim();
    stopInlineWatch();
    teardown();
  });
  // Keep status dots alive if a turn is already in flight when we open.
  if (hasActiveMeetStatus()) ensureStatusAnim();
  process.on("SIGINT", () => {
    handleCtrlC();
  });

  stdin.on("data", (chunk) => {
    const text = String(chunk);
    // Escape / mouse sequences must go through handleKey (accumulates escBuf).
    if (escBuf || text.startsWith("\x1b") || text.includes("\x1b")) {
      for (const ch of text) {
        // Lone Esc cancels edit mode (before it accumulates into a CSI sequence).
        if (!escBuf && ch === "\x1b" && editTargetTs && text.length === 1) {
          editTargetTs = null;
          draw();
          return;
        }
        // Lone Esc in the /chat picker: step back, then close.
        if (!escBuf && ch === "\x1b" && chatPick && text.length === 1) {
          chatPickerKey("back");
          draw();
          return;
        }
        // Lone Esc in the meet list goes back to the chat.
        if (!escBuf && ch === "\x1b" && meetPaneFocus === "sidebar" && text.length === 1) {
          meetPaneFocus = "chat";
          draw();
          return;
        }
        const action = handleKey(ch);
        if (action === "end") {
          endMeeting();
          return;
        }
        if (action === "chat") {
          backToChat();
          return;
        }
        if (action === "cockpit") {
          backToCockpit();
          return;
        }
        if (action === "redraw") draw();
      }
      return;
    }

    if (text.length > 1 && !/[\x00-\x1f\x7f]/.test(text)) {
      editor.insert(text);
      editor.menuIdx = 0;
      draw();
      return;
    }

    for (const ch of text) {
      const action = handleKey(ch);
      if (action === "end") {
        endMeeting();
        return;
      }
      if (action === "chat") {
        backToChat();
        return;
      }
      if (action === "cockpit") {
        backToCockpit();
        return;
      }
      if (action === "redraw") draw();
    }
  });
}

if (isMainModule(import.meta.url)) main();
