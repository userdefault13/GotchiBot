/**
 * Marketplace wearable ASCII, colored the same way as Link Cube / gotchi body art.
 *
 * Solid blocks (PRIMARY_CHARS, including ▀ ▄ ▓ █) → collateral primary.
 * Lighter hatch (SECONDARY_CHARS, ▒ ░) → collateral secondary.
 * Colors come from the collateral library for the template's bound gotchi.
 * No bound gotchi, or a gotchi with neither color, stays uncolored.
 */
import { findCollateralColors, hexNormalize } from "./collateral-resolve.mjs";
import { PRIMARY_CHARS, SECONDARY_CHARS } from "./gotchi-art.mjs";

export { PRIMARY_CHARS, SECONDARY_CHARS };

/**
 * @param {{ gotchiId?: string, collateral?: string, hauntId?: number }} row
 * @returns {{ gotchiId: string, primary?: string, secondary?: string } | null}
 */
export function resolveBoundWearableColors(row) {
  if (!row || typeof row !== "object") return null;
  const gotchiId = String(row.gotchiId || "").trim();
  if (!gotchiId) return null;
  const colors = findCollateralColors(row.collateral || row.spirit || "", row.hauntId ?? 1);
  const primary = hexNormalize(colors?.primary);
  const secondary = hexNormalize(colors?.secondary);
  if (!primary && !secondary) return { gotchiId };
  return {
    gotchiId,
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
  };
}

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Inner HTML for a wearable <pre>. Null means leave the ASCII uncolored
 * (no bound gotchi, or no collateral primary/secondary).
 * @param {string} ascii
 * @param {{ gotchiId?: string, primary?: string, secondary?: string }} wearable
 * @returns {string | null}
 */
export function wearableMarkup(ascii, wearable = {}) {
  const gotchiId = wearable && String(wearable.gotchiId || "").trim();
  const primary = hexNormalize(wearable && wearable.primary);
  const secondary = hexNormalize(wearable && wearable.secondary);
  if (!gotchiId || (!primary && !secondary)) return null;
  const primarySet = new Set(PRIMARY_CHARS);
  const secondarySet = new Set(SECONDARY_CHARS);
  const parts = [];
  let buf = "";
  let mode = null;
  const flush = () => {
    if (!buf) return;
    const esc = escapeHtml(buf);
    if (mode === "p" && primary) parts.push(`<span style="color:#${primary}">${esc}</span>`);
    else if (mode === "s" && secondary) parts.push(`<span style="color:#${secondary}">${esc}</span>`);
    else parts.push(esc);
    buf = "";
  };
  for (const ch of String(ascii || "")) {
    const next =
      ch === "\n" ? "n" : primary && primarySet.has(ch) ? "p" : secondary && secondarySet.has(ch) ? "s" : "";
    if (next !== mode) {
      flush();
      mode = next;
    }
    buf += ch;
  }
  flush();
  return parts.join("");
}
