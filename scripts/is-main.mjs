/**
 * Was this module executed directly, or imported by something else?
 *
 *   import { isMainModule } from "./is-main.mjs";
 *   if (isMainModule(import.meta.url)) main();
 *
 * Both sides are compared as real paths. Node resolves import.meta.url through
 * symlinks, while process.argv[1] is whatever the caller typed, so comparing
 * them directly makes a script silently do nothing whenever it is reached
 * through a symlink — /tmp -> /private/tmp on macOS, a symlinked checkout, a
 * global npm bin shim. The failure is invisible: main() never runs and the
 * process exits 0.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isMainModule(metaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
