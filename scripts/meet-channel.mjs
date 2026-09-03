#!/usr/bin/env node
/**
 * iMessage-style meet channel renderer (thumbnail gotchi avatars).
 *
 *   node scripts/meet-channel.mjs --render [--cols N] [--rows N] [--scroll N]
 */
import { spawnSync } from "node:child_process";
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MEETINGS = `${ROOT}/sessions/meetings`;
const PENDING = `${ROOT}/sessions/.meet-pending.json`;
const SCROLL_FILE = `${ROOT}/sessions/.meet-channel-scroll`;
const STAMP = `${ROOT}/sessions/.meet-channel.stamp`;
const THUMB_FALLBACK = `${ROOT}/assets/gotchi-thumb.ascii`;
const THUMB_CACHE_DIR = `${ROOT}/sessions/.meet-thumbs`;
const THUMB_W = 14;
const SCROLLBAR_COLS = 2;
const SCROLL_STEP = Math.max(1, Number(process.env.GOTCHIBOT_MEET_CHANNEL_SCROLL_STEP || 3) || 3);


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
  mkdirSync(THUMB_CACHE_DIR, { recursive: true });
  const disk = `${THUMB_CACHE_DIR}/${String(heroId).replace(/[^\w.-]+/g, "_")}.ansi`;
  try {
    if (existsSync(disk)) {
      const art = readFileSync(disk, "utf8").trimEnd();
      if (art) return art.split("\n");
    }
  } catch {
    /* regenerate */
  }
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
  try {
    writeFileSync(disk, `${art}\n`);
  } catch {
    /* ok */
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
    `${C.dim}${agents} gotchi${agents === 1 ? "" : "s"} · ↑↓ wheel · j/k · PgUp/Dn · scrollbar${C.reset}`,
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
  const lines = String(frame).replace(/\n$/, "").split("\n");
  let out = "\x1b[H";
  for (const line of lines) {
    out += `${line}\x1b[K\n`;
  }
  out += "\x1b[J";
  output.write(out);
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
    const tr = id ? `${MEETINGS}/${id}/transcript.jsonl` : "";
    return [
      cols,
      id,
      mtime(tr),
      mtime(PENDING),
      mtime(`${MEETINGS}/.current`),
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
      return cachedLines;
    }
    const contentCols = Math.max(24, cols - SCROLLBAR_COLS);
    cachedLines = buildMeetChannelLines(meeting, cols, contentCols);
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
    if (total <= viewport) return attachScrollbar(allLines, bar, cols);
    const end = total - fromBottom;
    const start = Math.max(0, end - viewport);
    const visible = allLines.slice(start, end);
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
    if (paintTimer) clearTimeout(paintTimer);
    paintTimer = setTimeout(() => {
      paintTimer = null;
      const force = forceNext;
      forceNext = false;
      paint(force);
    }, delayMs);
  }

  function adjustScroll(delta) {
    const { cols, rows } = paneSize();
    const max = Math.max(0, ensureLines(cols, rows, false).length - Math.max(8, rows));
    scroll = Math.max(0, Math.min(max, loadScroll() + delta));
    saveScroll(scroll);
    // Scroll-only: no content rebuild — just re-slice (debounce tiny).
    schedulePaint(false, 16);
  }

  function setScrollAbs(n) {
    const { cols, rows } = paneSize();
    const max = Math.max(0, ensureLines(cols, rows, false).length - Math.max(8, rows));
    scroll = Math.max(0, Math.min(max, n));
    saveScroll(scroll);
    schedulePaint(false, 16);
  }

  // Watch scroll + stamp + pending — quiet scroll.sh only touches scroll file.
  const watchTargets = [
    `${ROOT}/sessions`,
    MEETINGS,
  ];
  for (const dir of watchTargets) {
    try {
      watch(dir, { persistent: true }, (evt, fname) => {
        const f = String(fname || "");
        if (f.includes("meet-channel-scroll")) {
          schedulePaint(false, 24);
          return;
        }
        if (
          f.includes("meet-channel.stamp") ||
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
              if (btn === 64 || btn === 4) adjustScroll(SCROLL_STEP);
              else if (btn === 65 || btn === 5) adjustScroll(-SCROLL_STEP);
              continue;
            }
            if (/\x1b\[A$|\x1bOA$/.test(seq) || seq.endsWith("5~")) adjustScroll(SCROLL_STEP * (seq.endsWith("5~") ? 3 : 1));
            else if (/\x1b\[B$|\x1bOB$/.test(seq) || seq.endsWith("6~")) adjustScroll(-(SCROLL_STEP * (seq.endsWith("6~") ? 3 : 1)));
            else if (/\x1b\[H$|\x1bOH$|1~$|7~$/.test(seq)) setScrollAbs(maxScrollFromBottom(paneSize()));
            else if (/\x1b\[F$|\x1bOF$|4~$|8~$/.test(seq)) setScrollAbs(0);
          } else if (esc.length > 32) esc = "";
          continue;
        }
        if (ch === "\x03" || ch === "q") {
          teardown();
          return;
        }
        if (ch === "k" || ch === "K" || ch === "h" || ch === "[") adjustScroll(SCROLL_STEP);
        else if (ch === "j" || ch === "J" || ch === "l" || ch === "]") adjustScroll(-SCROLL_STEP);
        else if (ch === "g") setScrollAbs(maxScrollFromBottom(paneSize()));
        else if (ch === "G" || ch === "\x04") setScrollAbs(0);
        else if (ch === " ") adjustScroll(-(SCROLL_STEP * 3));
        else if (ch === "b" || ch === "B") adjustScroll(SCROLL_STEP * 3);
      }
    });
  }

  paint(true);
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
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
