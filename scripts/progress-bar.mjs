#!/usr/bin/env node
/**
 * Terminal progress bars for GotchiBot Node paths (mirrors progress-bar.sh).
 *
 *   import { withStatusBar, progressDone, progressFail, Progress } from "./progress-bar.mjs";
 *   await withStatusBar("Loading on-chain gotchis…", async () => fetch…);
 *   const bar = new Progress();
 *   await bar.pulse("Binding #8461…", () => bind…, { nextPct: 40 });
 *   bar.done("bound 20");
 *
 *   node scripts/progress-bar.mjs demo ["label"]
 *   node scripts/progress-bar.mjs --batch
 */
import { isMainModule } from "./is-main.mjs";

const WIDTH = Number(process.env.GOTCHIBOT_PROGRESS_WIDTH || 36) || 36;
const FG = "\x1b[38;5;39m";
const MUTED = "\x1b[38;5;240m";
const DONE = "\x1b[38;5;82m";
const WARN = "\x1b[38;5;214m";
const RESET = "\x1b[0m";
const HEAD = ["▒", "▓", "█", "▓", "▒"];
const TRACK = "░";
const INTERVAL_MS = Number(process.env.GOTCHIBOT_PROGRESS_INTERVAL_MS || 50) || 50;

function hideCursor() {
  if (process.stderr.isTTY) process.stderr.write("\x1b[?25l");
}

function showCursor() {
  if (process.stderr.isTTY) process.stderr.write("\x1b[?25h");
}

function clearLine() {
  process.stderr.write("\r\x1b[K");
}

function pulseFrame(label, frame, elapsedSec) {
  const hl = HEAD.length;
  const period = Math.max(1, (WIDTH - hl) * 2);
  let pos = frame % period;
  if (pos >= WIDTH - hl) pos = period - pos;
  let bar = "";
  for (let i = 0; i < WIDTH; i++) {
    if (i >= pos && i < pos + hl) {
      bar += FG + HEAD[i - pos];
    } else {
      bar += MUTED + TRACK;
    }
  }
  const elapsed = elapsedSec != null ? `${MUTED} ${elapsedSec}s` : "";
  process.stderr.write(`\r${bar}${RESET} ${label}${elapsed}${RESET}\x1b[K`);
}

function solidBarLine(pct, label, color = FG, newline = true) {
  const filled = Math.max(0, Math.min(WIDTH, Math.round((pct / 100) * WIDTH)));
  const bar = "█".repeat(filled) + TRACK.repeat(WIDTH - filled);
  const end = newline ? "\n" : "";
  process.stderr.write(
    `\r${color}${bar}${RESET} ${String(pct).padStart(3)}% ${label}${RESET}\x1b[K${end}`,
  );
}

export function progressDone(label) {
  solidBarLine(100, label, DONE, true);
}

export function progressFail(label) {
  solidBarLine(0, label, WARN, true);
}

/** Determinate bar (no newline) — use while stepping a batch job. */
export function progressSet(pct, label) {
  solidBarLine(pct, label, FG, false);
}

/**
 * Batch progress: determinate fill + optional pulse during each step.
 */
export class Progress {
  constructor() {
    this._timer = null;
    this._frame = 0;
    this._started = Date.now();
    this._label = "";
    this._pct = 0;
    this._pulsing = false;
  }

  set(pct, label) {
    this._pct = Math.max(0, Math.min(100, Math.round(pct)));
    this._label = label || this._label;
    if (!this._pulsing) {
      solidBarLine(this._pct, this._label, FG, false);
    }
  }

  /** Pulse while fn runs, then restore determinate bar at nextPct. */
  async pulse(label, fn, { nextPct = null } = {}) {
    this._stopPulse();
    this._pulsing = true;
    this._frame = 0;
    this._started = Date.now();
    this._label = label;
    hideCursor();
    pulseFrame(label, 0, 0);
    this._timer = setInterval(() => {
      this._frame += 1;
      const secs = Math.floor((Date.now() - this._started) / 1000);
      pulseFrame(label, this._frame, secs);
    }, INTERVAL_MS);
    try {
      return await fn();
    } finally {
      this._stopPulse();
      this._pulsing = false;
      showCursor();
      if (nextPct != null) this.set(nextPct, this._label);
    }
  }

  done(label) {
    this._stopPulse();
    clearLine();
    progressDone(label || this._label);
    showCursor();
  }

  fail(label) {
    this._stopPulse();
    clearLine();
    progressFail(label || this._label);
    showCursor();
  }

  _stopPulse() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    clearLine();
  }
}

/**
 * Live indeterminate status bar while `fn` runs. Clears on settle.
 * @template T
 * @param {string} label
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withStatusBar(label, fn) {
  let frame = 0;
  const started = Date.now();
  hideCursor();
  pulseFrame(label, 0, 0);
  const timer = setInterval(() => {
    frame += 1;
    const secs = Math.floor((Date.now() - started) / 1000);
    pulseFrame(label, frame, secs);
  }, INTERVAL_MS);

  try {
    const result = await fn();
    clearInterval(timer);
    clearLine();
    progressDone(label);
    return result;
  } catch (err) {
    clearInterval(timer);
    clearLine();
    progressFail(`${label} — failed`);
    throw err;
  } finally {
    showCursor();
  }
}

async function main() {
  const label = process.argv[2] || "Loading…";
  if (process.argv.includes("--batch")) {
    const bar = new Progress();
    const n = 8;
    for (let i = 0; i < n; i++) {
      const next = Math.round(((i + 1) / n) * 100);
      await bar.pulse(`Binding #${1000 + i}… (${i + 1}/${n})`, () => new Promise((r) => setTimeout(r, 200)), {
        nextPct: next,
      });
      bar.set(next, `minted ${i + 1}/${n}`);
      process.stderr.write(`\n  ✓ owned-${1000 + i}\n`);
    }
    bar.done(`bound ${n}`);
    return;
  }
  await withStatusBar(label, () => new Promise((r) => setTimeout(r, 2500)));
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
