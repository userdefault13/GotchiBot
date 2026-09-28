/**
 * Pure helpers for the desk views (portfolio, project chat, avatar pane).
 * No DOM at import time; importable from Node tests.
 */

/** Sentinel "project" for chats that belong to no pstack room. */
export const GENERAL = "_general";
/** Hash sentinel for a draft (unsaved) thread — first send omits threadId. */
export const NEW_THREAD_ID = "new";

/** Same letters as the kanban ASCII thumbs (assets/gotchi-kanban.ascii). */
const SPIRIT_CHARS = {
  dai: "D",
  link: "L",
  wbtc: "B",
  yfi: "Y",
  weth: "E",
  aave: "A",
  usdt: "T",
  usdc: "C",
  uni: "U",
  matic: "M",
};

export function spiritChar(collateral, fallbackName = "") {
  const key = String(collateral || "").toLowerCase().replace(/^ma/, "");
  if (SPIRIT_CHARS[key]) return SPIRIT_CHARS[key];
  const n = String(fallbackName || "").trim();
  return n ? n[0].toUpperCase() : "G";
}

export function greeting(hour = new Date().getHours()) {
  if (hour < 5) return "Up late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function shortAddress(addr) {
  const a = String(addr || "");
  return /^0x[0-9a-fA-F]{40}$/.test(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/** Status → tone class used by the dot + label. */
export function statusTone(status) {
  const s = String(status || "").toLowerCase();
  if (s === "working" || s === "active" || s === "running") return "live";
  if (s === "assigned" || s === "watching") return "busy";
  if (s === "available") return "ready";
  if (s === "failed" || s === "error") return "bad";
  return "idle";
}

export function roleLabel(role) {
  const r = String(role || "").trim();
  if (!r) return "Crew";
  const words = r.replace(/[-_]+/g, " ");
  return words[0].toUpperCase() + words.slice(1);
}

/**
 * Parse location.hash into a desk route.
 *   #/login · #/pair · #/projects · #/settings
 *   #/p/<slug>            → project chat (latest thread)
 *   #/p/<slug>/t/<id|new> → project chat on a thread
 *   #/thread/<id>         → legacy: general chat on that thread
 */
export function parseDeskRoute(hash) {
  const h = String(hash || "").replace(/^#\/?/, "");
  if (!h) return { name: "projects" };
  if (h === "login") return { name: "login" };
  if (h === "pair") return { name: "pair" };
  if (h === "projects" || h === "threads") return { name: "projects" };
  if (h === "settings") return { name: "settings" };
  const dec = (v) => {
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  };
  let m = h.match(/^p\/([^/]+)\/t\/([^/]+)$/);
  if (m) return { name: "chat", project: dec(m[1]), threadId: dec(m[2]) };
  m = h.match(/^p\/([^/]+)$/);
  if (m) return { name: "chat", project: dec(m[1]), threadId: null };
  m = h.match(/^thread\/(.+)$/);
  if (m) return { name: "chat", project: GENERAL, threadId: dec(m[1]) || NEW_THREAD_ID };
  return { name: "projects" };
}

export function chatHash(project, threadId) {
  const p = encodeURIComponent(project || GENERAL);
  return threadId ? `#/p/${p}/t/${encodeURIComponent(threadId)}` : `#/p/${p}`;
}

/**
 * Group threads by project slug (GENERAL for none), newest first inside each.
 * @param {Array<{ project?: string|null, updatedAt?: string, lastMessageAt?: string }>} threads
 * @returns {Map<string, object[]>}
 */
export function groupThreadsByProject(threads) {
  const out = new Map();
  for (const t of threads || []) {
    const key = t?.project || GENERAL;
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(t);
  }
  const when = (t) => String(t.lastMessageAt || t.updatedAt || "");
  for (const list of out.values()) list.sort((a, b) => when(b).localeCompare(when(a)));
  return out;
}

/** Case-insensitive match on title / slug / goal. */
export function filterProjects(projects, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return projects || [];
  return (projects || []).filter((p) =>
    [p.title, p.slug, p.goal].some((v) => String(v || "").toLowerCase().includes(q)),
  );
}

/** Kanban counts → segments for the progress bar (zero columns dropped). */
export function kanbanSegments(kanban) {
  const cols = ["done", "review", "doing", "todo", "backlog"];
  const total = cols.reduce((n, c) => n + (Number(kanban?.[c]) || 0), 0);
  if (!total) return [];
  return cols
    .map((c) => ({ column: c, count: Number(kanban?.[c]) || 0 }))
    .filter((s) => s.count > 0)
    .map((s) => ({ ...s, pct: (s.count / total) * 100 }));
}

/** Starter prompts for an empty project chat. */
export function suggestionPrompts(project) {
  if (!project || project.slug === GENERAL) {
    return [
      "What's the crew working on right now?",
      "Summarize today across all projects",
      "What needs my decision?",
    ];
  }
  const t = project.title || project.slug;
  return [
    `Status of ${t}?`,
    `What's in progress on ${t} and who owns it?`,
    `What's blocked on ${t}?`,
  ];
}

/** URLs that reopen this page inside a wallet's in-app browser (iOS). */
export function walletBrowserLinks(pageUrl) {
  const u = String(pageUrl || "");
  const bare = u.replace(/^https?:\/\//, "");
  return [
    { id: "metamask", label: "MetaMask", href: `https://metamask.app.link/dapp/${bare}` },
    {
      id: "coinbase",
      label: "Coinbase Wallet",
      href: `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(u)}`,
    },
  ];
}

/** UTF-8 → 0x hex, the personal_sign message encoding. */
export function toHexUtf8(text) {
  const bytes = new TextEncoder().encode(String(text));
  let out = "0x";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
