#!/usr/bin/env node
/**
 * Meet room TUI — gallery + OpenCode-style prompter.
 *
 *   node scripts/meet-room-prompter.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stdin, stdout } from "node:process";
import {
  renderMeetRoom,
  loadPage,
  savePage,
  pageCount,
  listMeetMembers,
  clampPage,
} from "./meet-room.mjs";
import { runLayout } from "./tmux-layout.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STAMP = `${ROOT}/sessions/.meet-room.stamp`;
const LEAVE = `${ROOT}/sessions/.meet-leave`;
const PENDING = `${ROOT}/sessions/.meet-pending.json`;
const PROMPT_INPUT_ROWS = 3;
const PROMPT_FOOTER_ROWS = 1;
const PROMPT_PANEL_ROWS = PROMPT_INPUT_ROWS + PROMPT_FOOTER_ROWS;
/** Gutter bar + one space before text (matches OpenCode prompt). */
const INPUT_LEFT = 2;

// Gotchi / OpenCode theme (.opencode/themes/gotchi.json + opencode-palette.ts)
const T = {
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

function paneSize() {
  const cols = stdout.columns || 80;
  const rows = stdout.rows || 24;
  return { cols, rows };
}

function mentionTags() {
  return listMeetMembers()
    .filter((m) => m.role !== "user")
    .map((m) => ({
      tag: `@${String(m.label || m.id).replace(/\s+/g, "")}`,
      label: m.label,
      id: m.id,
    }));
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

function pokeChannel() {
  const now = `${new Date().toISOString()}\n`;
  try {
    writeFileSync(`${ROOT}/sessions/.meet-channel.stamp`, now);
  } catch {
    /* ok */
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
  spawnSync("bash", [`${ROOT}/scripts/poke-meet-room.sh`], { stdio: "ignore" });
}

let sendBusy = false;
let sendDots = 1;
let sendTimer = null;
let sendError = null;
let drawing = false;
let redrawPending = false;

function writePending(text) {
  try {
    writeFileSync(
      PENDING,
      JSON.stringify({ text, startedAt: new Date().toISOString() }),
    );
  } catch {
    /* ok */
  }
}

function clearPending() {
  try {
    unlinkSync(PENDING);
  } catch {
    /* ok */
  }
}

function drawFooterOnly() {
  const { cols, rows } = paneSize();
  const top = rows - PROMPT_PANEL_ROWS + 1;
  drawInputPanel(top, cols);
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
  child.on("error", () => {
    sendBusy = false;
    clearPending();
    stopSendTimer();
    sendError = "send failed";
    pokeChannel();
    draw();
  });
  child.on("close", (code) => {
    sendBusy = false;
    clearPending();
    stopSendTimer();
    pokeChannel();
    if (code !== 0) sendError = "send failed";
    draw();
  });
}

function requestLeave(kind) {
  const mode = kind === "chat" ? "chat" : "end";
  try {
    writeFileSync(LEAVE, `${mode}\n`);
  } catch {
    /* ok */
  }
  stopSendTimer();
  clearPending();
  teardown();
  process.exit(0);
}

function endMeeting() {
  requestLeave("end");
}

function backToChat() {
  requestLeave("chat");
}

function pagePrev() {
  const members = listMeetMembers();
  savePage(clampPage(loadPage() - 1, members));
}

function pageNext() {
  const members = listMeetMembers();
  savePage(clampPage(loadPage() + 1, members));
}

function padPanelLine(text, cols) {
  const n = visLen(text);
  const pad = Math.max(0, cols - n);
  return `${text}${T.panel}${" ".repeat(pad)}${T.reset}`;
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
function layoutInput(buffer, cursor, cols) {
  const width = Math.max(1, cols - INPUT_LEFT);
  const segments = [];
  let pos = 0;
  for (let i = 0; i < PROMPT_INPUT_ROWS; i++) {
    const text = buffer.slice(pos, pos + width);
    segments.push({ text, start: pos });
    pos += text.length;
  }

  let cursorRow = 0;
  let cursorCol = INPUT_LEFT;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const end = seg.start + seg.text.length;
    if (cursor <= end || i === segments.length - 1) {
      cursorRow = i;
      cursorCol = INPUT_LEFT + Math.max(0, cursor - seg.start);
      break;
    }
  }
  return { segments, cursorRow, cursorCol };
}

function drawInputPanel(top, cols) {
  const { segments, cursorRow, cursorCol } = layoutInput(editor.buffer, editor.cursor, cols);

  for (let i = 0; i < PROMPT_INPUT_ROWS; i++) {
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
    writeAt(top + i, 1, padPanelLine(line, cols));
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
  } else {
    footerCore =
      `${T.accentBar}${T.panel} ${T.brand}Gotchi${T.reset}${T.panel}${T.muted} · ${T.text}${model}${T.reset}` +
      `${T.panel}${T.muted} · meeting room${T.reset}`;
  }
  writeAt(top + PROMPT_INPUT_ROWS, 1, padPanelLine(footerCore + footerTicks(cols, visLen(footerCore)), cols));

  stdout.write(`\x1b[${top + cursorRow};${Math.min(cols, cursorCol + 1)}H`);
}

function writeAt(row, col, text) {
  stdout.write(`\x1b[${row};${col}H\x1b[K${text}`);
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

  submit() {
    const line = this.buffer.trim();
    this.clear();
    if (!line) return "noop";
    if (line === "/end" || line === "/quit" || line === "/leave") return "end";
    if (line === "/chat" || line === "/opencode" || line === "/desk") return "chat";
    if (line === "/prev" || line === ",") {
      pagePrev();
      return "redraw";
    }
    if (line === "/next" || line === ".") {
      pageNext();
      return "redraw";
    }
    this.history.push(line);
    if (this.history.length > 100) this.history.shift();
    sayToRoom(line);
    return "redraw";
  }
}

const editor = new Prompter();

function drawBody() {
  const { cols, rows } = paneSize();
  const mentionRow = rows - PROMPT_PANEL_ROWS;
  const galleryRows = Math.max(8, rows - PROMPT_PANEL_ROWS - 1);
  const page = loadPage();
  const gallery = renderMeetRoom({
    cols,
    rows: galleryRows,
    page,
    includeHint: false,
  });

  stdout.write("\x1b[H\x1b[J");
  stdout.write(gallery);

  const top = rows - PROMPT_PANEL_ROWS + 1;
  const q = activeMentionQuery(editor.buffer);
  const matches = q != null ? matchingMentions(q) : [];

  if (matches.length && q != null) {
    const menu = matches
      .slice(0, 6)
      .map((m, i) => `${i === editor.menuIdx % matches.length ? T.menu : T.mention}${m.tag}${T.reset}`)
      .join(`${T.muted}  ${T.reset}`);
    writeAt(
      Math.max(1, mentionRow),
      1,
      padPanelLine(`${T.accentBar}${T.panel} ${T.muted}${menu}${T.reset}`, cols),
    );
  }

  drawInputPanel(top, cols);
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
  try {
    stdin.setRawMode(false);
  } catch {
    /* ok */
  }
  stdin.pause();
  stdout.write("\x1b[?25h\x1b[?7h\x1b[?1049l");
}

function setup() {
  if (!stdin.isTTY || !stdout.isTTY) {
    console.error("Meet room needs an interactive terminal (attach the tmux chat pane).");
    process.exit(1);
  }
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

function handleKey(chunk) {
  if (escBuf) {
    escBuf += chunk;
    if (/[A-Za-z~]$/.test(escBuf) || escBuf.length > 8) {
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

  switch (chunk) {
    case "\r":
    case "\n":
      return editor.submit();
    case "\x7f":
    case "\b":
      editor.backspace();
      return "redraw";
    case "\t":
      if (editor.completeMention()) return "redraw";
      return "noop";
    case "\x03":
      editor.clear();
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
  if (seq === "\x1b[A") {
    editor.historyUp();
    return "redraw";
  }
  if (seq === "\x1b[B") {
    editor.historyDown();
    return "redraw";
  }
  if (seq === "\x1b[C") {
    editor.move(1);
    return "redraw";
  }
  if (seq === "\x1b[D") {
    editor.move(-1);
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
  if (!process.env.TMUX) return;
  runLayout("refresh-meet-gallery", {
    env: { GOTCHIBOT_MEET_LAYOUT_ONLY: "1" },
  });
}

function markTmuxPane() {
  if (!process.env.TMUX) return;
  const tgt = process.env.TMUX_PANE || "";
  if (!tgt) return;
  spawnSync("tmux", ["set-option", "-p", "-t", tgt, "@gotchibot-meet-room", "1"], { stdio: "ignore" });
  spawnSync("tmux", ["set-option", "-p", "-t", tgt, "pane-border-format", " Meet · room "], {
    stdio: "ignore",
  });
}

function main() {
  ensureMeetGalleryLayout();
  markTmuxPane();
  setup();
  draw();

  process.on("SIGUSR1", () => {
    if (sendBusy) drawFooterOnly();
    else draw();
  });
  process.on("SIGWINCH", () => draw());
  process.on("SIGTERM", () => {
    stopSendTimer();
    teardown();
    process.exit(0);
  });
  process.on("exit", () => {
    stopSendTimer();
    teardown();
  });
  process.on("SIGINT", () => {
    editor.clear();
    draw();
  });

  stdin.on("data", (chunk) => {
  if (escBuf) {
    escBuf += chunk;
    if (/[A-Za-z~]$/.test(escBuf) || escBuf.length > 12) {
      const action = handleEsc(escBuf);
      escBuf = "";
      if (action === "end") endMeeting();
      else if (action === "chat") backToChat();
      else if (action === "redraw") draw();
    }
    return;
  }

  if (chunk.startsWith("\x1b")) {
    if (chunk.length === 1) {
      escBuf = chunk;
      return;
    }
    const action = handleEsc(chunk);
    if (action === "end") endMeeting();
    else if (action === "chat") backToChat();
    else if (action === "redraw") draw();
    return;
  }

  if (chunk.length > 1 && !/[\x00-\x1f\x7f]/.test(chunk)) {
    editor.insert(chunk);
    editor.menuIdx = 0;
    draw();
    return;
  }

  for (const ch of chunk) {
    const action = handleKey(ch);
    if (action === "end") {
      endMeeting();
      return;
    }
    if (action === "chat") {
      backToChat();
      return;
    }
    if (action === "redraw") draw();
  }
});
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
