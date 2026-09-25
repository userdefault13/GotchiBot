/**
 * Token + request origin helpers (pure / unit-testable without Mongo).
 */
import { createHash, randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const PROXY_HEADERS = [
  "x-forwarded-for",
  "forwarded",
  "x-forwarded-host",
  "tailscale-user-login",
  "tailscale-headers-info",
  "tailscale-funnel-request",
];

export function hashToken(token) {
  return createHash("sha256").update(String(token), "utf8").digest("hex");
}

/** "gbd_" + base64url(32 random bytes) */
export function newDeskToken() {
  return `gbd_${randomBytes(32).toString("base64url")}`;
}

/** 8 Crockford chars → display as XXXX-XXXX */
export function newPairingCode() {
  const bytes = randomBytes(5);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  n = n & ((1n << 40n) - 1n);
  const chars = [];
  for (let i = 0; i < 8; i++) {
    chars.push(CROCKFORD[Number(n % 32n)]);
    n = n / 32n;
  }
  const raw = chars.reverse().join("");
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** Uppercase, no dash (normalize for hashing). */
export function normalizePairingCode(code) {
  return String(code || "")
    .toUpperCase()
    .replace(/-/g, "")
    .replace(/\s+/g, "");
}

export function isLoopbackAddress(addr) {
  if (!addr) return false;
  const a = String(addr).replace(/^::ffff:/i, "").toLowerCase();
  return a === "127.0.0.1" || a === "::1" || a === "localhost";
}

function headerGet(headers, name) {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === lower) {
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}

/**
 * @param {{ remoteAddress?: string|null, headers?: Record<string, string|string[]|undefined> }} req
 * @returns {{ direct: boolean, funnel: boolean, login: string|null }}
 */
export function classifyRequest({ remoteAddress, headers } = {}) {
  const funnelRaw = headerGet(headers, "tailscale-funnel-request");
  const funnel = funnelRaw != null && String(funnelRaw).trim() !== "";
  const loginRaw = headerGet(headers, "tailscale-user-login");
  const login =
    loginRaw != null && String(loginRaw).trim() ? String(loginRaw).trim() : null;

  let hasProxyHeader = false;
  for (const h of PROXY_HEADERS) {
    const v = headerGet(headers, h);
    if (v != null && String(v).trim() !== "") {
      hasProxyHeader = true;
      break;
    }
  }

  const loopback = isLoopbackAddress(remoteAddress);
  const direct = loopback && !hasProxyHeader;
  return { direct, funnel, login };
}

/**
 * @returns {{ ok: true } | { ok: false, status: number, error: string }}
 */
export function checkOrigin({ remoteAddress, headers } = {}, ownerLogin) {
  const { direct, funnel, login } = classifyRequest({ remoteAddress, headers });
  if (funnel) {
    return { ok: false, status: 403, error: "funnel not allowed" };
  }
  if (direct) return { ok: true };
  const expected =
    ownerLogin != null && String(ownerLogin).trim()
      ? String(ownerLogin).trim().toLowerCase()
      : null;
  if (!expected) {
    return {
      ok: false,
      status: 403,
      error: "owner login not configured — remote requests rejected",
    };
  }
  if (!login || login.toLowerCase() !== expected) {
    return {
      ok: false,
      status: 403,
      error: "Tailscale-User-Login required and must match hub owner",
    };
  }
  return { ok: true };
}
