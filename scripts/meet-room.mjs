#!/usr/bin/env node
/**
 * Meet room — Zoom-style participant carousel + helpers.
 *
 *   node scripts/meet-room.mjs --render [--cols N] [--rows N] [--page N]
 *   node scripts/meet-room.mjs --members [--json]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCurrentMeeting, participantInfo, getThumb, orderMeetingParticipants } from "./meet-channel.mjs";
import { loadMeetStatus, statusFor, statusLabel } from "./meet-status.mjs";
import { isMainModule } from "./is-main.mjs";
import { downgradeAnsi, renderMode, toAsciiGlyphs } from "./lib/term-color.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE_FILE = `${ROOT}/sessions/.meet-room-page`;
const GRID_COLS = Math.max(1, Number(process.env.GOTCHIBOT_MEET_ROOM_COLS || 3) || 3);
const GRID_ROWS = Math.max(1, Number(process.env.GOTCHIBOT_MEET_ROOM_ROWS || 2) || 2);
const PER_PAGE = Math.max(1, Number(process.env.GOTCHIBOT_MEET_ROOM_PER_PAGE || GRID_COLS * GRID_ROWS) || GRID_COLS * GRID_ROWS);
/** Blank lines between seat rows (role label of row above vs thumb of row below). */
const ROW_GAP = Math.max(1, Number(process.env.GOTCHIBOT_MEET_ROOM_ROW_GAP || 5) || 5);

const _tui = renderMode();

const C_RAW = {
  reset: "\x1b[0m",
  dim: "\x1b[38;5;245m",
  topic: "\x1b[38;5;184m",
  bar: "\x1b[38;5;240m",
  hint: "\x1b[38;5;241m",
  body: "\x1b[38;5;252m",
  user: "\x1b[38;5;117m",
  chair: "\x1b[38;5;213m",
  agent: "\x1b[38;5;51m",
  active: "\x1b[38;5;220m",
  thinking: "\x1b[38;5;183m",
  responding: "\x1b[38;5;120m",
  idle: "\x1b[38;5;240m",
};

const C = Object.fromEntries(
  Object.entries(C_RAW).map(([k, v]) => [k, downgradeAnsi(v, _tui.color)]),
);

function stripAnsi(s) {
  return String(s || "").replace(/\x1b\[[0-9;]*m/g, "");
}

function visLen(s) {
  return stripAnsi(s).length;
}

function padVis(s, w) {
  const n = visLen(s);
  return n >= w ? s : s + " ".repeat(w - n);
}

function centerPadVis(s, w) {
  const n = visLen(s);
  if (w <= 0) return s;
  if (n >= w) return padVis(s, w);
  const left = Math.floor((w - n) / 2);
  return " ".repeat(left) + s + " ".repeat(w - n - left);
}

function centerPad(text, w) {
  const t = stripAnsi(text);
  if (w <= 0) return text;
  if (t.length >= w) return text.slice(0, w);
  const left = Math.floor((w - t.length) / 2);
  return " ".repeat(left) + text + " ".repeat(w - t.length - left);
}

function nameColor(role) {
  if (role === "user") return C.user;
  if (role === "chair") return C.chair;
  return C.agent;
}

// Thumbs come from meet-channel.mjs: same on-disk cache (sessions/.meet-thumbs)
// as the # meet transcript pane, so a page never spawns gotchi-art twice.

export function listMeetMembers(meeting = loadCurrentMeeting()) {
  if (!meeting) return [];
  return orderMeetingParticipants(meeting.participants || [], meeting.chairId).map((p) => {
    const info = participantInfo(meeting, p.id);
    return {
      id: p.id,
      label: info.name,
      role: p.role || info.role,
    };
  });
}

export function loadPage() {
  try {
    const n = Number(String(readFileSync(PAGE_FILE, "utf8")).trim());
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function savePage(page) {
  mkdirSync(dirname(PAGE_FILE), { recursive: true });
  writeFileSync(PAGE_FILE, `${Math.max(0, page)}\n`);
}

export function pageCount(members = listMeetMembers()) {
  return Math.max(1, Math.ceil(members.length / PER_PAGE));
}

export function clampPage(page, members = listMeetMembers()) {
  const max = pageCount(members) - 1;
  return Math.max(0, Math.min(max, page));
}

function statusColor(status) {
  if (status === "thinking") return C.thinking;
  if (status === "responding") return C.responding;
  return C.idle;
}

function cellBlock(member, cellW, statusState) {
  const thumb = getThumb(member.id);
  const roleColor = nameColor(member.role);
  const st = statusFor(member.id, statusState);
  const label = statusLabel(st.status, st.since);
  const stColor = statusColor(st.status);
  const lines = [];
  for (let i = 0; i < thumb.length; i++) {
    lines.push(centerPadVis(thumb[i] || "", cellW));
  }
  lines.push(centerPad(`${roleColor}${member.label}${C.reset}`, cellW));
  lines.push(centerPad(`${stColor}${label}${C.reset}`, cellW));
  lines.push(centerPad(`${C.dim}${member.role}${C.reset}`, cellW));
  return lines;
}

function blankBlock(cellW, height) {
  return Array.from({ length: height }, () => " ".repeat(cellW));
}

function joinBlocks(blocks, gap = 2) {
  const gapS = " ".repeat(gap);
  const widths = blocks.map((b) => Math.max(...b.map((l) => visLen(l)), 12));
  const maxH = Math.max(...blocks.map((b) => b.length), 0);
  const out = [];
  for (let i = 0; i < maxH; i++) {
    out.push(
      blocks
        .map((b, j) => {
          const line = b[i] || "";
          return line ? centerPadVis(line, widths[j]) : " ".repeat(widths[j]);
        })
        .join(gapS),
    );
  }
  return out;
}

function renderGrid(members, cols, gridCols = GRID_COLS, gridRows = GRID_ROWS, statusState) {
  const gap = 2;
  const colsN = gridCols;
  const cellW = Math.max(12, Math.floor((cols - gap * (colsN - 1)) / colsN));
  const rows = [];
  const slice = members.slice(0, gridCols * gridRows);

  for (let r = 0; r < gridRows; r++) {
    const rowMembers = slice.slice(r * colsN, r * colsN + colsN);
    if (!rowMembers.length) break;
    const blocks = rowMembers.map((m) => cellBlock(m, cellW, statusState));
    const blockH = blocks[0]?.length || 1;
    while (blocks.length < colsN) blocks.push(blankBlock(cellW, blockH));
    rows.push(...joinBlocks(blocks, gap));
    if (r < gridRows - 1 && slice.length > (r + 1) * colsN) {
      for (let g = 0; g < ROW_GAP; g++) rows.push("");
    }
  }
  return rows;
}

function renderPager(cur, pages, cols) {
  const dim = downgradeAnsi("\x1b[38;5;240m", _tui.color);
  const lit = downgradeAnsi("\x1b[38;5;213m", _tui.color);
  const num = downgradeAnsi("\x1b[38;5;245m", _tui.color);
  const prevS = cur <= 0 ? `${dim}[ ◀ prev ]${C.reset}` : `${lit}[ ◀ prev ]${C.reset}`;
  const nextS = cur >= pages - 1 ? `${dim}[ next ▶ ]${C.reset}` : `${lit}[ next ▶ ]${C.reset}`;
  const midS = `${num}${cur + 1} / ${pages}${C.reset}`;
  const visPlain = `[ ◀ prev ]     ${cur + 1} / ${pages}     [ next ▶ ]`;
  const pad = Math.max(0, Math.floor((cols - visPlain.length) / 2));
  return `${" ".repeat(pad)}${prevS}     ${midS}     ${nextS}`;
}

export function renderMeetRoom({ cols = 80, rows = 40, page = loadPage(), includeHint = true } = {}) {
  const meeting = loadCurrentMeeting();
  if (!meeting) {
    return finalizeMeetFrame(
      [
        `${C.dim}No open room — gotchibot meet open${C.reset}`,
        "",
        "Start from cockpit or: ./scripts/gotchi-meet.mjs start",
        "",
      ].join("\n"),
    );
  }

  const members = listMeetMembers(meeting);
  const pages = pageCount(members);
  const cur = clampPage(page, members);
  const slice = members.slice(cur * PER_PAGE, cur * PER_PAGE + PER_PAGE);
  const statusState = loadMeetStatus();

  const lines = [];
  lines.push(`${C.topic}# ${meeting.topic || "Untitled meeting"}${C.reset}`);
  lines.push(
    `${C.dim}${members.length} in room · ${GRID_COLS}×${GRID_ROWS} grid · ←→ page · /cockpit · /chat leave UI · /end record${C.reset}`,
  );
  lines.push(`${C.bar}${"─".repeat(Math.min(cols - 2, 58))}${C.reset}`);
  lines.push("");

  const grid = renderGrid(slice, cols, GRID_COLS, GRID_ROWS, statusState);
  lines.push(...grid);

  lines.push("");
  lines.push(renderPager(cur, pages, cols));
  if (includeHint) {
    lines.push("");
    lines.push(
      `${C.hint}← → /prev /next · @LINK · @everyone · pardon me, … · /continue — # meet →${C.reset}`,
    );
  }

  const maxLines = Math.max(10, rows - 2);
  if (lines.length > maxLines) {
    // Keep topic/header + as much grid as fits + always keep the pager.
    // (Old slice(-maxLines) dropped the top of the grid and made next/prev look broken.)
    const pagerIdx = lines.findLastIndex(
      (l) => /prev/.test(stripAnsi(l)) && /next/.test(stripAnsi(l)),
    );
    const pagerLine = pagerIdx >= 0 ? lines[pagerIdx] : null;
    const budget = Math.max(1, maxLines - (pagerLine ? 1 : 0));
    const prefix = lines
      .filter((_, i) => i !== pagerIdx)
      .slice(0, budget);
    if (pagerLine) prefix.push(pagerLine);
    return finalizeMeetFrame(prefix.join("\n"));
  }
  return finalizeMeetFrame(lines.join("\n"));
}

function finalizeMeetFrame(frame) {
  return _tui.glyphs === "ascii" ? toAsciiGlyphs(frame) : frame;
}


if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--members")) {
    const json = args.includes("--json");
    const data = listMeetMembers();
    if (json) console.log(JSON.stringify(data, null, 2));
    else for (const m of data) console.log(`${m.id}\t${m.label}\t${m.role}`);
    process.exit(0);
  }
  const cols = Number(args[args.indexOf("--cols") + 1]) || 80;
  const rowN = Number(args[args.indexOf("--rows") + 1]) || 40;
  let page = loadPage();
  if (args.includes("--page")) page = Number(args[args.indexOf("--page") + 1]) || 0;
  process.stdout.write(renderMeetRoom({ cols, rows: rowN, page }));
}
