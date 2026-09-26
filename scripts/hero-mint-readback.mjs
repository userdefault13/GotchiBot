/**
 * Pure helpers for Sepolia/SIM mint readback — before/after hero list diff.
 * No network. Used by onboarding-gate + unit tests.
 */

/**
 * Pick the new hero id after a successful bind.
 *
 * @param {{
 *   beforeIds: string[],
 *   afterIds: string[],
 *   hintIncludes?: string|null,
 *   preferredId?: string|null,
 * }} opts
 * @returns {{ id: string|null, source: "confirmed"|"readback"|"guess"|"none", note: string|null, candidates?: string[] }}
 */
export function pickNewHeroFromDiff({
  beforeIds = [],
  afterIds = [],
  hintIncludes = null,
  preferredId = null,
} = {}) {
  const before = new Set((beforeIds || []).map(String));
  const after = (afterIds || []).map(String);
  const preferred = preferredId != null ? String(preferredId) : null;
  const hint = hintIncludes != null ? String(hintIncludes) : null;

  if (preferred && after.includes(preferred)) {
    return { id: preferred, source: "confirmed", note: null };
  }

  const added = after.filter((id) => !before.has(id));

  if (hint) {
    const hits = added.filter((id) => id.includes(hint));
    if (preferred && hits.includes(preferred)) {
      return { id: preferred, source: "readback", note: null };
    }
    if (hits.length === 1) {
      return { id: hits[0], source: "readback", note: null };
    }
    if (hits.length > 1) {
      return {
        id: hits[0],
        source: "readback",
        note: `multiple new ids matched hint "${hint}"; picked ${hits[0]}`,
        candidates: hits,
      };
    }
  }

  if (added.length === 1) {
    return { id: added[0], source: "readback", note: null };
  }

  if (preferred) {
    return {
      id: preferred,
      source: "guess",
      note: "readback failed — using computed id",
      candidates: added,
    };
  }

  return {
    id: null,
    source: "none",
    note: "no new hero id found",
    candidates: added,
  };
}

/**
 * Interpret a bindOwned/bindStarter result object (never throws).
 *
 * @param {{ ok?: boolean, code?: string, error?: string, txHash?: string }|null|undefined} bound
 * @returns {{ ok: boolean, code: string|null, error: string|null, txHash: string|null }}
 */
export function interpretBindResult(bound) {
  if (!bound || typeof bound !== "object") {
    return { ok: false, code: "NO_RESULT", error: "no bind result", txHash: null };
  }
  if (bound.ok) {
    return {
      ok: true,
      code: null,
      error: null,
      txHash: bound.txHash ? String(bound.txHash) : null,
    };
  }
  const code = bound.code ? String(bound.code) : "BIND_FAILED";
  const error = bound.error ? String(bound.error) : "bind failed";
  return { ok: false, code, error, txHash: null };
}
