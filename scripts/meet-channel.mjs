#!/usr/bin/env node
/**
 * iMessage-style meet channel renderer (thumbnail gotchi avatars).
 *
 *   node scripts/meet-channel.mjs --render [--cols N] [--rows N] [--scroll N]
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MEETINGS = `${ROOT}/sessions/meetings`;
const PENDING = `${ROOT}/sessions/.meet-pending.json`;
const THUMB_FALLBACK = `${ROOT}/assets/gotchi-thumb.ascii`;
const THUMB_W = 14;
const SCROLLBAR_COLS = 2;

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[38;5;245m",
  user: "\x1b[38;5;117m",
  chair: "\x1b[38;5;213m",
  agent: "\x1b[38;5;51m",
  topic: "\x1b[38;5;184m",
  bar: "\x1b[38;5;240m",
  body: "\x1b[38;5;252m",
};

const SCROLL_TRACK = `${C.bar}│${C.reset}`;
const SCROLL_THUMB = `${C.chair}█${C.reset}`;

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

export function loadCurrentMeeting() {
  if (!existsSync(`${MEETINGS}/.current`)) return null;
  const id = String(readFileSync(`${MEETINGS}/.current`, "utf8")).trim();
  if (!id) return null;
  const m = readJson(`${MEETINGS}/${id}/meeting.json`, null);
  if (!m || m.status !== "open") return null;
  return m;
}

export function readTranscript(id) {
  const path = `${MEETINGS}/${id}/transcript.jsonl`;
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

export function participantInfo(meeting, speakerId) {
  const p = (meeting?.participants || []).find((x) => x.id === speakerId);
  const role = p?.role || "agent";
  let name = p?.name || speakerId;
  if (name === speakerId && speakerId.startsWith("starter-")) {
    const m = speakerId.match(/starter-([a-z0-9]+)-/i);
    if (m) name = m[1].toUpperCase();
  }
  if (name === speakerId && speakerId.startsWith("owned-")) {
    name = role === "chair" ? "Gotchi" : speakerId;
  }
  return { name, role, id: speakerId };
}

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

function nameColor(role) {
  if (role === "user") return C.user;
  if (role === "chair") return C.chair;
  return C.agent;
}

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

function getThumb(heroId) {
  if (!heroId || heroId === "userdefault") {
    try {
      return readFileSync(THUMB_FALLBACK, "utf8").trimEnd().split("\n");
    } catch {
      return ["  ▄▄▄▄▄▄"];
    }
  }
  if (!thumbCache.has(heroId)) thumbCache.set(heroId, thumbForHero(heroId));
  return thumbCache.get(heroId);
}

function renderHeader(meeting, cols) {
  const topic = meeting.topic || "Untitled meeting";
  const agents = (meeting.participants || []).filter((p) => p.role !== "user").length;
  return [
    `${C.topic}# ${topic}${C.reset}`,
    `${C.dim}${agents} gotchi${agents === 1 ? "" : "s"} · ↑↓ wheel · scrollbar${C.reset}`,
    `${C.bar}${"─".repeat(Math.max(8, Math.min(cols - 2, 56)))}${C.reset}`,
  ];
}

function loadPending() {
  try {
    return JSON.parse(readFileSync(PENDING, "utf8"));
  } catch {
    return null;
  }
}

function pendingDots(startedAt) {
  const t = startedAt ? new Date(startedAt).getTime() : Date.now();
  return ".".repeat((Math.floor((Date.now() - t) / 400) % 3) + 1);
}

function renderPendingTail(meeting, cols, turns) {
  const pending = loadPending();
  if (!pending?.text) return [];
  const userId =
    meeting.participants?.find((p) => p.role === "user")?.id || "userdefault";
  const dots = pendingDots(pending.startedAt);
  const inTranscript = turns.some(
    (t) => t.role === "user" && t.speaker === userId && t.text === pending.text,
  );
  const lines = [];
  if (!inTranscript) {
    lines.push(
      ...renderTurn(
        { speaker: userId, role: "user", text: pending.text, ts: pending.startedAt },
        meeting,
        cols,
      ),
    );
    lines.push(`${C.dim}  sending${dots}${C.reset}`, "");
  } else {
    lines.push(`${C.dim}  ${C.chair}Gotchi${C.reset}${C.dim} is typing${dots}${C.reset}`, "");
  }
  return lines;
}

function renderTurn(turn, meeting, cols) {
  const { name, role, id } = participantInfo(meeting, turn.speaker);
  const thumb = getThumb(id);
  const bodyW = Math.max(16, cols - THUMB_W - 2);
  const bodyLines = wrapLines(turn.text, bodyW);
  const header = `${nameColor(role)}${name}${C.reset} ${C.dim}${formatTime(turn.ts)}${C.reset}`;
  const blockH = Math.max(thumb.length, 1 + bodyLines.length);
  const rows = [];

  for (let i = 0; i < blockH; i++) {
    const thumbPart = padVis(thumb[i] || "", THUMB_W);
    if (i === 0) {
      rows.push(`${thumbPart} ${header}`);
      continue;
    }
    const text = bodyLines[i - 1];
    if (text) {
      rows.push(`${thumbPart} ${C.body}${text}${C.reset}`);
    } else if (stripAnsi(thumb[i] || "").trim()) {
      rows.push(thumbPart);
    }
  }
  rows.push("");
  return rows;
}

/** Full channel lines (header + messages). */
export function buildMeetChannelLines(meeting, cols, contentCols = cols) {
  const lines = [...renderHeader(meeting, contentCols)];
  const turns = readTranscript(meeting.id);
  if (!turns.length) {
    lines.push(`${C.dim}(channel empty — type in Meet · room prompt)${C.reset}`, "");
  } else {
    for (const t of turns) lines.push(...renderTurn(t, meeting, contentCols));
  }
  lines.push(...renderPendingTail(meeting, cols, turns));
  return lines;
}

function buildScrollbar(total, viewport, fromBottom, barHeight) {
  const maxScroll = Math.max(0, total - viewport);
  const visStart = maxScroll > 0 ? Math.max(0, total - fromBottom - viewport) : 0;
  const thumbH = Math.max(1, Math.round((viewport / Math.max(total, 1)) * barHeight));
  const travel = Math.max(0, barHeight - thumbH);
  const thumbTop = maxScroll > 0 ? Math.round((visStart / maxScroll) * travel) : 0;
  const out = [];
  for (let i = 0; i < barHeight; i++) {
    out.push(i >= thumbTop && i < thumbTop + thumbH ? SCROLL_THUMB : SCROLL_TRACK);
  }
  return out;
}

function attachScrollbar(contentLines, barLines, cols) {
  const contentW = cols - SCROLLBAR_COLS;
  const h = Math.max(contentLines.length, barLines.length);
  const out = [];
  for (let i = 0; i < h; i++) {
    out.push(`${padVis(contentLines[i] || "", contentW)}${barLines[i] || SCROLL_TRACK}`);
  }
  return out.join("\n");
}

export function maxScrollFromBottom({ cols = 80, rows = 40, meeting = loadCurrentMeeting() } = {}) {
  if (!meeting) return 0;
  const contentCols = Math.max(24, cols - SCROLLBAR_COLS);
  const total = buildMeetChannelLines(meeting, cols, contentCols).length;
  return Math.max(0, total - Math.max(8, rows));
}

export function renderMeetChannel({ cols = 80, rows = 40, scrollFromBottom = 0 } = {}) {
  const meeting = loadCurrentMeeting();
  if (!meeting) {
    return [
      `${C.dim}No open meeting${C.reset}`,
      "",
      "Open meet menu or:",
      '  /meet start "topic"',
      "",
    ].join("\n");
  }

  const contentCols = Math.max(24, cols - SCROLLBAR_COLS);
  const allLines = buildMeetChannelLines(meeting, cols, contentCols);
  const total = allLines.length;
  const viewport = Math.max(8, rows);
  const fromBottom = Math.max(
    0,
    Math.min(
      Math.max(0, total - viewport),
      Math.max(0, Number(scrollFromBottom) || 0),
    ),
  );
  const bar = buildScrollbar(total, viewport, fromBottom, rows);

  if (total <= viewport) {
    return attachScrollbar(allLines, bar, cols);
  }

  const maxScroll = total - viewport;
  const end = total - fromBottom;
  const start = Math.max(0, end - viewport);
  const visible = allLines.slice(start, end);

  if (start > 0) {
    visible.unshift(`${C.dim}↑ older${C.reset}`);
  }
  if (fromBottom > 0) {
    visible.push(`${C.dim}↓ newer · End latest${C.reset}`);
  }

  while (visible.length < rows) visible.push("");
  if (visible.length > rows) visible.length = rows;

  return attachScrollbar(visible, bar, cols);
}

/** Slack-style turn output for OpenCode stdout (no thumbs — channel pane has those). */
export function printSlackTurns(meeting, turns, { pick } = {}) {
  if (!turns?.length) return;
  for (const t of turns) {
    const { name, role } = participantInfo(meeting, t.speaker);
    console.log("");
    console.log(`${nameColor(role)}${name}${C.reset} ${C.dim}${formatTime(t.ts)}${C.reset}`);
    for (const line of wrapLines(t.text, 72)) {
      console.log(`${C.body}  ${line}${C.reset}`);
    }
  }
  if (pick?.fallback) {
    console.log(`${C.dim}(chair fallback: ${pick.note || "—"})${C.reset}`);
  }
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = process.argv.slice(2);
  const cols = Number(args[args.indexOf("--cols") + 1]) || 80;
  const rows = Number(args[args.indexOf("--rows") + 1]) || 40;
  let scroll = 0;
  if (args.includes("--scroll")) scroll = Number(args[args.indexOf("--scroll") + 1]) || 0;
  process.stdout.write(renderMeetChannel({ cols, rows, scrollFromBottom: scroll }));
}
