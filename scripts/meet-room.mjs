#!/usr/bin/env node
/**
 * Meet room — Zoom-style participant carousel + helpers.
 *
 *   node scripts/meet-room.mjs --render [--cols N] [--rows N] [--page N]
 *   node scripts/meet-room.mjs --members [--json]
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCurrentMeeting, participantInfo } from "./meet-channel.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE_FILE = `${ROOT}/sessions/.meet-room-page`;
const THUMB_FALLBACK = `${ROOT}/assets/gotchi-thumb.ascii`;
const GRID_COLS = Math.max(1, Number(process.env.GOTCHIBOT_MEET_ROOM_COLS || 3) || 3);
const GRID_ROWS = Math.max(1, Number(process.env.GOTCHIBOT_MEET_ROOM_ROWS || 2) || 2);
const PER_PAGE = Math.max(1, Number(process.env.GOTCHIBOT_MEET_ROOM_PER_PAGE || GRID_COLS * GRID_ROWS) || GRID_COLS * GRID_ROWS);

const C = {
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
};

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

const thumbCache = new Map();

function thumbForHero(heroId) {
  const r = spawnSync(process.execPath, [`${ROOT}/scripts/gotchi-art.mjs`, "--thumb", "--hero", heroId, "--color"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 8000,
  });
  let art = (r.stdout || "").trimEnd();
  if (!art) {
    try {
      art = readFileSync(THUMB_FALLBACK, "utf8").trimEnd();
    } catch {
      art = "  ▄▄▄▄▄▄";
    }
  }
  return art.split("\n");
}

function getThumb(id) {
  if (!id || id === "userdefault") {
    try {
      return readFileSync(THUMB_FALLBACK, "utf8").trimEnd().split("\n");
    } catch {
      return ["  ▄▄▄▄▄▄"];
    }
  }
  if (!thumbCache.has(id)) thumbCache.set(id, thumbForHero(id));
  return thumbCache.get(id);
}

export function listMeetMembers(meeting = loadCurrentMeeting()) {
  if (!meeting) return [];
  return (meeting.participants || []).map((p) => {
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

function cellBlock(member, cellW) {
  const thumb = getThumb(member.id);
  const roleColor = nameColor(member.role);
  const lines = [];
  for (let i = 0; i < thumb.length; i++) {
    lines.push(centerPadVis(thumb[i] || "", cellW));
  }
  lines.push(centerPad(`${roleColor}${member.label}${C.reset}`, cellW));
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

function renderGrid(members, cols, gridCols = GRID_COLS, gridRows = GRID_ROWS) {
  const gap = 2;
  const colsN = gridCols;
  const cellW = Math.max(12, Math.floor((cols - gap * (colsN - 1)) / colsN));
  const rows = [];
  const slice = members.slice(0, gridCols * gridRows);

  for (let r = 0; r < gridRows; r++) {
    const rowMembers = slice.slice(r * colsN, r * colsN + colsN);
    if (!rowMembers.length) break;
    const blocks = rowMembers.map((m) => cellBlock(m, cellW));
    const blockH = blocks[0]?.length || 1;
    while (blocks.length < colsN) blocks.push(blankBlock(cellW, blockH));
    rows.push(...joinBlocks(blocks, gap));
    if (r < gridRows - 1 && slice.length > (r + 1) * colsN) rows.push("");
  }
  return rows;
}

function renderPager(cur, pages, cols) {
  const dim = "\x1b[38;5;240m";
  const lit = "\x1b[38;5;213m";
  const num = "\x1b[38;5;245m";
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
    return [
      `${C.dim}No open meeting${C.reset}`,
      "",
      "Start from cockpit or: ./scripts/gotchi-meet.mjs start",
      "",
    ].join("\n");
  }

  const members = listMeetMembers(meeting);
  const pages = pageCount(members);
  const cur = clampPage(page, members);
  const slice = members.slice(cur * PER_PAGE, cur * PER_PAGE + PER_PAGE);

  const lines = [];
  lines.push(`${C.topic}# ${meeting.topic || "Untitled meeting"}${C.reset}`);
  lines.push(
    `${C.dim}${members.length} in room · ${GRID_COLS}×${GRID_ROWS} grid · /end leave${C.reset}`,
  );
  lines.push(`${C.bar}${"─".repeat(Math.min(cols - 2, 58))}${C.reset}`);
  lines.push("");

  const grid = renderGrid(slice, cols);
  lines.push(...grid);

  lines.push("");
  lines.push(renderPager(cur, pages, cols));
  if (includeHint) {
    lines.push("");
    lines.push(`${C.hint}Message the room (@LINK …) — transcript in # meet →${C.reset}`);
  }

  const maxLines = Math.max(10, rows - 2);
  if (lines.length > maxLines) {
    return lines.slice(-maxLines).join("\n");
  }
  return lines.join("\n");
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
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
