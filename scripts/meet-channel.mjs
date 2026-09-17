#!/usr/bin/env node
/**
 * iMessage-style meet channel renderer (thumbnail gotchi avatars).
 *
 *   node scripts/meet-channel.mjs --render [--cols N] [--rows N] [--scroll N]
 */
import { spawn, spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  watch,
  statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stdin as input, stdout as output } from "node:process";
import { isMainModule } from "./is-main.mjs";
import { resolveMeetingsRoot } from "./project-context.mjs";
import { isProfLinkCubeId } from "./gotchi-art.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PENDING = `${ROOT}/sessions/.meet-pending.json`;
const SCROLL_FILE = `${ROOT}/sessions/.meet-channel-scroll`;
const STAMP = `${ROOT}/sessions/.meet-channel.stamp`;
const THUMB_FALLBACK = `${ROOT}/assets/gotchi-thumb.ascii`;
const THUMB_CACHE_DIR = `${ROOT}/sessions/.meet-thumbs`;
const THUMB_W = 14;
const SCROLLBAR_COLS = 2;
const SCROLL_STEP = Math.max(1, Number(process.env.GOTCHIBOT_MEET_CHANNEL_SCROLL_STEP || 3) || 3);
const COPY_LABEL = "[copy]";
const COPIED_LABEL = "[copied]";
const COPY_FAILED_LABEL = "[copy failed]";
const EDIT_LABEL = "[edit]";
/** How long the copied/failed flash stays on the button. */
const COPY_FLASH_MS = 1400;
const EDIT_REQUEST = `${ROOT}/sessions/.meet-edit-request.json`;

function meetingsRoot() {
  return resolveMeetingsRoot().root;
}


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
  const root = meetingsRoot();
  if (!existsSync(`${root}/.current`)) return null;
  const id = String(readFileSync(`${root}/.current`, "utf8")).trim();
  if (!id) return null;
  const m = readJson(`${root}/${id}/meeting.json`, null);
  if (!m || m.status !== "open") return null;
  return m;
}

export function readTranscript(id) {
  const path = `${meetingsRoot()}/${id}/transcript.jsonl`;
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
  if (isProfLinkCubeId(speakerId)) name = "Prof. Link-Cube";
  return { name, role, id: speakerId };
}

/**
 * Visual / speaking seat order: user → chair (orch) → Prof. Link-Cube → rest.
 * Keeps Prof glued beside the orchestrator in the Zoom carousel.
 */
export function orderMeetingParticipants(participants, chairId = null) {
  const list = [...(participants || [])];
  if (!list.length) return list;
  const chair =
    list.find((p) => p.role === "chair") ||
    (chairId ? list.find((p) => p.id === chairId) : null);
  const user = list.find((p) => p.role === "user");
  const prof = list.find((p) => isProfLinkCubeId(p.id));
  const rest = list.filter(
    (p) =>
      p !== user &&
      p !== chair &&
      p !== prof &&
      !isProfLinkCubeId(p.id),
  );
  const out = [];
  if (user) out.push(user);
  if (chair) out.push(chair);
  if (prof && prof !== chair) out.push(prof);
  out.push(...rest);
  return out;
}

/** Insert participant immediately after the chair (or after user if no chair). */
export function insertBesideChair(participants, participant, chairId = null) {
  const without = (participants || []).filter((p) => p.id !== participant.id);
  const ordered = orderMeetingParticipants(without, chairId);
  const chairIdx = ordered.findIndex(
    (p) => p.role === "chair" || (chairId && p.id === chairId),
  );
  if (chairIdx >= 0) {
    ordered.splice(chairIdx + 1, 0, participant);
    return ordered;
  }
  const userIdx = ordered.findIndex((p) => p.role === "user");
  if (userIdx >= 0) {
    ordered.splice(userIdx + 1, 0, participant);
    return ordered;
  }
  return [participant, ...ordered];
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

function thumbDiskPath(heroId) {
  return `${THUMB_CACHE_DIR}/${String(heroId).replace(/[^\w.-]+/g, "_")}.ansi`;
}

function plainLen(s) {
  return String(s || "").replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Keep every thumb row the same width — trailing spaces on the last row matter for diamond tips. */
function normalizeThumbLines(art) {
  const lines = String(art || "")
    .replace(/\n+$/, "")
    .split("\n");
  const width = Math.max(12, ...lines.map((l) => plainLen(l)));
  return lines.map((l) => {
    const pad = width - plainLen(l);
    return pad > 0 ? `${l}${" ".repeat(pad)}` : l;
  });
}

function thumbForHero(heroId) {
  mkdirSync(THUMB_CACHE_DIR, { recursive: true });
  const disk = thumbDiskPath(heroId);
  try {
    if (existsSync(disk)) {
      const art = readFileSync(disk, "utf8");
      if (art.trim()) return normalizeThumbLines(art);
    }
  } catch {
    /* regenerate */
  }
  const r = spawnSync(process.execPath, [`${ROOT}/scripts/gotchi-art.mjs`, "--thumb", "--hero", heroId, "--color"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 8000,
  });
  let art = r.stdout || "";
  if (!art.trim()) {
    try {
      art = readFileSync(THUMB_FALLBACK, "utf8");
    } catch {
      art = "  ▄▄▄▄▄▄";
    }
  }
  const lines = normalizeThumbLines(art);
  try {
    writeFileSync(disk, `${lines.join("\n")}\n`);
  } catch {
    /* ok */
  }
  return lines;
}

/** Thumb lines for a hero: in-process map → sessions/.meet-thumbs → gotchi-art. */
export function getThumb(heroId) {
  if (!heroId || heroId === "userdefault") {
    try {
      return normalizeThumbLines(readFileSync(THUMB_FALLBACK, "utf8"));
    } catch {
      return ["  ▄▄▄▄▄▄"];
    }
  }
  if (!thumbCache.has(heroId)) thumbCache.set(heroId, thumbForHero(heroId));
  return thumbCache.get(heroId);
}

/**
 * Fill the on-disk thumb cache for heroes that miss it, one async child at a
 * time, so the first visit to a room page never blocks on gotchi-art spawns.
 */
export function warmThumbs(ids, done) {
  const queue = [...new Set((ids || []).filter((id) => id && id !== "userdefault"))];
  const next = () => {
    const id = queue.shift();
    if (!id) return done?.();
    const disk = thumbDiskPath(id);
    if (thumbCache.has(id) || existsSync(disk)) return next();
    let child;
    try {
      child = spawn(process.execPath, [`${ROOT}/scripts/gotchi-art.mjs`, "--thumb", "--hero", id, "--color"], {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return next();
    }
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.on("error", () => next());
    child.on("close", () => {
      const lines = normalizeThumbLines(out);
      if (lines.some((l) => plainLen(l) > 0)) {
        try {
          mkdirSync(THUMB_CACHE_DIR, { recursive: true });
          writeFileSync(disk, `${lines.join("\n")}\n`);
          thumbCache.set(id, lines);
        } catch {
          /* ok */
        }
      }
      next();
    });
  };
  next();
}

function renderHeader(meeting, cols, interactive = false) {
  const topic = meeting.topic || "Untitled meeting";
  const agents = (meeting.participants || []).filter((p) => p.role !== "user").length;
  const clickHint = interactive ? " · click [copy] · [edit]" : "";
  return [
    `${C.topic}# ${topic}${C.reset}`,
    `${C.dim}${agents} gotchi${agents === 1 ? "" : "s"} · ↑↓ wheel · j/k · PgUp/Dn · scrollbar${clickHint}${C.reset}`,
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

/**
 * Append a clickable copy/edit affordance to a turn header and record its hitbox.
 * `hit` is { hits, line, key, action, copied } handed down by buildMeetChannelLines;
 * columns are 0-based and visible (ANSI stripped), matching the painted frame.
 */
function withActionButton(meta, turn, cols, hit) {
  const isEdit = hit.action === "edit";
  const label = isEdit
    ? EDIT_LABEL
    : hit.copied === "ok"
      ? COPIED_LABEL
      : hit.copied === "fail"
        ? COPY_FAILED_LABEL
        : COPY_LABEL;
  const colStart = THUMB_W + 1 + visLen(meta) + 1;
  if (colStart + label.length > cols) return meta;
  hit.hits.push({
    line: hit.line,
    colStart,
    colEnd: colStart + label.length - 1,
    key: hit.key,
    text: turn.text,
    ts: turn.ts,
    action: isEdit ? "edit" : "copy",
  });
  const color = hit.copied === "ok" ? C.chair : hit.copied === "fail" ? C.topic : C.dim;
  return `${meta} ${color}${label}${C.reset}`;
}

function renderTurn(turn, meeting, cols, hit = null) {
  const { name, role, id } = participantInfo(meeting, turn.speaker);
  const thumb = getThumb(id);
  const bodyW = Math.max(16, cols - THUMB_W - 2);
  const bodyLines = wrapLines(turn.text, bodyW);
  // Quiet "edited" cue on the user's own corrected messages — not a badge card.
  const edited = turn.editedAt && role === "user" ? ` ${C.dim}(edited)${C.reset}` : "";
  const meta = `${nameColor(role)}${name}${C.reset} ${C.dim}${formatTime(turn.ts)}${C.reset}${edited}`;
  const header = hit ? withActionButton(meta, turn, cols, hit) : meta;
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
  rows.push("");
  rows.push(""); // air between iMessage turns — thumbs otherwise kiss
  return rows;
}

/**
 * Full channel lines (header + messages).
 * Pass `opts.hits` (an array) to draw clickable [copy] buttons on responses and
 * collect their hitboxes; `opts.copiedKey`/`opts.copiedState` flash one button.
 */
export function buildMeetChannelLines(meeting, cols, contentCols = cols, opts = {}) {
  const hits = opts.hits || null;
  const lines = [...renderHeader(meeting, contentCols, Boolean(hits))];
  const turns = readTranscript(meeting.id);
  if (!turns.length) {
    lines.push(`${C.dim}(channel empty — type in Meet · room prompt)${C.reset}`, "");
  } else {
    turns.forEach((t, i) => {
      const role = t.role || participantInfo(meeting, t.speaker).role;
      const key = `${i}:${t.ts || ""}`;
      let hit = null;
      if (hits) {
        if (role === "user") {
          hit = { hits, line: lines.length, key, action: "edit", copied: null };
        } else {
          hit = {
            hits,
            line: lines.length,
            key,
            action: "copy",
            copied: opts.copiedKey === key ? opts.copiedState || "ok" : null,
          };
        }
      }
      lines.push(...renderTurn(t, meeting, contentCols, hit));
    });
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

function mtime(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function loadScroll() {
  try {
    const n = Number(String(readFileSync(SCROLL_FILE, "utf8")).trim());
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function saveScroll(n) {
  mkdirSync(`${ROOT}/sessions`, { recursive: true });
  writeFileSync(SCROLL_FILE, `${Math.max(0, Math.floor(n))}\n`);
}

function paneSize() {
  return {
    cols: output.columns || Number(process.env.COLUMNS) || 52,
    rows: output.rows || Number(process.env.LINES) || 30,
  };
}

function paintFrame(frame) {
  // In-place redraw (home + clear-EOL per line) — avoids full \x1b[J flash on wheel.
  // No newline after the last row: a full-height frame would scroll the pane by
  // one line, eating the top row and shifting every click one row off.
  const lines = String(frame).replace(/\n$/, "").split("\n");
  let out = "\x1b[H";
  lines.forEach((line, i) => {
    out += `${line}\x1b[K`;
    if (i < lines.length - 1) out += "\n";
  });
  out += "\x1b[J";
  output.write(out);
}

/** OSC 52 copy through the terminal (tmux needs passthrough wrapping). */
function writeOsc52(text) {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  if (b64.length > 100_000) return false;
  const seq = `\x1b]52;c;${b64}\x07`;
  try {
    output.write(process.env.TMUX ? `\x1bPtmux;${seq.replace(/\x1b/g, "\x1b\x1b")}\x1b\\` : seq);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy a turn to the clipboard. clipboard-copy.mjs runs with its stdout piped
 * so its own OSC 52 never lands in our alt screen; OSC 52 is the fallback.
 */
function copyTurnText(text) {
  const r = spawnSync(process.execPath, [`${ROOT}/scripts/clipboard-copy.mjs`], {
    input: text,
    encoding: "utf8",
    timeout: 5000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (r.status === 0) return true;
  return writeOsc52(text);
}

/**
 * Long-lived # meet pane: rebuild transcript only when content changes;
 * scroll only re-slices cached lines (smooth wheel).
 */
export async function runMeetChannelLive() {
  mkdirSync(`${ROOT}/sessions`, { recursive: true });
  output.write("\x1b[?1049h\x1b[?7l\x1b[?25l");
  // Button events only — no 1002 motion flood.
  output.write("\x1b[?1000h\x1b[?1006h");

  let cachedLines = null;
  let cacheKey = "";
  let paintTimer = null;
  let pendingAnim = false;
  let scroll = loadScroll();
  let destroyed = false;
  let forceNext = false;
  /** Copy-button hitboxes for the cached lines, and the current frame's slice. */
  let hits = [];
  let view = { start: 0, hasOlder: false };
  let copied = { key: null, state: null };
  let copyFlashTimer = null;

  const teardown = () => {
    if (destroyed) return;
    destroyed = true;
    if (paintTimer) clearTimeout(paintTimer);
    try {
      output.write("\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?7h\x1b[?1049l");
    } catch {
      /* ok */
    }
    process.exit(0);
  };
  process.on("SIGINT", teardown);
  process.on("SIGTERM", teardown);
  process.on("SIGUSR1", () => schedulePaint(true));

  function contentKey(cols) {
    const meeting = loadCurrentMeeting();
    const id = meeting?.id || "";
    const root = meetingsRoot();
    const tr = id ? `${root}/${id}/transcript.jsonl` : "";
    return [
      cols,
      id,
      mtime(tr),
      mtime(id ? `${root}/${id}/meeting.json` : ""),
      mtime(PENDING),
      mtime(`${root}/.current`),
    ].join("|");
  }

  function ensureLines(cols, rows, force) {
    const key = contentKey(cols);
    const hasPending = existsSync(PENDING);
    // Pending dots need light refresh without nuking thumb cache.
    if (!force && cachedLines && key === cacheKey && !hasPending) return cachedLines;
    if (!force && cachedLines && key === cacheKey && hasPending) {
      // Only rebuild pending tail: reuse base without pending by detecting…
      // Simpler: full rebuild is cheap once thumbs are cached in-process.
    }
    const meeting = loadCurrentMeeting();
    if (!meeting) {
      cachedLines = [
        `${C.dim}No open meeting${C.reset}`,
        "",
        "Open meet menu or:",
        '  /meet start "topic"',
        "",
      ];
      cacheKey = key;
      pendingAnim = false;
      hits = [];
      return cachedLines;
    }
    const contentCols = Math.max(24, cols - SCROLLBAR_COLS);
    const nextHits = [];
    cachedLines = buildMeetChannelLines(meeting, cols, contentCols, {
      hits: nextHits,
      copiedKey: copied.key,
      copiedState: copied.state,
    });
    hits = nextHits;
    cacheKey = key;
    pendingAnim = hasPending;
    return cachedLines;
  }

  function frameFor(scrollFromBottom) {
    const { cols, rows } = paneSize();
    const allLines = ensureLines(cols, rows, false);
    const total = allLines.length;
    const viewport = Math.max(8, rows);
    const maxScroll = Math.max(0, total - viewport);
    const fromBottom = Math.max(0, Math.min(maxScroll, scrollFromBottom));
    const bar = buildScrollbar(total, viewport, fromBottom, rows);
    if (total <= viewport) {
      view = { start: 0, hasOlder: false };
      return attachScrollbar(allLines, bar, cols);
    }
    const end = total - fromBottom;
    const start = Math.max(0, end - viewport);
    const visible = allLines.slice(start, end);
    view = { start, hasOlder: start > 0 };
    if (start > 0) visible.unshift(`${C.dim}↑ older${C.reset}`);
    if (fromBottom > 0) visible.push(`${C.dim}↓ newer · End latest${C.reset}`);
    while (visible.length < rows) visible.push("");
    if (visible.length > rows) visible.length = rows;
    return attachScrollbar(visible, bar, cols);
  }

  function paint(forceContent) {
    if (destroyed) return;
    const { cols, rows } = paneSize();
    if (forceContent) cacheKey = "";
    scroll = loadScroll();
    const max = Math.max(0, ensureLines(cols, rows, forceContent).length - Math.max(8, rows));
    if (scroll > max) {
      scroll = max;
      saveScroll(scroll);
    }
    paintFrame(frameFor(scroll));
  }

  function schedulePaint(forceContent = false, delayMs = 32) {
    if (forceContent) forceNext = true;
    // Throttle, not debounce: a trackpad wheel burst arrives faster than the
    // old 16–24ms reset, so the paint kept sliding until the finger stopped.
    if (paintTimer) return;
    paintTimer = setTimeout(() => {
      paintTimer = null;
      const force = forceNext;
      forceNext = false;
      paint(force);
    }, delayMs);
  }

  function adjustScroll(delta) {
    setScrollAbs(scroll + delta);
  }

  function setScrollAbs(n) {
    const { cols, rows } = paneSize();
    const max = Math.max(0, ensureLines(cols, rows, false).length - Math.max(8, rows));
    const next = Math.max(0, Math.min(max, n));
    if (next === scroll) return;
    scroll = next;
    // One write per input chunk; the watcher below ignores our own value.
    saveScroll(scroll);
    // Scroll-only: no content rebuild — just re-slice.
    schedulePaint(false, 16);
  }

  /** Left click: [copy] agent replies, [edit] your own user turns. */
  function handleClick(col, row) {
    const line = view.start + (row - 1) - (view.hasOlder ? 1 : 0);
    const x = col - 1;
    const hit = hits.find((h) => h.line === line && x >= h.colStart && x <= h.colEnd);
    if (!hit) return;
    if (hit.action === "edit") {
      try {
        writeFileSync(
          EDIT_REQUEST,
          `${JSON.stringify({
            ts: hit.ts,
            text: hit.text,
            requestedAt: new Date().toISOString(),
          })}\n`,
        );
        spawnSync("bash", [`${ROOT}/scripts/poke-meet-room.sh`], { stdio: "ignore" });
      } catch {
        /* ok */
      }
      return;
    }
    copied = { key: hit.key, state: copyTurnText(hit.text) ? "ok" : "fail" };
    if (copyFlashTimer) clearTimeout(copyFlashTimer);
    copyFlashTimer = setTimeout(() => {
      copyFlashTimer = null;
      copied = { key: null, state: null };
      schedulePaint(true, 0);
    }, COPY_FLASH_MS);
    schedulePaint(true, 0);
  }

  // Watch scroll + stamp + pending — quiet scroll.sh only touches scroll file.
  const watchTargets = [
    `${ROOT}/sessions`,
    meetingsRoot(),
  ];
  for (const dir of watchTargets) {
    try {
      watch(dir, { persistent: true }, (evt, fname) => {
        const f = String(fname || "");
        if (f.includes("meet-channel-scroll")) {
          // Our own saveScroll fires this too — only external writers matter.
          if (loadScroll() !== scroll) schedulePaint(false, 16);
          return;
        }
        if (f.includes("meet-channel.stamp")) {
          // Stamp = "look again"; contentKey decides whether lines rebuild.
          schedulePaint(false, 24);
          return;
        }
        if (
          f.includes("meet-pending") ||
          f.includes(".current") ||
          f.includes("transcript") ||
          f.includes("meeting.json")
        ) {
          schedulePaint(true, 40);
        }
      });
    } catch {
      /* poll fallback below */
    }
  }

  // Fallback poll (fs.watch can miss some platforms) — slow, content only.
  setInterval(() => {
    const { cols } = paneSize();
    const key = contentKey(cols);
    if (key !== cacheKey) schedulePaint(true, 20);
    else if (pendingAnim) schedulePaint(false, 20);
  }, 800);

  output.on("resize", () => {
    cacheKey = "";
    schedulePaint(true, 20);
  });

  // Keyboard / SGR wheel when focused
  if (input.isTTY) {
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    let esc = "";
    input.on("data", (chunk) => {
      const s = String(chunk);
      // A trackpad delivers many wheel events per chunk — sum them, apply once.
      let delta = 0;
      const jump = (n) => {
        delta = 0;
        setScrollAbs(n);
      };
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (esc || ch === "\x1b") {
          esc += ch;
          if (esc.length > 1 && /[A-Za-z~Mm]$/.test(esc)) {
            const seq = esc;
            esc = "";
            // SGR wheel
            const m = seq.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
            if (m) {
              const btn = Number(m[1]);
              if (btn === 64 || btn === 4) delta += SCROLL_STEP;
              else if (btn === 65 || btn === 5) delta -= SCROLL_STEP;
              else if (btn === 0 && m[4] === "M") handleClick(Number(m[2]), Number(m[3]));
              continue;
            }
            if (/\x1b\[A$|\x1bOA$/.test(seq) || seq.endsWith("5~")) delta += SCROLL_STEP * (seq.endsWith("5~") ? 3 : 1);
            else if (/\x1b\[B$|\x1bOB$/.test(seq) || seq.endsWith("6~")) delta -= SCROLL_STEP * (seq.endsWith("6~") ? 3 : 1);
            else if (/\x1b\[H$|\x1bOH$|1~$|7~$/.test(seq)) jump(Number.MAX_SAFE_INTEGER);
            else if (/\x1b\[F$|\x1bOF$|4~$|8~$/.test(seq)) jump(0);
          } else if (esc.length > 32) esc = "";
          continue;
        }
        if (ch === "\x03" || ch === "q") {
          teardown();
          return;
        }
        if (ch === "k" || ch === "K" || ch === "h" || ch === "[") delta += SCROLL_STEP;
        else if (ch === "j" || ch === "J" || ch === "l" || ch === "]") delta -= SCROLL_STEP;
        else if (ch === "g") jump(Number.MAX_SAFE_INTEGER);
        else if (ch === "G" || ch === "\x04") jump(0);
        else if (ch === " ") delta -= SCROLL_STEP * 3;
        else if (ch === "b" || ch === "B") delta += SCROLL_STEP * 3;
      }
      if (delta) adjustScroll(delta);
    });
  }

  paint(true);
}


if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--live") || args.includes("live")) {
    runMeetChannelLive().catch((e) => {
      console.error(e?.message || e);
      process.exit(1);
    });
  } else {
    const cols = Number(args[args.indexOf("--cols") + 1]) || 80;
    const rows = Number(args[args.indexOf("--rows") + 1]) || 40;
    let scroll = 0;
    if (args.includes("--scroll")) scroll = Number(args[args.indexOf("--scroll") + 1]) || 0;
    process.stdout.write(renderMeetChannel({ cols, rows, scrollFromBottom: scroll }));
  }
}
