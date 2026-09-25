/**
 * Pairing-code helpers for the GotchiBot phone PWA.
 * Pure ES module — no DOM at import time; importable from Node tests.
 * Crockford base32 alphabet: 0-9 A-Z excluding I L O U.
 */

const CROCKFORD_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/** Uppercase, strip spaces/dashes, map lookalikes O→0, I/L→1. */
export function normalizeCode(s) {
  return String(s ?? "")
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

/** Format as XXXX-XXXX (after normalize). */
export function formatCode(s) {
  const n = normalizeCode(s);
  if (n.length <= 4) return n;
  return `${n.slice(0, 4)}-${n.slice(4, 8)}`;
}

/** True when normalized form is exactly 8 Crockford base32 chars. */
export function isValidCode(s) {
  return CROCKFORD_RE.test(normalizeCode(s));
}

/**
 * Parse location.hash forms like "#pair=ABCD-EFGH".
 * Also tolerates "#/pair?code=…" if present. Returns formatted code or null.
 */
export function parsePairHash(hash) {
  const h = String(hash ?? "");
  let raw = null;
  const pairEq = h.match(/#pair=([^&#]+)/i);
  if (pairEq) {
    try {
      raw = decodeURIComponent(pairEq[1]);
    } catch {
      raw = pairEq[1];
    }
  } else {
    const slash = h.match(/#\/pair\?([^#]*)/i);
    if (slash) {
      try {
        const params = new URLSearchParams(slash[1]);
        raw = params.get("code");
      } catch {
        raw = null;
      }
    }
  }
  if (raw == null || raw === "") return null;
  if (!isValidCode(raw)) return null;
  return formatCode(raw);
}

/**
 * Extract a pairing code from a scanned deep link
 * (https://host/app/#pair=CODE, any host) or a raw code. Null otherwise.
 */
export function extractCodeFromScan(text) {
  const t = String(text ?? "").trim();
  if (!t) return null;

  if (t.includes("#")) {
    const hashIdx = t.indexOf("#");
    const fromHash = parsePairHash(t.slice(hashIdx));
    if (fromHash) return fromHash;
  }

  try {
    const u = new URL(t);
    if (u.hash) {
      const fromUrl = parsePairHash(u.hash);
      if (fromUrl) return fromUrl;
    }
  } catch {
    /* not a URL */
  }

  if (isValidCode(t)) return formatCode(t);
  return null;
}
