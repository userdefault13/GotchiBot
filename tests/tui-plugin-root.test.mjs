/**
 * TUI plugins keep GotchiBot's state in GotchiBot's own sessions/, whatever
 * folder OpenCode was opened in (it used to write logs into other repos).
 *   node --test tests/tui-plugin-root.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), ".opencode", "tui-plugins");

describe("tui plugin root", () => {
  it("no plugin roots itself at the folder OpenCode was opened in", () => {
    for (const f of readdirSync(dir).filter((n) => /\.(ts|tsx)$/.test(n))) {
      const src = readFileSync(path.join(dir, f), "utf8");
      if (!/"sessions"|scripts/.test(src)) continue;
      assert.doesNotMatch(src, /state\?\.path\?\.directory|\(api as any\)\.directory/, `${f} must not use the opened folder as GotchiBot's root`);
    }
  });

  it("each plugin that reads or writes sessions/ resolves GotchiBot's own folder", () => {
    for (const f of readdirSync(dir).filter((n) => /\.(ts|tsx)$/.test(n))) {
      const src = readFileSync(path.join(dir, f), "utf8");
      if (!/join\([^)]*"sessions"/.test(src)) continue;
      assert.match(src, /function gotchiRoot\(\)|GOTCHIBOT_ROOT \|\| resolve\(dirname\(fileURLToPath\(import\.meta\.url\)\)/, `${f}`);
    }
  });
});
