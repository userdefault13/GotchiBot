/**
 * GotchiBot Browser Tool — Unit tests for safety logic (allowlist, confirm-gate, masking).
 * 
 * These tests mock/simulate the browser layer and pass WITHOUT Playwright installed.
 * They verify the safety logic is correct pre-install.
 */

import { strict as assert } from "node:assert";
import { describe, it, beforeEach } from "node:test";
import { readFileSync } from "node:fs";

const ROOT = "/Users/juliuswong/Dev/GotchiBot";

// Helper: read the allowlist
function readAllowlist() {
  const path = `${ROOT}/config/browser.allowlist.json`;
  return JSON.parse(readFileSync(path, "utf8"));
}

// Helper: is host allowed (copied from browser-tool logic)
function isHostAllowed(hostname) {
  const allowlist = readAllowlist();
  const hosts = allowlist.hosts || ["localhost", "127.0.0.1", ".aarcadeghst.com"];
  if (hostname === "localhost" || hostname === "127.0.0.1") return true;
  for (const pattern of hosts) {
    if (pattern.startsWith(".")) {
      // Pattern ".aarcadeghst.com" matches hostnames ending with that suffix
      // e.g. subgraph.aarcadeghst.com, but NOT bare aarcadeghst.com
      if (hostname === pattern || hostname.endsWith(pattern)) return true;
    } else if (hostname === pattern) {
      return true;
    }
  }
  return false;
}

// Helper: destructive pattern check (copied from browser-tool logic)
function checkDestructivePattern(refOrSelector, destructivePatterns) {
  for (const pattern of destructivePatterns) {
    const regex = new RegExp(pattern, "i");
    if (regex.test(refOrSelector)) return pattern;
  }
  return null;
}

// Helper: mask value (copied from browser-tool logic)
function maskValue(value, type) {
  if (!value) return value;
  const val = String(value);
  if (type === "password") return "****";
  if (/\d{16}/.test(val)) {
    // Keep first 4, mask middle 8 with 8 stars, keep last 4: 1234567812345678 → 1234********5678
    // 4 + 8 + 4 = 16, preserving length
    return val.replace(/(\d{4})\d{8}(\d{4})/, "$1********$2");
  }
  if (/\d{2}\/\d{2}/.test(val)) return val.replace(/\d/g, "*");
  if (/\d{3,4}$/.test(val)) return val.replace(/\d/g, "*");
  if (type === "email") {
    // Email mask: first char of local + "****" + "@" + first char of domain + "****." + TLD
    // e.g. user@example.com → u****@e****.com
    const parts = val.split("@");
    if (parts.length === 2) {
      const [local, domain] = parts;
      const maskedLocal = local ? local[0] + "****" : "****";
      const domainParts = domain.split(".");
      if (domainParts.length === 2) {
        const [domainName, tld] = domainParts;
        const maskedDomain = domainName ? domainName[0] + "****." + tld : "****.*" + tld;
        return maskedLocal + "@" + maskedDomain;
      }
      // Fallback: mask all but TLD
      const tld = domain.split(".").pop() || "";
      return maskedLocal + "@" + domain.replace(/./g, "*").replace(/\*\.(\w+)$/, ".$1");
    }
    return val;
  }
  return val;
}

// --- Tests ---

describe("Browser Tool Safety Logic", () => {
  let allowlist;

  beforeEach(() => {
    allowlist = readAllowlist();
  });

  describe("Host allowlist", () => {
    it("allows localhost", () => {
      assert.strictEqual(isHostAllowed("localhost"), true);
    });

    it("allows 127.0.0.1", () => {
      assert.strictEqual(isHostAllowed("127.0.0.1"), true);
    });

    it("allows .aarcadeghst.com subdomain", () => {
      // Pattern ".aarcadeghst.com" matches hostnames ending with that suffix
      assert.strictEqual(isHostAllowed("subgraph.aarcadeghst.com"), true);
    });

    it("blocks unknown host", () => {
      assert.strictEqual(isHostAllowed("evil.com"), false);
    });

    it("blocks unknown subdomain", () => {
      assert.strictEqual(isHostAllowed("unknown.example.com"), false);
    });
  });

  describe("Destructive pattern gate", () => {
    it("matches 'checkout' pattern on a checkout button ref", () => {
      const patterns = allowlist.destructivePatterns || ["submit", "checkout", "place-order", "purchase", "buy"];
      const result = checkDestructivePattern("checkout-button", patterns);
      assert.strictEqual(result, "checkout");
    });

    it("matches 'buy' pattern on buy text", () => {
      const patterns = ["submit", "checkout", "place-order", "purchase", "buy"];
      const result = checkDestructivePattern("buy-now", patterns);
      assert.strictEqual(result, "buy");
    });

    it("matches 'place-order' pattern (earlier in array than purchase)", () => {
      const patterns = ["submit", "checkout", "place-order", "purchase", "buy"];
      // "place-order" appears before "purchase" in the array, so it matches first
      const result = checkDestructivePattern("place-order-btn", patterns);
      assert.strictEqual(result, "place-order");
    });

    it("matches 'buy' pattern when place-order and purchase not present", () => {
      const patterns = ["submit", "checkout", "buy"];
      const result = checkDestructivePattern("buy-now", patterns);
      assert.strictEqual(result, "buy");
    });

    it("no match for benign element", () => {
      const patterns = ["submit", "checkout", "place-order", "purchase", "buy"];
      const result = checkDestructivePattern("save-button", patterns);
      assert.strictEqual(result, null);
    });
  });

  describe("Masking", () => {
    it("masks password values", () => {
      assert.strictEqual(maskValue("s3cr3t", "password"), "****");
    });

    it("masks 16-digit card numbers (keep first 4 + last 4, mask middle, preserve length)", () => {
      const result = maskValue("1234567812345678", "text");
      // 1234 5678 1234 5678 → 1234********5678 (4 + 8 stars + 4 = 16 chars)
      assert.strictEqual(result, "1234********5678");
    });

    it("masks expiry MM/YY", () => {
      assert.strictEqual(maskValue("12/25", "text"), "**/**");
    });

    it("masks CVV", () => {
      assert.strictEqual(maskValue("123", "text"), "***");
      assert.strictEqual(maskValue("1234", "text"), "****");
    });

    it("masks email (first char local + **** + first char domain + **** . TLD)", () => {
      const result = maskValue("user@example.com", "email");
      // Expected: "u****@e****.com"
      assert.strictEqual(result, "u****@e****.com");
    });

    it("passes through non-sensitive values", () => {
      assert.strictEqual(maskValue("Organic Avocados", "text"), "Organic Avocados");
    });
  });
});