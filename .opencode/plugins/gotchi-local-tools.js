/**
 * /local — loader. The hooks live in ../lib/local-tools-hooks.js and are imported
 * with the file's mtime as a version stamp, so the Hub's OpenCode picks up a
 * changed hook on an in-place reload (POST /instance/dispose) — a plain import is
 * cached for the life of the process, and a full restart needs the Hub's vault
 * unlocked. Only the plugin function is exported: OpenCode calls every export.
 */
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "local-tools-hooks.js");

export const GotchiLocalTools = async () => {
  let v = 0;
  try {
    v = Math.round(statSync(HOOKS).mtimeMs);
  } catch {}
  const mod = await import(`${pathToFileURL(HOOKS).href}?v=${v}`);
  return mod.localToolsHooks();
};
