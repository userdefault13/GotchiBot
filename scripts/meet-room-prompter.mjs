#!/usr/bin/env node
/**
 * Meet room TUI — gallery + OpenCode-style prompter.
 *
 *   node scripts/meet-room-prompter.mjs
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STAMP = `${ROOT}/sessions/.meet-room.stamp`;
const PROMPT_ROWS = 3;

const T = {
  reset: "\x1b[0m",
  panel: "\x1b[48;2;45;31;66m",
  border: "\x1b[38;5;240m",
  prefix: "\x1b[38;5;213m",
  accent: "\x1b[38;5;255m",
  text: "\x1b[38;5;252m",
  muted: "\x1b[38;5;245m",
  mention: "\x1b[38;5;51m",
  menu: "\x1b[38;5;184m",
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
    writeFileSync(STAMP, now);
    writeFileSync(`${ROOT}/sessions/.meet-channel.stamp`, now);
  } catch {
    /* ok */
  }
  spawnSync("bash", [`${ROOT}/scripts/poke-meet-channel.sh`], { stdio: "ignore" });
  spawnSync("bash", [`${ROOT}/scripts/poke-meet-room.sh`], { stdio: "ignore" });
}

function sayToRoom(msg) {
  const text = String(msg || "").trim();
  if (!text) return;
  spawnSync(process.execPath, [`${ROOT}/scripts/gotchi-meet.mjs`, "say", text], {
    cwd: ROOT,
    stdio: "inherit",
  });
  pokeChannel();
}

function endMeeting() {
  spawnSync(process.execPath, [`${ROOT}/scripts/gotchi-meet.mjs`, "end"], {
    cwd: ROOT,
    stdio: "ignore",
  });
  if (process.env.TMUX) {
    spawnSync("bash", [`${ROOT}/scripts/orchestrator-layout.sh`, "leave-meet-gallery"], {
      cwd: ROOT,
      stdio: "ignore",
      env: {
        ...process.env,
        GOTCHIBOT_TMUX_SESSION: process.env.GOTCHIBOT_TMUX_SESSION || "gotchibot",
      },
    });
  }
  teardown();
  process.exit(0);
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

function draw() {
  const { cols, rows } = paneSize();
  const galleryRows = Math.max(8, rows - PROMPT_ROWS);
  const page = loadPage();
  const gallery = renderMeetRoom({
    cols,
    rows: galleryRows,
    page,
    includeHint: false,
  });

  stdout.write("\x1b[H\x1b[J");
  stdout.write(gallery);

  const top = rows - PROMPT_ROWS + 1;
  const q = activeMentionQuery(editor.buffer);
  const matches = q != null ? matchingMentions(q) : [];

  if (matches.length && q != null) {
    const menu = matches
      .slice(0, 6)
      .map((m, i) => `${i === editor.menuIdx % matches.length ? T.menu : T.mention}${m.tag}${T.reset}`)
      .join(`${T.muted}  ${T.reset}`);
    writeAt(Math.max(1, top - 1), 1, padPanelLine(`${T.panel}${T.muted}  ${menu}${T.reset}`, cols));
  }

  writeAt(top, 1, `${T.border}${"─".repeat(Math.max(0, cols))}${T.reset}`);

  const before = editor.buffer.slice(0, editor.cursor);
  const after = editor.buffer.slice(editor.cursor);
  const prefixVis = " meet › ";
  const inputLine = `${T.panel}${T.prefix}meet${T.reset}${T.panel}${T.muted} › ${T.text}${before}${T.accent}▌${T.text}${after}${T.reset}`;
  writeAt(top + 1, 1, padPanelLine(inputLine, cols));

  const pages = pageCount(listMeetMembers());
  const hint = `${T.panel}${T.muted}  @mention · Enter send · ↑↓ history · Tab complete · /end leave · page ${loadPage() + 1}/${pages}${T.reset}`;
  writeAt(top + 2, 1, padPanelLine(hint, cols));

  const cursorCol = Math.min(cols, 1 + visLen(prefixVis) + visLen(before) + 1);
  stdout.write(`\x1b[${top + 1};${cursorCol}H`);
}

function teardown() {
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
  // Channel-only repair — never respawn work.1 while this prompter is running here.
  spawnSync("bash", [`${ROOT}/scripts/orchestrator-layout.sh`, "refresh-meet-gallery"], {
    cwd: ROOT,
    stdio: "ignore",
    env: {
      ...process.env,
      GOTCHIBOT_TMUX_SESSION: process.env.GOTCHIBOT_TMUX_SESSION || "gotchibot",
      GOTCHIBOT_MEET_LAYOUT_ONLY: "1",
    },
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

  process.on("SIGUSR1", () => draw());
  process.on("SIGWINCH", () => draw());
  process.on("SIGTERM", () => {
    teardown();
    process.exit(0);
  });
  process.on("exit", teardown);
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
    if (action === "redraw") draw();
  }
});
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
