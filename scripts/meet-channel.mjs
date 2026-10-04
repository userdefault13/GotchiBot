#!/usr/bin/env node
/**
 * iMessage-style meet channel renderer (thumbnail gotchi avatars).
 *
 *   node scripts/meet-channel.mjs --render [--cols N] [--rows N] [--scroll N]
 */
import { spawn, spawnSync } from "node:child_process";
import {
  readFileSync,
  readdirSync,
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
import { startHubProjectMirror } from "./hub-project-sync.mjs";
import { isProfLinkCubeId } from "./gotchi-art.mjs";
import { downgradeAnsi, renderMode, toAsciiGlyphs } from "./lib/term-color.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PENDING = `${ROOT}/sessions/.meet-pending.json`;
const SCROLL_FILE = `${ROOT}/sessions/.meet-channel-scroll`;
const STAMP = `${ROOT}/sessions/.meet-channel.stamp`;
const THUMB_FALLBACK = `${ROOT}/assets/gotchi-thumb.ascii`;
const MINI_FALLBACK = `${ROOT}/assets/gotchi-kanban.ascii`;
const THUMB_CACHE_DIR = `${ROOT}/sessions/.meet-thumbs`;
const THUMB_W = 14;
const SCROLLBAR_COLS = 2;
/** Inset of the meet transcript next to the avatar pane. */
export const TRANSCRIPT_PAD_X = 2;
export const TRANSCRIPT_PAD_Y = 1;
const SCROLL_STEP = Math.max(1, Number(process.env.GOTCHIBOT_MEET_CHANNEL_SCROLL_STEP || 3) || 3);
const COPY_LABEL = "[copy]";
const COPIED_LABEL = "[copied]";
const COPY_FAILED_LABEL = "[copy failed]";
const EDIT_LABEL = "[edit]";
/** How long the copied/failed flash stays on the button. */
const COPY_FLASH_MS = 1400;
const EDIT_REQUEST = `${ROOT}/sessions/.meet-edit-request.json`;

const _tui = renderMode();

function meetingsRoot() {
  return resolveMeetingsRoot().root;
}


const C_RAW = {
  reset: "\x1b[0m",
  dim: "\x1b[38;5;245m",
  user: "\x1b[38;5;117m",
  chair: "\x1b[38;5;213m",
  agent: "\x1b[38;5;51m",
  topic: "\x1b[38;5;184m",
  bar: "\x1b[38;5;240m",
  body: "\x1b[38;5;252m",
};

const C = Object.fromEntries(
  Object.entries(C_RAW).map(([k, v]) => [k, downgradeAnsi(v, _tui.color)]),
);

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

/** One saved meeting by id (open or ended), or null. */
export function loadMeetingById(id) {
  if (!id) return null;
  return readJson(`${meetingsRoot()}/${id}/meeting.json`, null);
}

/**
 * Saved meetings, newest first. solo = 1:1 chat (gotchi-meet.mjs chat).
 * The open meeting is flagged so the sidebar can mark it.
 */
export function listMeetings() {
  const root = meetingsRoot();
  let ids = [];
  try {
    ids = readdirSync(root).filter((d) => /^m\d/.test(d));
  } catch {
    return [];
  }
  const current = loadCurrentMeeting();
  const out = [];
  for (const id of ids) {
    const m = readJson(`${root}/${id}/meeting.json`, null);
    if (!m || m.deleted) continue;
    out.push({
      ...m,
      id: m.id || id,
      isCurrent: Boolean(current && current.id === (m.id || id)),
    });
  }
  out.sort((a, b) => String(b.createdAt || b.id).localeCompare(String(a.createdAt || a.id)));
  return out;
}

/**
 * Meets combined into threads for the meet list: every group meeting is one
 * "Group meetings" thread; 1:1 chats are one thread per gotchi. Each thread
 * keeps its meetings oldest-first in `segments` so the log can show where each
 * one started and ended. Newest thread first.
 */
export function listMeetThreads() {
  const meets = listMeetings();
  const byKey = new Map();
  // Direct chats (gotchi-meet.mjs chat) key on their exact gotchi set.
  const agentKey = (m) =>
    (m.participants || []).filter((p) => p.role !== "user").map((p) => p.id).sort().join(",");
  for (const m of meets) {
    const key = m.solo || m.direct ? `direct:${agentKey(m) || m.chairId}` : "group";
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(m);
  }
  const threads = [];
  for (const [key, list] of byKey) {
    const segments = [...list].sort((a, b) =>
      String(a.createdAt || a.id).localeCompare(String(b.createdAt || b.id)),
    );
    const latest = segments[segments.length - 1];
    const open = segments.find((m) => m.isCurrent) || null;
    // Parked: open but not current (left via /chat). Typing there resumes it.
    const parked = [...segments].reverse().find((m) => m.status === "open" && !m.isCurrent) || null;
    const seen = new Map();
    for (const seg of segments) {
      for (const p of seg.participants || []) if (!seen.has(p.id)) seen.set(p.id, p);
    }
    const direct = key !== "group";
    const agents = (latest.participants || []).filter((p) => p.role !== "user");
    threads.push({
      id: key,
      combined: true,
      solo: direct,
      direct,
      agentCount: agents.length,
      topic: direct ? `chat with ${agents.map((p) => p.name || p.id).join(", ") || latest.chairId}` : "group meetings",
      chairId: (open || latest).chairId,
      participants: [...seen.values()],
      segments,
      createdAt: latest.createdAt,
      status: open ? "open" : parked ? "paused" : "ended",
      isCurrent: Boolean(open),
      openId: open?.id || null,
      parkedId: parked?.id || null,
    });
  }
  threads.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return threads;
}

function stampTime(iso) {
  const d = new Date(iso || 0);
  if (Number.isNaN(d.getTime()) || !d.getTime()) return "";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Divider row: ── text ─────. */
function dividerLine(text, cols, color = C.topic) {
  const label = ` ${text} `;
  const width = Math.max(label.length + 4, Math.min(cols - 2, 72));
  const right = Math.max(2, width - label.length - 2);
  return `${C.bar}──${C.reset}${color}${label}${C.reset}${C.bar}${"─".repeat(right)}${C.reset}`;
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
const miniCache = new Map();

function thumbDiskPath(heroId) {
  const safe = String(heroId).replace(/[^\w.-]+/g, "_");
  return `${THUMB_CACHE_DIR}/${safe}.${_tui.color}-${_tui.glyphs}.txt`;
}

function gotchiArtThumbArgs(heroId) {
  const args = [
    `${ROOT}/scripts/gotchi-art.mjs`,
    "--thumb",
    "--hero",
    heroId,
    "--color",
    "--color-mode",
    _tui.color,
  ];
  if (_tui.glyphs === "ascii") args.push("--ascii");
  return args;
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
  const r = spawnSync(process.execPath, gotchiArtThumbArgs(heroId), {
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


function miniDiskPath(heroId) {
  const safe = String(heroId).replace(/[^\w.-]+/g, "_");
  return `${THUMB_CACHE_DIR}/${safe}.mini.${_tui.color}-${_tui.glyphs}.txt`;
}

function gotchiArtMiniArgs(heroId) {
  const args = gotchiArtThumbArgs(heroId);
  const i = args.indexOf("--thumb");
  if (i >= 0) args[i] = "--mini";
  return args;
}

function normalizeMiniLines(art) {
  const lines = String(art || "")
    .replace(/\n+$/, "")
    .split("\n");
  const width = Math.max(9, ...lines.map((l) => plainLen(l)));
  return lines.map((l) => {
    const pad = width - plainLen(l);
    return pad > 0 ? `${l}${" ".repeat(pad)}` : l;
  });
}

function miniForHero(heroId) {
  mkdirSync(THUMB_CACHE_DIR, { recursive: true });
  const disk = miniDiskPath(heroId);
  try {
    if (existsSync(disk)) {
      const art = readFileSync(disk, "utf8");
      if (art.trim()) return normalizeMiniLines(art);
    }
  } catch {
    /* regenerate */
  }
  const r = spawnSync(process.execPath, gotchiArtMiniArgs(heroId), {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 8000,
  });
  let art = r.stdout || "";
  if (!art.trim()) {
    try {
      art = readFileSync(MINI_FALLBACK, "utf8");
    } catch {
      art = "  ▄▄▄▄▄  ";
    }
  }
  const lines = normalizeMiniLines(art);
  try {
    writeFileSync(disk, `${lines.join("\n")}\n`);
  } catch {
    /* ok */
  }
  return lines;
}

/** Small roster head. Not the iMessage thumb. */
export function getMini(heroId) {
  if (!heroId || heroId === "userdefault") {
    try {
      return normalizeMiniLines(readFileSync(MINI_FALLBACK, "utf8"));
    } catch {
      return ["  ▄▄▄▄▄  "];
    }
  }
  if (!miniCache.has(heroId)) miniCache.set(heroId, miniForHero(heroId));
  return miniCache.get(heroId);
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
      child = spawn(process.execPath, gotchiArtThumbArgs(id), {
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
  const nav = `j/k · ↑↓ · PgUp/Dn`;
  const n = meeting.segments?.length || 0;
  const count = meeting.combined ? `${n} ${meeting.solo ? "chat" : "meeting"}${n === 1 ? "" : "s"} · ` : "";
  return [
    `${C.topic}# ${topic}${C.reset}`,
    `${C.dim}${count}${agents} gotchi${agents === 1 ? "" : "s"} · ${nav}${C.reset}`,
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
  const colStart = THUMB_W + 2 + visLen(meta) + 1;
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
  // 2 columns between the sprite and the words, 2 columns before the right edge.
  const TEXT_PAD_X = 2;
  const TEXT_PAD_RIGHT = 2;
  const bodyW = Math.max(12, cols - THUMB_W - TEXT_PAD_X - TEXT_PAD_RIGHT);
  const bodyLines = wrapLines(turn.text, bodyW);
  const gutter = " ".repeat(TEXT_PAD_X);
  // Quiet "edited" cue on the user's own corrected messages — not a badge card.
  const edited = turn.editedAt && role === "user" ? ` ${C.dim}(edited)${C.reset}` : "";
  const meta = `${nameColor(role)}${name}${C.reset} ${C.dim}${formatTime(turn.ts)}${C.reset}${edited}`;
  const header = hit ? withActionButton(meta, turn, cols, hit) : meta;
  const blockH = Math.max(thumb.length, 1 + bodyLines.length);
  const rows = [];

  for (let i = 0; i < blockH; i++) {
    const thumbPart = padVis(thumb[i] || "", THUMB_W);
    if (i === 0) {
      rows.push(`${thumbPart}${gutter}${header}`);
      continue;
    }
    const text = bodyLines[i - 1];
    if (text) {
      rows.push(`${thumbPart}${gutter}${C.body}${text}${C.reset}`);
    } else if (stripAnsi(thumb[i] || "").trim()) {
      rows.push(thumbPart);
    }
  }
  rows.push(""); // 1 row of air under the message
  return rows;
}

/**
 * Full channel lines (header + messages).
 * Pass `opts.hits` (an array) to draw clickable [copy] buttons on responses and
 * collect their hitboxes; `opts.copiedKey`/`opts.copiedState` flash one button.
 */
/** One thread (listMeetThreads): each meeting between start and end markers. */
function buildThreadLines(thread, cols, contentCols, opts = {}) {
  const hits = opts.hits || null;
  const lines = [...renderHeader(thread, contentCols, Boolean(hits))];
  const segs = thread.segments || [];
  if (!segs.length) lines.push(`${C.dim}(no messages saved)${C.reset}`, "");
  for (const seg of segs) {
    const open = seg.status === "open" && seg.isCurrent;
    const paused = seg.status === "open" && !seg.isCurrent;
    lines.push(dividerLine(`▶ ${seg.topic || "meeting"} · started ${stampTime(seg.createdAt)}`, contentCols));
    lines.push("");
    const turns = readTranscript(seg.id);
    if (!turns.length) lines.push(`${C.dim}  (no messages)${C.reset}`, "");
    turns.forEach((t, i) => {
      const role = t.role || participantInfo(seg, t.speaker).role;
      const key = `${seg.id}:${i}:${t.ts || ""}`;
      let hit = null;
      if (hits) {
        // Only the open meeting's own lines can be edited.
        const action = role === "user" && open ? "edit" : "copy";
        hit = {
          hits,
          line: lines.length,
          key,
          action,
          copied: action === "copy" && opts.copiedKey === key ? opts.copiedState || "ok" : null,
        };
      }
      lines.push(...renderTurn(t, seg, contentCols, hit));
    });
    if (open) {
      lines.push(...renderPendingTail(seg, cols, turns));
      lines.push(dividerLine("● in progress", contentCols, C.chair), "");
    } else if (paused) {
      lines.push(dividerLine(`‖ paused ${stampTime(seg.parkedAt || seg.updatedAt)} · type to resume`, contentCols, C.dim), "");
    } else {
      const end = seg.endedAt || seg.updatedAt;
      lines.push(dividerLine(`■ ended ${stampTime(end)}`, contentCols, C.dim), "");
    }
  }
  return lines;
}

export function buildMeetChannelLines(meeting, cols, contentCols = cols, opts = {}) {
  if (meeting?.combined) return buildThreadLines(meeting, cols, contentCols, opts);
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

function transcriptContentCols(cols) {
  return Math.max(16, cols - SCROLLBAR_COLS - TRANSCRIPT_PAD_X * 2);
}

function transcriptMessageRows(rows) {
  return Math.max(1, rows - TRANSCRIPT_PAD_Y * 2);
}

/** Left inset on each line, plus a blank row above and below the messages. */
function insetTranscript(lines, rows) {
  const left = " ".repeat(TRANSCRIPT_PAD_X);
  const body = lines.map((line) => left + (line || ""));
  const blank = left;
  const out = [
    ...Array(TRANSCRIPT_PAD_Y).fill(blank),
    ...body,
    ...Array(TRANSCRIPT_PAD_Y).fill(blank),
  ];
  while (out.length < rows) out.push(blank);
  if (out.length > rows) out.length = rows;
  return out;
}

export function maxScrollFromBottom({ cols = 80, rows = 40, meeting = loadCurrentMeeting() } = {}) {
  if (!meeting) return 0;
  const contentCols = transcriptContentCols(cols);
  const total = buildMeetChannelLines(meeting, cols, contentCols).length;
  const viewport = transcriptMessageRows(rows);
  // Scrolled up, the "↓ newer" row takes one line; leave room so the top is reachable.
  return total > viewport ? total - viewport + 1 : 0;
}

export function renderMeetChannel({
  cols = 80,
  rows = 40,
  scrollFromBottom = 0,
  meeting: picked = undefined,
} = {}) {
  // undefined → the open meeting; a meeting object → that saved log.
  const meeting = picked === undefined ? loadCurrentMeeting() : picked;
  if (!meeting) {
    return finalizeChannelFrame(
      [
        `${C.dim}No open meeting${C.reset}`,
        "",
        "Open meet menu or:",
        '  /meet start "topic"',
        "",
      ].join("\n"),
    );
  }

  const contentCols = transcriptContentCols(cols);
  const allLines = buildMeetChannelLines(meeting, cols, contentCols);
  const total = allLines.length;
  const viewport = transcriptMessageRows(rows);
  const fromBottom = Math.max(
    0,
    Math.min(
      total > viewport ? total - viewport + 1 : 0,
      Math.max(0, Number(scrollFromBottom) || 0),
    ),
  );
  const bar = buildScrollbar(total, viewport, fromBottom, rows);

  let visible;
  if (total <= viewport) {
    visible = allLines.slice();
  } else {
    // Reserve rows for the ↑/↓ markers so "↓ newer" is never cut off.
    const end = total - fromBottom;
    const newer = fromBottom > 0 ? 1 : 0;
    let start = Math.max(0, end - (viewport - newer));
    if (start > 0) start = Math.min(end, start + 1);
    visible = allLines.slice(start, end);
    if (start > 0) visible.unshift(`${C.dim}↑ older${C.reset}`);
    if (newer) visible.push(`${C.dim}↓ newer · End latest${C.reset}`);
    if (visible.length > viewport) visible.length = viewport;
  }

  return finalizeChannelFrame(attachScrollbar(insetTranscript(visible, rows), bar, cols));
}

function finalizeChannelFrame(frame) {
  return _tui.glyphs === "ascii" ? toAsciiGlyphs(frame) : frame;
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
 * Keyboard j/k and arrows scroll. Mouse wheel is ignored.
 */
export async function runMeetChannelLive() {
  mkdirSync(`${ROOT}/sessions`, { recursive: true });
  output.write("\x1b[?1049h\x1b[?7l\x1b[?25l");
  // Button events only — no 1002 motion flood. Skip when mouse is off (plain / linux).
  // Mouse off: do not ask the terminal for SGR wheel (64/65).
  const useMouse = false;

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
  let stopMirror = () => {};

  const teardown = () => {
    if (destroyed) return;
    destroyed = true;
    stopMirror();
    if (paintTimer) clearTimeout(paintTimer);
    try {
      if (useMouse) output.write("\x1b[?1006l\x1b[?1000l");
      output.write("\x1b[?25h\x1b[?7h\x1b[?1049l");
    } catch {
      /* ok */
    }
    process.exit(0);
  };
  process.on("SIGINT", teardown);
  process.on("SIGTERM", teardown);
  process.on("SIGUSR1", () => schedulePaint(true));
  stopMirror = startHubProjectMirror({
    root: ROOT,
    onChange() {
      schedulePaint(true, 0);
    },
  });

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

  // Keyboard scroll when focused. Wheel sequences are ignored.
  if (input.isTTY) {
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    let esc = "";
    input.on("data", (chunk) => {
      const s = String(chunk);
      // Keyboard deltas are summed once per chunk. Wheel is not applied.
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
            // SGR mouse. Wheel buttons are not handled.
            const m = seq.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
            if (m) {
              const btn = Number(m[1]);
              // Wheel (SGR 64/65, legacy 4/5) is ignored — no scroll, no repaint.
              if (btn === 64 || btn === 65 || btn === 4 || btn === 5) continue;
              if (btn === 0 && m[4] === "M") handleClick(Number(m[2]), Number(m[3]));
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
