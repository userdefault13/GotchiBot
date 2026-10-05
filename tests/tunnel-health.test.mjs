/**
 * Status bar "tun": the home tunnel, not the retired mainnet subgraph.
 *   node --test tests/tunnel-health.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

describe("tunnel health", () => {
  it("judges the tunnel by tunnelHealth, with the mainnet subgraph informational only", () => {
    const cfg = JSON.parse(read("config/subgraph.endpoints.json"));
    assert.match(cfg.tunnelHealth, /^https:\/\/.+\/health$/);
    const src = read("scripts/tunnel-health.mjs");
    assert.match(src, /const tunnelOk = home\.ok;/);
    assert.match(src, /mainnet subgraph \(retired, info only\)/);
  });
});
