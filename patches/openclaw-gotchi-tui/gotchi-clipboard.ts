/**
 * Clipboard for Gotchi OpenClaw TUI.
 * Prefer OSC 52 (works through tmux → Terminal/iTerm) and verify pbcopy with pbpaste.
 * OpenClaw's copyToClipboard can return true under abra/tmux while the GUI pasteboard stays empty.
 */
import { spawnSync } from "node:child_process";
import { writeSync } from "node:fs";

const MAX_OSC52_BYTES = 100_000;

function encodeOsc52(text: string): string {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  // BEL and ST terminators — terminals / tmux accept either.
  return `\x1b]52;c;${b64}\x07\x1b]52;c;${b64}\x1b\\`;
}

function writeOsc52(text: string): boolean {
  if (Buffer.byteLength(text, "utf8") > MAX_OSC52_BYTES) {
    return false;
  }
  const payload = encodeOsc52(text);
  for (const fd of [1, 2] as const) {
    try {
      if (process.stdout.isTTY || process.stderr.isTTY || process.env.TMUX) {
        writeSync(fd, payload);
        return true;
      }
    } catch {
      /* try next fd */
    }
  }
  try {
    writeSync(1, payload);
    return true;
  } catch {
    return false;
  }
}

function writePbcopy(text: string): boolean {
  const r = spawnSync("/usr/bin/pbcopy", [], {
    input: text,
    encoding: "utf8",
    env: process.env,
    timeout: 3000,
  });
  if (r.status !== 0) {
    return false;
  }
  // Verify — under abra/tmux, pbcopy can exit 0 without updating the user pasteboard.
  const check = spawnSync("/usr/bin/pbpaste", [], {
    encoding: "utf8",
    env: process.env,
    timeout: 3000,
  });
  if (check.status !== 0) {
    return false;
  }
  return check.stdout === text;
}

export type GotchiClipboardResult = {
  ok: boolean;
  via: Array<"osc52" | "pbcopy">;
  verified: boolean;
};

/** Copy text to the host clipboard; prefer methods the user can actually paste. */
export function copyGotchiClipboard(text: string): GotchiClipboardResult {
  const value = String(text ?? "");
  if (!value) {
    return { ok: false, via: [], verified: false };
  }

  const via: Array<"osc52" | "pbcopy"> = [];
  let verified = false;

  if (writeOsc52(value)) {
    via.push("osc52");
  }

  if (writePbcopy(value)) {
    via.push("pbcopy");
    verified = true;
  }

  // OSC 52 alone is OK inside tmux (set-clipboard on) even when pbcopy verify fails.
  const ok = verified || via.includes("osc52");
  return { ok, via, verified };
}
