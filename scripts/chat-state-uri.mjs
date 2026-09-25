/**
 * Pluggable stateUri schemes for chat snapshots.
 * Desk-side resolvers live elsewhere — this module stays dependency-free.
 */
import { isUlid } from "./chat-canonical.mjs";

const SCHEMES = Object.freeze({
  "gotchibot-hub": Object.freeze({
    name: "gotchibot-hub",
    supported: true,
    validateId(id) {
      return isUlid(id);
    },
  }),
  ipfs: Object.freeze({
    name: "ipfs",
    supported: false, // reserved — future encrypted IPFS
    validateId(id) {
      return typeof id === "string" && id.length > 0 && id.length <= 128;
    },
  }),
});

export function formatStateUri(scheme, id) {
  const s = String(scheme || "").trim().toLowerCase();
  const entry = SCHEMES[s];
  if (!entry) throw new Error(`unknown stateUri scheme: ${scheme}`);
  if (!entry.supported) throw new Error(`stateUri scheme not implemented: ${scheme}`);
  const sid = String(id || "").trim();
  if (!entry.validateId(sid)) throw new Error(`invalid id for scheme ${s}`);
  return `${s}://${sid}`;
}

/**
 * @returns {{ scheme: string, id: string, supported?: boolean } | null}
 */
export function parseStateUri(uri) {
  const raw = String(uri || "").trim();
  if (!raw) return null;
  const m = /^([a-z][a-z0-9+.-]*):\/\/(.+)$/i.exec(raw);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const id = m[2];
  const entry = SCHEMES[scheme];
  if (!entry) return { scheme, id, supported: false };
  if (!entry.validateId(id)) return null;
  return { scheme, id, supported: entry.supported };
}

/**
 * True only for registered non-http schemes that are public-safe.
 * http(s), .ts.net, 100.x, hostnames are NOT safe (stateUri goes on chain).
 */
export function isPublicSafeStateUri(uri) {
  const raw = String(uri || "").trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();
  if (lower.startsWith("http://") || lower.startsWith("https://")) return false;
  if (lower.includes(".ts.net")) return false;
  if (/(^|[/:])100\.\d{1,3}\.\d{1,3}\.\d{1,3}([/:?]|$)/.test(lower)) return false;
  // reject anything that looks like it embeds a hostname (has a dot after :// before /)
  const after = lower.includes("://") ? lower.split("://", 2)[1] : lower;
  if (after.includes(".") && !after.startsWith("bafy") && !/^Qm[1-9A-HJ-NP-Za-km-z]{44}/.test(after)) {
    // gotchibot-hub ULIDs have no dots; if there's a dot it's likely a hostname
    if (/\./.test(after.split("/")[0])) return false;
  }
  const parsed = parseStateUri(raw);
  if (!parsed || parsed.supported === false) return false;
  const entry = SCHEMES[parsed.scheme];
  return Boolean(entry && entry.supported);
}
