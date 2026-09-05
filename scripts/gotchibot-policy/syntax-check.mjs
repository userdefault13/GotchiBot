/**
 * Syntax gate for files this repo ships.
 *   .mjs / .js / .cjs  → node --check
 *   .sh / .bash        → bash -n
 *   .json              → JSON.parse
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { extname } from "node:path";

/**
 * @param {string} file
 * @returns {string | null} error reason, or null if ok / nothing to check
 */
export function checkFileSyntax(file) {
  if (!file) return null;

  let ext = extname(file).toLowerCase();
  if (!ext) {
    try {
      const shebang = readFileSync(file, "utf8").split("\n", 1)[0];
      if (/^#!.*\b(bash|sh|zsh)\b/.test(shebang)) ext = ".sh";
      else if (/^#!.*\bnode\b/.test(shebang)) ext = ".mjs";
    } catch {
      return null;
    }
  }

  if (ext === ".mjs" || ext === ".js" || ext === ".cjs") {
    const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8", timeout: 15000 });
    if (r.status !== 0) {
      return `node --check failed on ${file}:\n${(r.stderr || "").trim().slice(0, 1500)}\nFix the syntax before continuing.`;
    }
  } else if (ext === ".sh" || ext === ".bash") {
    const r = spawnSync("bash", ["-n", file], { encoding: "utf8", timeout: 15000 });
    if (r.status !== 0) {
      return `bash -n failed on ${file}:\n${(r.stderr || "").trim().slice(0, 1500)}\nFix the syntax before continuing.`;
    }
  } else if (ext === ".json") {
    try {
      JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      return (
        `${file} is not valid JSON: ${e?.message || e}\n` +
        `A malformed settings/registry file fails silently — fix it before continuing.`
      );
    }
  }
  return null;
}
