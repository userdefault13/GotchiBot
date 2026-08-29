#!/usr/bin/env node
/**
 * Copy stdin or argv text to clipboard (OSC 52 + verified pbcopy).
 *   echo hi | node scripts/clipboard-copy.mjs
 *   node scripts/clipboard-copy.mjs "text"
 */
import { spawnSync } from "node:child_process";
import { writeSync } from "node:fs";

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
  const r = spawnSync("/usr/bin/pbcopy", [], { input: text, encoding: "utf8", timeout: 3000 });
  if (r.status !== 0) return false;
  const check = spawnSync("/usr/bin/pbpaste", [], { encoding: "utf8", timeout: 3000 });
  return check.status === 0 && check.stdout === text;
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
if (writeOsc52(text)) via.push("osc52");
if (writePbcopy(text)) via.push("pbcopy");
if (!via.length) {
  console.error("clipboard-copy: failed");
  process.exit(1);
}
console.log(`ok ${via.join("+")} (${text.length} chars)`);
