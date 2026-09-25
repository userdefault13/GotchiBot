/**
 * Original GotchiBot code. Rendering conventions chosen to match
 * Mobilecode-open's .message-content styles (it used react-markdown +
 * remark-gfm, which we do not bundle).
 *
 * Pure ES module — no DOM at import time.
 * Escape ALL HTML first; never emit event-handler attributes or javascript: URLs.
 */

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Only http:, https:, mailto: — returns null for anything else. */
function safeHref(url) {
  const u = String(url || "").trim();
  if (/^https?:\/\//i.test(u) || /^mailto:/i.test(u)) return u;
  return null;
}

function linkAttrs(href) {
  return `href="${escapeHtml(href)}" rel="noopener noreferrer" target="_blank"`;
}

/** Inline markdown on already-escaped text (no raw HTML from input). */
function renderLinks(s) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const start = s.indexOf("[", i);
    if (start < 0) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, start);
    const closeLabel = s.indexOf("](", start);
    if (closeLabel < 0) {
      out += s[start];
      i = start + 1;
      continue;
    }
    const label = s.slice(start + 1, closeLabel);
    let j = closeLabel + 2;
    let depth = 1;
    while (j < s.length && depth > 0) {
      const ch = s[j];
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      j += 1;
    }
    if (depth !== 0) {
      out += s[start];
      i = start + 1;
      continue;
    }
    const url = s.slice(closeLabel + 2, j - 1);
    const href = safeHref(url.replace(/&amp;/g, "&"));
    if (href) out += `<a ${linkAttrs(href)}>${label}</a>`;
    else out += label; // drop unsafe schemes entirely
    i = j;
  }
  return out;
}

function renderInline(escaped) {
  let s = escaped;

  // Inline code first (protect contents from further transforms)
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, code) => {
    const i = codes.length;
    codes.push(`<code>${code}</code>`);
    return `\u0000C${i}\u0000`;
  });

  // Links [text](url) with balanced parentheses in the URL
  s = renderLinks(s);

  // Bare http(s) URLs (not already inside an href="...")
  s = s.replace(/(^|[\s>(])((?:https?:\/\/)[^\s<]+)/gi, (full, pre, url) => {
    // Trim trailing punctuation commonly glued to URLs
    let u = url;
    let trail = "";
    while (/[.,;:!?)]$/.test(u)) {
      trail = u.slice(-1) + trail;
      u = u.slice(0, -1);
    }
    const href = safeHref(u.replace(/&amp;/g, "&"));
    if (!href) return full;
    // `u` is already HTML-escaped (whole body was escaped first).
    return `${pre}<a ${linkAttrs(href)}>${u}</a>${trail}`;
  });

  // Bold **text**
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // Strike ~~text~~
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  // Italic *text* or _text_ (single markers; avoid matching inside words for _)
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?!_)/g, "$1<em>$2</em>");

  // Restore inline code
  s = s.replace(/\u0000C(\d+)\u0000/g, (_, i) => codes[Number(i)]);

  // Single newlines → <br> (block layer handles paragraphs)
  return s;
}

function isHr(line) {
  return /^(-\s*){3,}$/.test(line) || /^(_\s*){3,}$/.test(line) || /^(\*\s*){3,}$/.test(line);
}

function renderBlocks(escaped) {
  const lines = escaped.split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // Fenced-code placeholders already expanded before this? We expand fences
    // at top level; here we only see placeholders as normal text if any remain.
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (isHr(line.trim())) {
      out.push("<hr>");
      i += 1;
      continue;
    }

    if (/^&gt;\s?/.test(line) || line.startsWith("> ")) {
      const quoteLines = [];
      while (i < lines.length && (/^&gt;\s?/.test(lines[i]) || lines[i].startsWith("> "))) {
        quoteLines.push(lines[i].replace(/^(&gt;|>)\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote>${renderInline(quoteLines.join("<br>"))}</blockquote>`);
      continue;
    }

    // Unordered list
    if (/^[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].replace(/^[-*+]\s+/, ""))}</li>`);
        i += 1;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].replace(/^\d+\.\s+/, ""))}</li>`);
        i += 1;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    // Paragraph: gather until blank line or block start
    const para = [];
    while (i < lines.length && lines[i].trim() !== "") {
      const L = lines[i];
      if (
        /^(#{1,4})\s+/.test(L) ||
        isHr(L.trim()) ||
        /^[-*+]\s+/.test(L) ||
        /^\d+\.\s+/.test(L) ||
        /^(&gt;|>)\s?/.test(L) ||
        L.startsWith("\u0000F")
      ) {
        break;
      }
      para.push(L);
      i += 1;
    }
    if (para.length) {
      out.push(`<p>${para.map(renderInline).join("<br>")}</p>`);
    }
  }

  return out.join("");
}

/**
 * @param {string} text
 * @returns {string} safe HTML
 */
export function renderMarkdown(text) {
  const raw = text == null ? "" : String(text);

  // Extract fenced code blocks before escaping
  const fences = [];
  const withPlaceholders = raw.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const i = fences.length;
    const langClean = String(lang || "")
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .slice(0, 32);
    fences.push({ lang: langClean, code: String(code).replace(/\n$/, "") });
    return `\n\n\u0000F${i}\u0000\n\n`;
  });

  const escaped = escapeHtml(withPlaceholders);

  // Replace fence placeholders with <pre><code>
  const withFences = escaped.replace(/\u0000F(\d+)\u0000/g, (_, idx) => {
    const f = fences[Number(idx)];
    if (!f) return "";
    const cls = f.lang ? ` class="language-${escapeHtml(f.lang)}"` : "";
    // code was escaped as part of the whole string… wait, the placeholder
    // replaced the raw fence before escape, so fence body was NOT escaped.
    // Escape it now.
    return `<pre><code${cls}>${escapeHtml(f.code)}</code></pre>`;
  });

  // Split around pre blocks so we don't markdown-parse inside them
  const parts = withFences.split(/(<pre><code[\s\S]*?<\/code><\/pre>)/);
  return parts
    .map((part) => {
      if (part.startsWith("<pre><code")) return part;
      return renderBlocks(part);
    })
    .join("");
}
