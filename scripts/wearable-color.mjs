/**
 * Marketplace wearable ASCII, colored from the official item sprite.
 *
 * Each non-space glyph was sampled from the painted cells of
 * https://app.aavegotchi.com/images/items/{id}.svg (majority opaque fill,
 * half-blocks sample the half they draw). The resulting span markup is stored
 * on the wearable. This module does not fetch SVGs and does not recolor from
 * collateral primary/secondary.
 */

/**
 * Inner HTML for a wearable <pre>. Null means leave the ASCII uncolored
 * (no stored sprite markup, or the markup's text does not match the ASCII).
 * @param {string} ascii
 * @param {{ markup?: string }} wearable
 * @returns {string | null}
 */
export function wearableMarkup(ascii, wearable = {}) {
  const markup = wearable && typeof wearable.markup === "string" ? wearable.markup : "";
  if (!markup) return null;
  const stripped = markup.replace(/<span style="color:#[0-9a-f]{6}">[^<]*<\/span>/g, "");
  if (stripped.includes("<") || stripped.includes(">")) return null;
  const text = markup
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
  if (text !== String(ascii ?? "")) return null;
  return markup;
}
