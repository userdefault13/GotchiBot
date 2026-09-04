/**
 * Safety-logic tests for scripts/browser-tool.mjs — no Playwright required.
 *   node --test tests/browser-tool.test.mjs
 *
 * These import the real helpers. An earlier version of this suite re-declared
 * copies of isHostAllowed/maskValue inside the test file, so 16 tests passed
 * green while never touching the module — and the copies had drifted from it
 * (they took bare hostnames; the real gate takes a URL).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ALLOWLIST_PATH,
  ALLOWED_HOSTS,
  BLOCKED_CLICK_PATTERNS,
  SENSITIVE_FIELD_PATTERNS,
  isHostAllowed,
  findBlockedPattern,
  isSensitiveField,
  maskValue,
} from "../scripts/browser-tool.mjs";

const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8"));

describe("allowlist wiring", () => {
  it("reads the keys config/browser.allowlist.json actually uses", () => {
    assert.deepEqual(ALLOWED_HOSTS, allowlist.allowedHosts);
    assert.deepEqual(BLOCKED_CLICK_PATTERNS, allowlist.blockedClickPatterns);
    assert.deepEqual(SENSITIVE_FIELD_PATTERNS, allowlist.sensitiveFieldPatterns);
  });

  it("enforces every configured click pattern, not a hardcoded subset", () => {
    for (const pattern of allowlist.blockedClickPatterns) {
      assert.equal(findBlockedPattern(pattern), pattern, `"${pattern}" must be gated`);
    }
  });
});

describe("isHostAllowed", () => {
  it("allows loopback", () => {
    assert.equal(isHostAllowed("http://localhost:3000/x"), true);
    assert.equal(isHostAllowed("http://127.0.0.1/"), true);
    assert.equal(isHostAllowed("http://[::1]:8080/"), true);
  });

  it("matches *.domain.com against subdomains", () => {
    assert.equal(isHostAllowed("https://subgraph.aarcadeghst.com/graphql"), true);
  });

  it("blocks hosts that are not listed", () => {
    assert.equal(isHostAllowed("https://evil.com"), false);
    assert.equal(isHostAllowed("https://unknown.example.com"), false);
  });

  it("is not fooled by an allowed host appearing in the path or query", () => {
    assert.equal(isHostAllowed("https://evil.com/?x=subgraph.aarcadeghst.com"), false);
    assert.equal(isHostAllowed("https://evil.com/subgraph.aarcadeghst.com"), false);
  });

  it("rejects unparseable input rather than guessing", () => {
    assert.equal(isHostAllowed("subgraph.aarcadeghst.com"), false);
    assert.equal(isHostAllowed(""), false);
    assert.equal(isHostAllowed("not a url"), false);
  });
});

describe("findBlockedPattern", () => {
  it("matches case-insensitively and inside a longer selector", () => {
    assert.equal(findBlockedPattern("#Checkout-button"), "checkout");
    assert.equal(findBlockedPattern("button[aria-label='Pay Now']"), "pay now");
  });

  it("leaves harmless targets alone", () => {
    assert.equal(findBlockedPattern("Organic Avocados"), null);
    assert.equal(findBlockedPattern("#search"), null);
    assert.equal(findBlockedPattern(""), null);
  });
});

describe("isSensitiveField", () => {
  it("flags credential and payment fields", () => {
    assert.equal(isSensitiveField("#password"), true);
    assert.equal(isSensitiveField("input[name=cvv]"), true);
    assert.equal(isSensitiveField("#cc-number"), true);
    assert.equal(isSensitiveField("[data-test=api-token]"), true);
  });

  it("leaves ordinary fields alone", () => {
    assert.equal(isSensitiveField("#search"), false);
    assert.equal(isSensitiveField("input[name=quantity]"), false);
    assert.equal(isSensitiveField(""), false);
  });
});

describe("maskValue", () => {
  it("masks passwords outright", () => {
    assert.equal(maskValue("s3cr3t", "password"), "****");
  });

  it("keeps only the first and last four digits of a card number", () => {
    assert.equal(maskValue("1234567812345678", "text"), "1234********5678");
  });

  it("masks expiry and cvv", () => {
    assert.equal(maskValue("12/25", "text"), "**/**");
    assert.equal(maskValue("123", "text"), "***");
    assert.equal(maskValue("1234", "text"), "****");
  });

  it("masks emails but keeps the shape readable", () => {
    assert.equal(maskValue("user@example.com", "email"), "u****@e****.com");
  });

  it("leaves ordinary text and empty values untouched", () => {
    assert.equal(maskValue("Organic Avocados", "text"), "Organic Avocados");
    assert.equal(maskValue("", "password"), "");
  });
});
