/**
 * Deterministic JSON + contentHash + ULID for gotchibot chat snapshots.
 * Shared by Hub API and desk — keep dependency-free (node builtins only).
 */
import { createHash, randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function sortKeysDeep(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("canonicalJson: non-finite number");
    }
    if (value instanceof Date) return value.toISOString();
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((v) => sortKeysDeep(v));
  }
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const v = value[key];
    if (v === undefined) continue;
    out[key] = sortKeysDeep(v);
  }
  return out;
}

/** Deterministic JSON: recursive key sort (code-point), drop undefined, Date→ISO, no whitespace. */
export function canonicalJson(value) {
  return JSON.stringify(sortKeysDeep(value));
}

/** "0x" + sha256hex(canonicalJson) — 32 bytes on-chain bytes32 stateHash. */
export function contentHashOf(value) {
  const hex = createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
  return `0x${hex}`;
}

function encodeTime(ms) {
  let t = BigInt(ms);
  const chars = [];
  for (let i = 0; i < 10; i++) {
    chars.push(CROCKFORD[Number(t % 32n)]);
    t = t / 32n;
  }
  return chars.reverse().join("");
}

function encodeRandom(buf) {
  // 80 bits → 16 Crockford chars
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  const chars = [];
  for (let i = 0; i < 16; i++) {
    chars.push(CROCKFORD[Number(n % 32n)]);
    n = n / 32n;
  }
  return chars.reverse().join("");
}

/** 26-char Crockford base32 ULID (48-bit ms + 80-bit crypto random). */
export function ulid(now = Date.now()) {
  const ms = typeof now === "number" ? now : Date.now();
  return encodeTime(ms) + encodeRandom(randomBytes(10));
}

export function isUlid(s) {
  if (typeof s !== "string" || s.length !== 26) return false;
  const upper = s.toUpperCase();
  for (const ch of upper) {
    if (!CROCKFORD.includes(ch)) return false;
  }
  return true;
}
