/**
 * Pure-helper tests for scripts/browser-tool.mjs — no playwright required.
 *   node --test tests/browser-tool.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  loadAllowlist,
  isHostAllowed,
  findBlockedPattern,
  maskSensitive,
  isSensitiveField,
} from "../scripts/browser-tool.mjs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWLIST_PATH = resolve(ROOT, "config/browser.allowlist.json");

describe("loadAllowlist", () => {
  it("loads allowedHosts and gate patterns from config", () => {
    const cfg = loadAllowlist(ALLOWLIST_PATH);
    assert.ok(cfg.allowedHosts.includes("localhost"));
    assert.ok(cfg.blockedClickPatterns.includes("checkout"));
    assert.ok(cfg.sensitiveFieldPatterns.includes("password"));
  });
});

describe("isHostAllowed", () => {
  const list = ["localhost", "127.0.0.1", "::1", "*.aarcadeghst.com"];

  it("accepts localhost / 127.0.0.1 / ::1", () => {
    assert.equal(isHostAllowed("localhost", list), true);
    assert.equal(isHostAllowed("127.0.0.1", list), true);
    assert.equal(isHostAllowed("::1", list), true);
  });

  it("accepts aarcadeghst subdomains via wildcard", () => {
    assert.equal(isHostAllowed("subgraph.aarcadeghst.com", list), true);
    assert.equal(isHostAllowed("cartridge.aarcadeghst.com", list), true);
    assert.equal(isHostAllowed("a.b.aarcadeghst.com", list), true);
  });

  it("rejects off-allowlist hosts", () => {
    assert.equal(isHostAllowed("staterbros.com", list), false);
    assert.equal(isHostAllowed("evil.example", list), false);
    assert.equal(isHostAllowed("example.com", list), false);
  });

  it("strips port before matching", () => {
    assert.equal(isHostAllowed("localhost:3000", list), true);
    assert.equal(isHostAllowed("127.0.0.1:8080", list), true);
    assert.equal(isHostAllowed("subgraph.aarcadeghst.com:443", list), true);
    assert.equal(isHostAllowed("staterbros.com:443", list), false);
  });

  it("is case-insensitive", () => {
    assert.equal(isHostAllowed("LocalHost", list), true);
    assert.equal(isHostAllowed("SubGraph.AarcadeGhst.COM", list), true);
  });
});

describe("findBlockedPattern", () => {
  const patterns = [
    "submit",
    "checkout",
    "place-order",
    "place order",
    "purchase",
    "buy",
    "pay now",
    "complete order",
  ];

  it("matches #checkout selector", () => {
    assert.equal(findBlockedPattern("#checkout", patterns), "checkout");
  });

  it("matches Place order text", () => {
    assert.equal(findBlockedPattern("button Place order", patterns), "place order");
  });

  it("allows safe search button", () => {
    assert.equal(findBlockedPattern("button search", patterns), null);
  });

  it("confirm phrase path: pattern still found (gate bypass is caller's job)", () => {
    const hit = findBlockedPattern("#checkout", patterns);
    assert.ok(hit);
    const confirm = "checkout now";
    assert.ok(confirm.length > 0); // non-empty --confirm allows the click
  });
});

describe("maskSensitive / isSensitiveField", () => {
  it("masks password field values by field meta", () => {
    const meta = { name: "password", type: "password" };
    assert.equal(isSensitiveField(meta), true);
    assert.equal(maskSensitive("hunter2", meta), "***");
  });

  it("masks 16-digit card-like strings", () => {
    assert.equal(maskSensitive("4111111111111111", {}), "***");
    assert.equal(maskSensitive("4111-1111-1111-1111", {}), "***");
  });

  it("leaves non-sensitive search query untouched", () => {
    assert.equal(maskSensitive("search query", { name: "q", type: "text" }), "search query");
  });

  it("sensitive-field heuristic on name/id/autocomplete", () => {
    assert.equal(isSensitiveField({ name: "user_password" }), true);
    assert.equal(isSensitiveField({ id: "cc-number" }), true);
    assert.equal(isSensitiveField({ autocomplete: "cc-csc" }), true);
    assert.equal(isSensitiveField({ name: "q", id: "search" }), false);
  });
});
