/**
 * Shared app state + navigation for the desk views.
 * Views import from here instead of from main.js (no import cycles).
 */
import { clearDesk } from "./storage.js";

export const app = {
  /** @type {{deskId: string, deskToken: string, name: string, kind: string, pairedAt: string, walletAddress?: string|null}|null} */
  desk: null,
  /** @type {{ stop(): void, start(): void, setIntervalMs?(ms: number): void, running: boolean, _cleanup?: () => void }|null} */
  poller: null,
  /** threadId → title (in memory only; never persisted). */
  threadTitles: new Map(),
  /** slug → project summary/detail from the Hub (in memory only). */
  projects: new Map(),
  /** heroId → blob: URL | null (null = no avatar on the Hub). */
  avatarUrls: new Map(),
  /** One-shot message shown by the next login view. */
  flash: null,
  /** Set by main.js: re-render the current hash. */
  route: async () => {},
};

export function clearPoller() {
  const p = app.poller;
  if (!p) return;
  if (typeof p._cleanup === "function") {
    try {
      p._cleanup();
    } catch {
      /* ignore */
    }
  }
  p.stop();
  app.poller = null;
}

/** Register a view-scoped cleanup that runs on the next navigation. */
export function setViewCleanup(fn) {
  clearPoller();
  app.poller = {
    stop() {},
    start() {},
    setIntervalMs() {},
    get running() {
      return false;
    },
    _cleanup: fn,
  };
}

export function navigate(hash, { replace = false } = {}) {
  const next = hash.startsWith("#") ? hash : `#${hash}`;
  if (replace) {
    history.replaceState(null, "", next);
    // replaceState never fires hashchange
    void app.route();
  } else {
    location.hash = next;
  }
}

export function rememberThreadTitles(threads) {
  for (const t of threads || []) {
    if (!t?.threadId) continue;
    const id = String(t.threadId);
    app.threadTitles.set(id, t.kind === "desk" ? "Desk" : t.title ? String(t.title) : id);
  }
}

export function shortThreadId(threadId) {
  const id = String(threadId || "");
  return id.length > 24 ? `${id.slice(0, 20)}…` : id;
}

/** Hub says this token is gone: drop local credentials, back to sign-in. */
export async function handleUnpaired(message) {
  clearPoller();
  await clearDesk();
  app.desk = null;
  app.flash = message || "This phone was signed out on the Hub";
  navigate("#/login", { replace: true });
}
