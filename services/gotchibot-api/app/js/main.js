/**
 * GotchiBot phone PWA — hash router + views (read-only).
 * Browser entry: registers SW, routes #/pair | #/threads | #/thread/… | #/settings.
 */

import { APP_VERSION } from "./version.js";
import {
  iconSettings,
  iconRefresh,
  iconChevronLeft,
  iconQr,
} from "./icons.js";
import {
  formatCode,
  isValidCode,
  normalizeCode,
  parsePairHash,
} from "./pair.js";
import { renderMarkdown } from "./markdown.js";
import { createThreadModel, relativeTime, roleClass } from "./thread-model.js";
import { createPoller } from "./poller.js";
import { getDesk, setDesk, clearDesk } from "./storage.js";
import {
  ApiError,
  claimPair,
  whoami,
  listThreads,
  pullMessages,
  hubHealth,
} from "./api.js";
import { openScanner } from "./scan.js";

/** @type {{deskId: string, deskToken: string, name: string, kind: string, pairedAt: string}|null} */
let desk = null;
/** @type {ReturnType<typeof createPoller>|null} */
let activePoller = null;
let bootOnce = false;
/** In-memory threadId → title (not persisted; filled when Threads list loads). */
const threadTitles = new Map();

function rememberThreadTitles(threads) {
  for (const t of threads || []) {
    if (!t?.threadId) continue;
    const id = String(t.threadId);
    threadTitles.set(id, t.title ? String(t.title) : id);
  }
}

function shortThreadId(threadId) {
  const id = String(threadId || "");
  return id.length > 24 ? `${id.slice(0, 20)}…` : id;
}

/**
 * Resolve a display title for the thread header.
 * Uses the in-memory map first; on miss (deep link / reload) fetches the
 * threads list once, then falls back to a shortened threadId.
 * @param {string} threadId
 * @returns {Promise<string>}
 */
async function resolveThreadTitle(threadId) {
  const id = String(threadId || "");
  if (threadTitles.has(id)) return threadTitles.get(id);
  try {
    if (desk?.deskToken) {
      const data = await listThreads(desk.deskToken, 100);
      rememberThreadTitles(data?.threads);
      if (threadTitles.has(id)) return threadTitles.get(id);
    }
  } catch {
    /* fall through to short id */
  }
  return shortThreadId(id);
}

function $(sel, root = document) {
  return root.querySelector(sel);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function clearPoller() {
  if (activePoller) {
    if (typeof activePoller._cleanup === "function") {
      try {
        activePoller._cleanup();
      } catch {
        /* ignore */
      }
    }
    activePoller.stop();
    activePoller = null;
  }
}

function navigate(hash, { replace = false } = {}) {
  const next = hash.startsWith("#") ? hash : `#${hash}`;
  if (replace) {
    history.replaceState(null, "", next);
  } else {
    location.hash = next;
  }
  // hashchange may not fire on replaceState
  if (replace) void route();
}

function parseRoute() {
  const raw = location.hash || "";
  // Deep-link form #pair=CODE (not a view path)
  const pairCode = parsePairHash(raw);
  if (pairCode && !raw.startsWith("#/")) {
    return { name: "pair", prefills: pairCode };
  }
  const h = raw.replace(/^#\/?/, "");
  if (!h || h === "pair") return { name: "pair", prefills: null };
  if (h === "threads") return { name: "threads" };
  if (h === "settings") return { name: "settings" };
  const threadMatch = h.match(/^thread\/(.+)$/);
  if (threadMatch) {
    try {
      return { name: "thread", threadId: decodeURIComponent(threadMatch[1]) };
    } catch {
      return { name: "thread", threadId: threadMatch[1] };
    }
  }
  return { name: "threads" };
}

function topNav({ title, left, right }) {
  const nav = el("header", "top-nav");
  const brand = el("div", "brand-section");
  if (left) brand.appendChild(left);
  const titleWrap = el("div", "brand-title");
  const h1 = el("h1", null, title);
  titleWrap.appendChild(h1);
  brand.appendChild(titleWrap);
  nav.appendChild(brand);
  if (right) {
    const actions = el("div", "nav-actions");
    actions.appendChild(right);
    nav.appendChild(actions);
  }
  return nav;
}

function iconButton(html, label, onClick) {
  const btn = el("button", "icon-btn");
  btn.type = "button";
  btn.setAttribute("aria-label", label);
  btn.innerHTML = html;
  btn.addEventListener("click", onClick);
  return btn;
}

async function handleUnpaired(message) {
  clearPoller();
  await clearDesk();
  desk = null;
  const root = document.getElementById("root");
  if (root) {
    root.replaceChildren();
    const notice = el("div", "notice error", message || "This phone was unpaired on the Hub");
    root.appendChild(topNav({ title: "GotchiBot" }));
    const panel = el("main", "panel");
    panel.appendChild(notice);
    root.appendChild(panel);
  }
  navigate("#/pair", { replace: true });
}

/* ── Pair view ─────────────────────────────────────────────────────── */

function renderPairView(root, { prefills = null, banner = null } = {}) {
  clearPoller();
  root.replaceChildren();
  root.appendChild(
    topNav({
      title: "GotchiBot",
    }),
  );

  const panel = el("main", "panel pair-panel");
  panel.appendChild(el("h2", "view-title", "Pair this phone"));
  panel.appendChild(
    el(
      "p",
      "subtle pair-lead",
      "Enter the code from gotchibot hub pair --kind phone (or scan the QR). This phone will only see threads the Hub owner shares with it.",
    ),
  );

  if (banner) {
    panel.appendChild(el("div", "notice error", banner));
  }

  const form = el("form", "pair-form");
  form.setAttribute("novalidate", "");

  const codeLabel = el("label", "field-label", "Pairing code");
  codeLabel.setAttribute("for", "pair-code");
  const codeInput = el("input", "pair-code-input");
  codeInput.id = "pair-code";
  codeInput.name = "code";
  codeInput.type = "text";
  codeInput.inputMode = "text";
  codeInput.autocomplete = "one-time-code";
  codeInput.setAttribute("autocapitalize", "characters");
  codeInput.setAttribute("spellcheck", "false");
  codeInput.placeholder = "XXXX-XXXX";
  codeInput.maxLength = 9;
  if (prefills) codeInput.value = formatCode(prefills);

  codeInput.addEventListener("input", () => {
    const caret = codeInput.selectionStart;
    const before = codeInput.value;
    const formatted = formatCode(before);
    if (formatted !== before) {
      codeInput.value = formatted;
      // Keep caret roughly at end for short codes
      try {
        codeInput.setSelectionRange(formatted.length, formatted.length);
      } catch {
        /* ignore */
      }
    }
    void caret;
  });

  const nameLabel = el("label", "field-label", "Phone name");
  nameLabel.setAttribute("for", "pair-name");
  const nameInput = el("input");
  nameInput.id = "pair-name";
  nameInput.name = "name";
  nameInput.type = "text";
  nameInput.value = "iPhone";
  nameInput.autocomplete = "off";

  const errEl = el("p", "form-error");
  errEl.hidden = true;

  const actions = el("div", "pair-actions");
  const submitBtn = el("button", "btn-primary", "Pair this phone");
  submitBtn.type = "submit";

  const scanBtn = el("button", "btn-secondary");
  scanBtn.type = "button";
  scanBtn.innerHTML = `${iconQr(18)} Scan QR`;

  actions.appendChild(submitBtn);
  actions.appendChild(scanBtn);

  form.appendChild(codeLabel);
  form.appendChild(codeInput);
  form.appendChild(nameLabel);
  form.appendChild(nameInput);
  form.appendChild(errEl);
  form.appendChild(actions);
  panel.appendChild(form);
  root.appendChild(panel);

  function showError(msg) {
    errEl.hidden = !msg;
    errEl.textContent = msg || "";
  }

  async function doClaim(codeRaw) {
    showError("");
    const code = formatCode(codeRaw);
    if (!isValidCode(code)) {
      showError("Enter an 8-character pairing code");
      return;
    }
    const name = (nameInput.value || "iPhone").trim() || "iPhone";
    submitBtn.disabled = true;
    scanBtn.disabled = true;
    try {
      const result = await claimPair({ code: normalizeCode(code), name, kind: "phone" });
      if (!result?.ok || !result.deskToken) {
        showError("Pairing failed — try a fresh code");
        return;
      }
      const stored = await setDesk({
        deskId: result.deskId,
        deskToken: result.deskToken,
        name: result.name || name,
        kind: result.kind || "phone",
        pairedAt: new Date().toISOString(),
      });
      desk = stored;
      await whoami(desk.deskToken);
      // Drop #pair=CODE from the URL after success
      navigate("#/threads", { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401 || err.kind === "unpaired") {
          showError("That code is expired or already used — mint a new one on the Hub");
        } else if (err.status === 403) {
          showError("Not signed in as the Hub owner on Tailscale");
        } else if (err.kind === "offline") {
          showError("Can't reach the Hub — check Tailscale and try again");
        } else {
          showError(err.message || "Pairing failed");
        }
      } else {
        showError(err?.message || "Pairing failed");
      }
    } finally {
      submitBtn.disabled = false;
      scanBtn.disabled = false;
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void doClaim(codeInput.value);
  });

  scanBtn.addEventListener("click", async () => {
    showError("");
    const code = await openScanner();
    if (!code) return;
    codeInput.value = formatCode(code);
    await doClaim(code);
  });
}

/* ── Threads view ──────────────────────────────────────────────────── */

async function renderThreadsView(root) {
  clearPoller();
  root.replaceChildren();

  const right = el("div", "nav-actions");
  const refreshBtn = iconButton(iconRefresh(20), "Refresh", () => {
    void load();
  });
  const settingsBtn = iconButton(iconSettings(20), "Settings", () => {
    navigate("#/settings");
  });
  right.appendChild(refreshBtn);
  right.appendChild(settingsBtn);
  root.appendChild(topNav({ title: "Threads", right }));

  const panel = el("main", "panel");
  const listEl = el("div", "session-list");
  const emptyEl = el("div", "empty-state");
  emptyEl.hidden = true;
  panel.appendChild(listEl);
  panel.appendChild(emptyEl);
  root.appendChild(panel);

  async function load() {
    listEl.replaceChildren();
    emptyEl.hidden = true;
    refreshBtn.disabled = true;
    try {
      const data = await listThreads(desk.deskToken, 100);
      const threads = data?.threads || [];
      rememberThreadTitles(threads);
      if (!threads.length) {
        emptyEl.hidden = false;
        emptyEl.replaceChildren();
        emptyEl.appendChild(
          el(
            "p",
            null,
            "No threads yet. This phone only sees threads shared with it.",
          ),
        );
        const cmd = el("p", "subtle empty-cmd");
        cmd.appendChild(document.createTextNode("On the Hub, run:"));
        const code = el("code", "cmd-block");
        code.textContent = `gotchibot hub share <threadId> ${desk.deskId}`;
        emptyEl.appendChild(cmd);
        emptyEl.appendChild(code);
        return;
      }
      const now = Date.now();
      for (const t of threads) {
        const card = el("article", "session-card");
        card.tabIndex = 0;
        card.setAttribute("role", "button");
        const main = el("div", "session-card-main");
        const left = el("div");
        left.appendChild(el("h3", null, t.title || t.threadId || "Untitled"));
        const meta = el("p");
        const when = t.lastMessageAt || t.updatedAt;
        meta.textContent = when ? relativeTime(when, now) : "";
        left.appendChild(meta);
        main.appendChild(left);
        if (t.shared) {
          const badge = el("span", "badge shared", "shared");
          main.appendChild(badge);
        }
        card.appendChild(main);
        const open = () => {
          navigate(`#/thread/${encodeURIComponent(t.threadId)}`);
        };
        card.addEventListener("click", open);
        card.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            open();
          }
        });
        listEl.appendChild(card);
      }
    } catch (err) {
      if (err instanceof ApiError && err.kind === "unpaired") {
        await handleUnpaired("This phone was unpaired on the Hub");
        return;
      }
      emptyEl.hidden = false;
      emptyEl.replaceChildren();
      emptyEl.appendChild(
        el("p", null, err?.message || "Couldn't load threads"),
      );
    } finally {
      refreshBtn.disabled = false;
    }
  }

  await load();
}

/* ── Thread view ───────────────────────────────────────────────────── */

async function renderThreadView(root, threadId) {
  clearPoller();
  root.replaceChildren();

  const back = iconButton(iconChevronLeft(22), "Back", () => {
    clearPoller();
    navigate("#/threads");
  });
  const initialTitle = threadTitles.has(threadId)
    ? threadTitles.get(threadId)
    : "Thread";
  root.appendChild(topNav({ title: initialTitle, left: back }));

  const wrap = el("div", "messages-wrap");
  const messagesEl = el("div", "messages");
  wrap.appendChild(messagesEl);

  const footer = el("footer", "readonly-footer");
  footer.textContent = "Read-only — sending comes later";
  wrap.appendChild(footer);
  root.appendChild(wrap);

  const model = createThreadModel();

  async function setThreadHeaderTitle() {
    const title = await resolveThreadTitle(threadId);
    const h1 = root.querySelector(".brand-title h1");
    if (h1) h1.textContent = title;
  }

  function nearBottom(elNode) {
    const slack = 80;
    return elNode.scrollHeight - elNode.scrollTop - elNode.clientHeight < slack;
  }

  function renderMessages() {
    const stick = nearBottom(document.documentElement) || nearBottom(document.body);
    // Prefer scrolling the window; also check messages wrap
    const wasNear =
      stick ||
      (wrap.scrollHeight > 0 &&
        wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 80);

    messagesEl.replaceChildren();
    for (const m of model.list()) {
      const cls = roleClass(m.role);
      const article = el("article", `message ${cls}`);
      const header = el("header");
      const strong = el("strong", null, cls);
      const time = el("small");
      let timeLabel = m.ts ? relativeTime(m.ts) : "";
      if (m.edited) timeLabel = timeLabel ? `${timeLabel} · edited` : "edited";
      time.textContent = timeLabel;
      header.appendChild(strong);
      header.appendChild(time);
      article.appendChild(header);
      const content = el("div", "message-content");
      content.innerHTML = renderMarkdown(m.text || "");
      article.appendChild(content);
      messagesEl.appendChild(article);
    }

    if (wasNear) {
      requestAnimationFrame(() => {
        window.scrollTo(0, document.documentElement.scrollHeight);
      });
    }
  }

  async function pullAll(initial) {
    let after = initial ? 0 : model.lastSeq;
    let guard = 0;
    do {
      const data = await pullMessages(desk.deskToken, {
        threadId,
        after,
        limit: 500,
      });
      const msgs = data?.messages || [];
      model.applyMessages(msgs);
      after = data?.nextAfter ?? model.lastSeq;
      if (!data?.hasMore) break;
      guard += 1;
    } while (guard < 50);
    renderMessages();
  }

  try {
    await Promise.all([pullAll(true), setThreadHeaderTitle()]);
  } catch (err) {
    if (err instanceof ApiError && err.kind === "unpaired") {
      await handleUnpaired("This phone was unpaired on the Hub");
      return;
    }
    if (err instanceof ApiError && err.kind === "not-found") {
      messagesEl.replaceChildren();
      const empty = el("div", "empty-state");
      empty.appendChild(el("p", null, "This thread isn't shared with this phone"));
      messagesEl.appendChild(empty);
      return;
    }
    messagesEl.replaceChildren();
    messagesEl.appendChild(
      el("div", "notice error", err?.message || "Couldn't load messages"),
    );
    return;
  }

  const poller = createPoller({
    intervalMs: 4000,
    isVisible: () => document.visibilityState === "visible",
    tick: async () => {
      try {
        const data = await pullMessages(desk.deskToken, {
          threadId,
          after: model.lastSeq,
          limit: 500,
        });
        const msgs = data?.messages || [];
        if (msgs.length) {
          model.applyMessages(msgs);
          renderMessages();
        }
      } catch (err) {
        if (err instanceof ApiError && err.kind === "unpaired") {
          await handleUnpaired("This phone was unpaired on the Hub");
        }
        // 404 mid-poll: leave messages, stop polling
        if (err instanceof ApiError && err.kind === "not-found") {
          clearPoller();
        }
      }
    },
  });
  activePoller = poller;

  function onVis() {
    if (activePoller !== poller) return;
    if (document.visibilityState === "visible") {
      if (!poller.running) poller.start();
    } else if (poller.running) {
      poller.stop();
    }
  }
  document.addEventListener("visibilitychange", onVis);
  poller._cleanup = () => {
    document.removeEventListener("visibilitychange", onVis);
  };

  if (document.visibilityState === "visible") poller.start();
}

/* ── Settings view ─────────────────────────────────────────────────── */

async function renderSettingsView(root) {
  clearPoller();
  root.replaceChildren();

  const back = iconButton(iconChevronLeft(22), "Back", () => {
    navigate("#/threads");
  });
  root.appendChild(topNav({ title: "Settings", left: back }));

  const panel = el("main", "panel");

  // Hub
  panel.appendChild(el("h2", "view-title", "Hub"));
  const hubOrigin = el("div", "settings-row");
  hubOrigin.appendChild(el("strong", null, "Origin"));
  hubOrigin.appendChild(el("small", null, location.origin));
  panel.appendChild(hubOrigin);

  const hubVer = el("div", "settings-row");
  hubVer.appendChild(el("strong", null, "Status"));
  const hubStatus = el("small", null, "…");
  hubVer.appendChild(hubStatus);
  panel.appendChild(hubVer);

  // Phone
  panel.appendChild(el("h2", "view-title", "This phone"));
  const rows = [
    ["Name", desk?.name || "—"],
    ["Desk id", desk?.deskId || "—"],
    ["Kind", desk?.kind || "—"],
    ["Paired at", desk?.pairedAt ? new Date(desk.pairedAt).toLocaleString() : "—"],
  ];
  for (const [label, value] of rows) {
    const row = el("div", "settings-row");
    row.appendChild(el("strong", null, label));
    row.appendChild(el("small", null, value));
    panel.appendChild(row);
  }

  // App
  panel.appendChild(el("h2", "view-title", "App"));
  const verRow = el("div", "settings-row");
  verRow.appendChild(el("strong", null, "Version"));
  verRow.appendChild(el("small", null, APP_VERSION));
  panel.appendChild(verRow);

  const revokeCmd = desk?.deskId
    ? `gotchibot hub revoke ${desk.deskId}`
    : "gotchibot hub revoke <deskId>";

  const unpairBtn = el("button", "btn-danger", "Unpair this phone");
  unpairBtn.type = "button";
  unpairBtn.addEventListener("click", async () => {
    const ok = confirm(
      `Unpair this phone? Local credentials will be cleared. The Hub owner should also run ${revokeCmd} to kill the token server-side.`,
    );
    if (!ok) return;
    await clearDesk();
    desk = null;
    navigate("#/pair", { replace: true });
  });
  panel.appendChild(unpairBtn);

  const unpairNote = el("p", "subtle settings-note");
  unpairNote.appendChild(
    document.createTextNode(
      "Unpairing here only clears this device. On the Hub, also run:",
    ),
  );
  const revokeCode = el("code", "cmd-block");
  revokeCode.textContent = revokeCmd;
  unpairNote.appendChild(revokeCode);
  panel.appendChild(unpairNote);

  const licenses = el("p", "subtle licenses-links");
  const a1 = el("a", null, "NOTICE");
  a1.href = "NOTICE";
  const a2 = el("a", null, "THIRD_PARTY/README.md");
  a2.href = "THIRD_PARTY/README.md";
  licenses.appendChild(document.createTextNode("Licenses: "));
  licenses.appendChild(a1);
  licenses.appendChild(document.createTextNode(" · "));
  licenses.appendChild(a2);
  panel.appendChild(licenses);

  root.appendChild(panel);

  try {
    const health = await hubHealth();
    const bits = [];
    if (health?.service) bits.push(String(health.service));
    if (health?.version) bits.push(`v${health.version}`);
    if (health?.db) bits.push(`db:${health.db}`);
    hubStatus.textContent = bits.join(" · ") || (health?.ok ? "ok" : "unknown");
  } catch {
    hubStatus.textContent = "unreachable";
  }
}

/* ── Router ────────────────────────────────────────────────────────── */

async function route() {
  const root = document.getElementById("root");
  if (!root) return;

  const r = parseRoute();

  // Deep link #pair=CODE → Pair view prefilled (require tap to confirm)
  if (r.name === "pair" && r.prefills) {
    renderPairView(root, { prefills: r.prefills });
    return;
  }

  if (!desk) {
    desk = await getDesk();
  }

  if (!desk && r.name !== "pair") {
    renderPairView(root);
    navigate("#/pair", { replace: true });
    return;
  }

  if (r.name === "pair") {
    renderPairView(root);
    return;
  }

  if (r.name === "settings") {
    await renderSettingsView(root);
    return;
  }

  if (r.name === "thread") {
    await renderThreadView(root, r.threadId);
    return;
  }

  await renderThreadsView(root);
}

async function boot() {
  if (bootOnce) return;
  bootOnce = true;

  desk = await getDesk();

  const pairFromHash = parsePairHash(location.hash);
  if (pairFromHash) {
    // Stay on pair deep-link until claim succeeds (then replaceState)
    renderPairView(document.getElementById("root"), { prefills: pairFromHash });
  } else if (!desk) {
    navigate("#/pair", { replace: true });
    await route();
  } else {
    if (!location.hash || location.hash === "#") {
      navigate("#/threads", { replace: true });
    }
    await route();
  }

  window.addEventListener("hashchange", () => {
    void route();
  });
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      void boot();
    });
  } else {
    void boot();
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {
      /* ignore registration failures on file:// or unsupported hosts */
    });
  }
}
