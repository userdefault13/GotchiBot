/**
 * Desk load runs hub-status once. The 30s status tick must not SSH.
 *   node --test tests/hub-snapshot-on-load.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const gotchi = readFileSync(join(root, "scripts/gotchibot"), "utf8");
const bar = readFileSync(join(root, "scripts/session-status-bar.sh"), "utf8");
const imac = readFileSync(join(root, "scripts/imac-status.mjs"), "utf8");

function fnBody(src, name) {
  const start = src.indexOf(`${name}() {`);
  assert.notEqual(start, -1, `${name} missing`);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed ${name}`);
}

describe("hub snapshot on desk load", () => {
  it("cmd_tmux starts hub-status in the background and does not exec it", () => {
    const tmux = fnBody(gotchi, "cmd_tmux");
    assert.match(tmux, /snapshot_hub_on_load/);
    const snap = fnBody(gotchi, "snapshot_hub_on_load");
    assert.match(snap, /scripts\/hub-status\.mjs/);
    assert.match(snap, /--json/);
    assert.match(snap, /&/);
    assert.equal(snap.includes("exec "), false);
    assert.equal(snap.includes("abra_or_node"), false);
  });

  it("the status-bar tick reads imac-status and does not call hub-status", () => {
    assert.match(bar, /imac-status\.mjs/);
    assert.equal(bar.includes("hub-status.mjs"), false);
  });

  it("keeps the 3-minute barLine cache", () => {
    assert.match(imac, /hubFetchedAt/);
    assert.match(imac, /3 \* 60_000/);
    assert.match(imac, /cached\.barLine/);
  });
});
