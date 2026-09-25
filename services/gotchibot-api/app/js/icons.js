// SPDX-License-Identifier: Apache-2.0
// Adapted from Mobilecode-open web/src/Icons.tsx; modified: converted from React
// components to SVG strings. Upstream: https://github.com/elkir0/Mobilecode-open
// (commit b2ea0d5), itself derived from giuliastro/opencode-remote-android.

const ATTRS =
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

function svg(label, paths, size = 20) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" ${ATTRS} role="img" aria-label="${label}">${paths}</svg>`;
}

export const iconSettings = (size) =>
  svg(
    "Settings",
    `<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>`,
    size,
  );

export const iconMenu = (size) =>
  svg(
    "Menu",
    `<path d="M3 12h18"/><path d="M3 6h18"/><path d="M3 18h18"/>`,
    size,
  );

export const iconChevronLeft = (size) =>
  svg("Back", `<path d="M15 18l-6-6 6-6"/>`, size);

export const iconRefresh = (size) =>
  svg(
    "Refresh",
    `<path d="M21 12a9 9 0 0 1-15.36 6.36L3 15"/><path d="M3 21v-6h6"/><path d="M3 12a9 9 0 0 1 15.36-6.36L21 9"/><path d="M21 3v6h-6"/>`,
    size,
  );

export const iconLink = (size) =>
  svg(
    "Link",
    `<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>`,
    size,
  );

/** Unlink — same stroke style as LinkIcon; original for GotchiBot viewer. */
export const iconUnlink = (size) =>
  svg(
    "Unlink",
    `<path d="M18.84 12.25l1.72-1.71a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M5.16 11.75l-1.72 1.71a5 5 0 0 0 7.07 7.07l1.72-1.71"/><line x1="2" y1="2" x2="22" y2="22"/>`,
    size,
  );

/** Camera — original; Lucide-style paths matching Icons.tsx stroke conventions. */
export const iconCamera = (size) =>
  svg(
    "Camera",
    `<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>`,
    size,
  );

/** QR — original placeholder glyph for the pair scanner. */
export const iconQr = (size) =>
  svg(
    "QR",
    `<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3z"/><path d="M20 14v6h-6"/><path d="M14 20h2"/>`,
    size,
  );

/** Plus — new thread; Lucide-style stroke matching Icons.tsx conventions. */
export const iconPlus = (size) =>
  svg("New", `<path d="M12 5v14"/><path d="M5 12h14"/>`, size);

/** Send — composer submit; Lucide-style paper plane. */
export const iconSend = (size) =>
  svg(
    "Send",
    `<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/>`,
    size,
  );
