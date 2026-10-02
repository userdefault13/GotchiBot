/**
 * Pure helpers for the desk views (portfolio, project chat, avatar pane).
 * No DOM at import time; importable from Node tests.
 */

/** Sentinel "project" for chats that belong to no pstack room. */
export const GENERAL = "_general";
/** Hash sentinel for a draft (unsaved) thread — first send omits threadId. */
export const NEW_THREAD_ID = "new";

/** The one chat a project has on the Hub (mirrors store.mjs deskThreadId). */
export function deskThreadId(slug) {
  return `desk-${slug}`;
}

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

/** Read-only cockpit sections (desk snapshot) → their routes. */
export const COCKPIT_VIEWS = ["roster", "kanban", "inbox", "hub"];

function hubHostLabel(hub) {
  if (hub?.deskPaired) return `Hub network (paired${hub.hubHost ? ` · ${hub.hubHost}` : ""})`;
  if (hub?.hubInstalled) return "Hub network (this computer is the Hub)";
  if (hub) return "Set up Hub network (on desk)";
  return "Hub network";
}

/**
 * The terminal cockpit's "What next?" menu, same order (onboarding-gate.mjs
 * mainMenu). Rows the phone can't run carry deskOnly and no href.
 * @param {{ project?: string|null, cockpit?: object|null }} opts
 * @returns {Array<{ key: string, label: string, href: string|null, deskOnly: boolean, badge?: number }>}
 */
export function cockpitMenu({ project = null, cockpit = null } = {}) {
  const phone = (key, label, href, extra = {}) => ({ key, label, href, deskOnly: false, ...extra });
  const desk = (key, label) => ({ key, label, href: null, deskOnly: true });
  const unread = Number(cockpit?.inbox?.unread) || 0;
  return [
    phone("launch", "Open desk", project ? chatHash(project, null) : "#/projects"),
    phone("select-project", "Switch to another project", "#/projects"),
    desk("checkpoint-project", "Save project to Base"),
    desk("checkpoint-chat", "Checkpoint chat sync to Base"),
    phone("hub-network", hubHostLabel(cockpit?.hub), "#/hub"),
    desk("meet", "Start meeting / morning recap"),
    phone("roster", "View agent roster (MBP + iMac · status)", "#/roster"),
    phone("kanban", "Kanban (agents · tasks · seats)", "#/kanban"),
    phone("inbox", "Bot inbox", "#/inbox", unread ? { badge: unread } : {}),
    desk("pstack", "Pstack (dossier pane · program store)"),
    desk("export-roster", "Export agent roster to CSV"),
    desk("import", "Browse cartridge cAavegotchis"),
    desk("mint", "Mint another wallet gotchi"),
    desk("mint-collateral", "Mint a base collateral cAavegotchi"),
    desk("marketplace", "View Marketplace"),
    phone("settings", "Settings", "#/settings"),
    desk("avatar", "Change orchestrator avatar"),
  ];
}

/**
 * Cockpit header rows (label, value) like the terminal cockpit's top block.
 * @param {{ cockpit?: object|null, desk?: object|null, project?: string|null, projectTitle?: string|null }} opts
 */
export function cockpitHeaderRows({ cockpit = null, desk = null, project = null, projectTitle = null } = {}) {
  const h = cockpit?.header || {};
  const wallet = h.wallet || desk?.walletAddress || null;
  const orch = h.orchestrator;
  const count = Number.isFinite(h.rosterCount) ? h.rosterCount : null;
  return [
    ["wallet", wallet ? shortAddress(wallet) : "—"],
    ["cartridge", h.cartridgeId ? `${h.cartridgeId}${h.cartridgeChain ? ` (${h.cartridgeChain})` : ""}` : "—"],
    ["roster", count == null ? "—" : `${count} cAavegotchi${count === 1 ? "" : "s"}`],
    ["orchestrator", orch ? orch.name || orch.id : "—"],
    ["project", project ? projectTitle || project : "none — pick one"],
  ];
}

/**
 * Parse location.hash into a desk route.
 *   #/ · #/cockpit        → cockpit (root menu, like the terminal desk)
 *   #/login · #/pair · #/verify · #/settings
 *   #/projects            → project picker (Switch to another project)
 *   #/roster · #/kanban · #/inbox · #/hub → read-only cockpit views
 *   #/p/<slug>            → project desk chat
 *   #/p/<slug>/t/<id|new> → project chat on a thread
 *   #/thread/<id>         → legacy: general chat on that thread
 */
export function parseDeskRoute(hash) {
  const h = String(hash || "").replace(/^#\/?/, "");
  if (!h || h === "cockpit" || h === "threads") return { name: "cockpit" };
  if (h === "login") return { name: "login" };
  if (h === "pair") return { name: "pair" };
  if (h === "verify") return { name: "verify" };
  if (h === "verified") return { name: "verified" };
  if (h === "projects") return { name: "projects" };
  if (h === "settings") return { name: "settings" };
  if (COCKPIT_VIEWS.includes(h)) return { name: "view", view: h };
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
  return { name: "cockpit" };
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

/** Slash commands the phone runs itself; every other `/name` goes to the Hub desk. */
export const PHONE_SLASH_COMMANDS = [
  { name: "new", description: "Start a new session (fresh agent context)", source: "phone" },
  { name: "sessions", description: "Switch to another session of this chat", source: "phone" },
];

/** The `/partial` being typed (no space yet), or null when the menu should hide. */
export function slashQuery(text) {
  const m = String(text || "").match(/^\/(\S*)$/);
  return m ? m[1].toLowerCase() : null;
}

/** Phone commands first, then Hub commands; name-prefix matches before substring matches. */
export function filterSlashCommands(query, hubCommands = [], limit = 40) {
  const q = String(query || "").toLowerCase();
  const all = [...PHONE_SLASH_COMMANDS, ...hubCommands.filter((c) => !PHONE_SLASH_COMMANDS.some((p) => p.name === c.name))];
  if (!q) return all.slice(0, limit);
  const prefix = all.filter((c) => c.name.toLowerCase().startsWith(q));
  const inner = all.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q));
  return [...prefix, ...inner].slice(0, limit);
}

/** A whole message that is one of the phone's own commands → its name, else null. */
export function phoneSlashCommand(text) {
  const m = String(text || "").trim().match(/^\/(\S+)$/);
  const name = m?.[1].toLowerCase();
  return PHONE_SLASH_COMMANDS.some((c) => c.name === name) ? name : null;
}

/** Universal link that opens `pageUrl` (hash included) in MetaMask's in-app browser. */
export function metamaskDappLink(pageUrl) {
  return `https://metamask.app.link/dapp/${String(pageUrl || "").replace(/^https?:\/\//, "")}`;
}

/** URLs that reopen this page inside a wallet's in-app browser (iOS). */
export function walletBrowserLinks(pageUrl) {
  const u = String(pageUrl || "");
  return [
    { id: "metamask", label: "MetaMask", href: metamaskDappLink(u) },
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
