#!/usr/bin/env node
/**
 * Copy stdin or argv text to clipboard (OSC 52 + verified pbcopy on local macOS).
 * Over SSH / non-darwin: prefer OSC 52; optional wl-copy/xclip on Linux with a display.
 *   echo hi | node scripts/clipboard-copy.mjs
 *   node scripts/clipboard-copy.mjs "text"
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { writeSync } from "node:fs";
import { isOverSsh, macGuiAvailable } from "./lib/platform-guard.mjs";

function writeOsc52(text) {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  if (b64.length > 140_000) return false;
  const payload = `\x1b]52;c;${b64}\x07`;
  try {
    writeSync(1, payload);
    return true;
  } catch {
    return false;
  }
}

function writePbcopy(text) {
  if (!existsSync("/usr/bin/pbcopy")) return false;
  const r = spawnSync("/usr/bin/pbcopy", [], { input: text, encoding: "utf8", timeout: 3000 });
  if (r.status !== 0) return false;
  const check = spawnSync("/usr/bin/pbpaste", [], { encoding: "utf8", timeout: 3000 });
  return check.status === 0 && check.stdout === text;
}

function which(bin) {
  const r = spawnSync("command", ["-v", bin], { encoding: "utf8", shell: true });
  return r.status === 0 && (r.stdout || "").trim();
}

/** Linux clipboard helpers — only when a display is present and the tool exists. */
function writeLinuxClipboard(text) {
  if (!process.env.WAYLAND_DISPLAY && !process.env.DISPLAY) return false;
  if (which("wl-copy")) {
    const r = spawnSync("wl-copy", [], { input: text, encoding: "utf8", timeout: 3000 });
    if (r.status === 0) return true;
  }
  if (which("xclip")) {
    const r = spawnSync("xclip", ["-selection", "clipboard"], {
      input: text,
      encoding: "utf8",
      timeout: 3000,
    });
    if (r.status === 0) return true;
  }
  return false;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

const argText = process.argv.slice(2).join(" ");
const text = argText || (await readStdin());
if (!text) {
  console.error("clipboard-copy: empty input");
  process.exit(1);
}

const via = [];
const overSsh = isOverSsh();
const localMac = macGuiAvailable();

// Prefer OSC 52 always (works over SSH); local macOS also verifies via pbcopy.
if (writeOsc52(text)) via.push("osc52");

if (localMac) {
  if (writePbcopy(text)) via.push("pbcopy");
} else if (!overSsh && process.platform === "linux") {
  if (writeLinuxClipboard(text)) via.push("linux");
}
// Over SSH / non-darwin with no display: OSC 52 alone is enough when written.

if (!via.length) {
  console.error("clipboard-copy: failed");
  process.exit(1);
}
console.log(`ok ${via.join("+")} (${text.length} chars)`);
