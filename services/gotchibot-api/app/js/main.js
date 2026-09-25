/**
 * GotchiBot phone PWA — hash router + views (S2: reply from phone).
 * Browser entry: registers SW, routes #/pair | #/threads | #/thread/… | #/settings.
 */

import { APP_VERSION } from "./version.js";
import {
  iconSettings,
  iconRefresh,
  iconChevronLeft,
  iconQr,
  iconPlus,
  iconSend,
} from "./icons.js";
import {
  formatCode,
  isValidCode,
  normalizeCode,
  parsePairHash,
} from "./pair.js";
import { renderMarkdown } from "./markdown.js";
import { createThreadModel, relativeTime, roleClass } from "./thread-model.js";
import {
  deriveComposeUi,
  formatRunnerStatusLine,
  newClientMessageId,
  pullAfterForReplyWatch,
  POLL_INTERVAL_NORMAL_MS,
  RUNNER_CHECK_MIN_MS,
} from "./compose-model.js";
import { createPoller } from "./poller.js";
import { getDesk, setDesk, clearDesk } from "./storage.js";
import {
  ApiError,
  claimPair,
  whoami,
  listThreads,
  pullMessages,
  sendMessage,
  retryReply,
  runnerStatus,
  hubHealth,
} from "./api.js";
import { openScanner } from "./scan.js";

/** Hash sentinel for draft (unsaved) thread — first send omits threadId. */
const NEW_THREAD_ID = "new";

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
    let tid;
    try {
      tid = decodeURIComponent(threadMatch[1]);
    } catch {
      tid = threadMatch[1];
    }
    return { name: "thread", threadId: tid || NEW_THREAD_ID };
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
  root.classList.remove("has-composer");
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
  root.classList.remove("has-composer");

  const right = el("div", "nav-actions");
  const newBtn = iconButton(iconPlus(20), "New thread", () => {
    navigate(`#/thread/${NEW_THREAD_ID}`);
  });
  const refreshBtn = iconButton(iconRefresh(20), "Refresh", () => {
    void load();
  });
  const settingsBtn = iconButton(iconSettings(20), "Settings", () => {
    navigate("#/settings");
  });
  right.appendChild(newBtn);
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
            "No threads yet. Tap + to start one, or ask the Hub owner to share an existing thread.",
          ),
        );
        const cmd = el("p", "subtle empty-cmd");
        cmd.appendChild(document.createTextNode("On the Hub, share with:"));
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

/**
 * Keep fixed composer above the iOS on-screen keyboard via visualViewport.
 * @param {HTMLElement} composerEl
 * @returns {() => void} cleanup
 */
function bindComposerViewport(composerEl) {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  const sync = () => {
    const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    composerEl.style.bottom = inset > 0 ? `${inset}px` : "";
  };
  vv.addEventListener("resize", sync);
  vv.addEventListener("scroll", sync);
  sync();
  return () => {
    vv.removeEventListener("resize", sync);
    vv.removeEventListener("scroll", sync);
    composerEl.style.bottom = "";
  };
}

async function renderThreadView(root, routeThreadId) {
  clearPoller();
  root.replaceChildren();
  root.classList.add("has-composer");

  /** @type {string|null} */
  let currentThreadId =
    !routeThreadId || routeThreadId === NEW_THREAD_ID ? null : String(routeThreadId);
  const isDraft = () => !currentThreadId;

  /** @type {import("./compose-model.js").PendingSend[]} */
  let pendingSends = [];
  /** @type {{ status?: string, detail?: string|null, model?: string|null }|null} */
  let runner = null;
  let lastRunnerCheckAt = 0;
  let forceScrollBottom = false;

  const back = iconButton(iconChevronLeft(22), "Back", () => {
    clearPoller();
    root.classList.remove("has-composer");
    navigate("#/threads");
  });
  const initialTitle = isDraft()
    ? "New thread"
    : threadTitles.has(currentThreadId)
      ? threadTitles.get(currentThreadId)
      : "Thread";
  root.appendChild(topNav({ title: initialTitle, left: back }));

  const wrap = el("div", "messages-wrap has-composer");
  const messagesEl = el("div", "messages");
  wrap.appendChild(messagesEl);
  root.appendChild(wrap);

  const composer = el("div", "composer");
  const textarea = el("textarea", "composer-input");
  textarea.rows = 1;
  textarea.placeholder = "Message GotchiBot…";
  textarea.setAttribute("enterkeyhint", "enter");
  textarea.setAttribute("aria-label", "Message");
  const sendBtn = el("button", "composer-send");
  sendBtn.type = "button";
  sendBtn.setAttribute("aria-label", "Send");
  sendBtn.innerHTML = iconSend(18);
  sendBtn.disabled = true;
  composer.appendChild(textarea);
  composer.appendChild(sendBtn);
  root.appendChild(composer);

  const unbindViewport = bindComposerViewport(composer);
  const model = createThreadModel();

  function syncSendEnabled() {
    sendBtn.disabled = !textarea.value.trim();
  }

  function autosize() {
    textarea.style.height = "auto";
    const max = Math.round(1.45 * 16 * 6 + 20);
    textarea.style.height = `${Math.min(textarea.scrollHeight, max)}px`;
  }

  async function setThreadHeaderTitle() {
    if (isDraft()) {
      const h1 = root.querySelector(".brand-title h1");
      if (h1) h1.textContent = "New thread";
      return;
    }
    const title = await resolveThreadTitle(currentThreadId);
    const h1 = root.querySelector(".brand-title h1");
    if (h1) h1.textContent = title;
  }

  function nearBottom(elNode) {
    const slack = 80;
    return elNode.scrollHeight - elNode.scrollTop - elNode.clientHeight < slack;
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
    });
  }

  function applyPollInterval(ui) {
    if (activePoller && typeof activePoller.setIntervalMs === "function") {
      activePoller.setIntervalMs(ui.pollIntervalMs);
    }
  }

  function renderMessages() {
    const stick =
      forceScrollBottom ||
      nearBottom(document.documentElement) ||
      nearBottom(document.body) ||
      (wrap.scrollHeight > 0 &&
        wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 80);
    forceScrollBottom = false;

    const ui = deriveComposeUi({
      messages: model.list(),
      pendingSends,
      runner,
    });
    applyPollInterval(ui);

    messagesEl.replaceChildren();

    if (isDraft() && !model.list().length && !ui.optimistic.length) {
      const empty = el("div", "empty-state");
      empty.appendChild(
        el("p", null, "Say something to start a thread owned by this phone."),
      );
      messagesEl.appendChild(empty);
    }

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

      const via =
        m.messageId && ui.viaModelByMessageId.get(String(m.messageId));
      if (via && cls === "assistant") {
        const meta = el("div", "message-meta");
        meta.appendChild(el("span", "msg-via", `via ${via}`));
        article.appendChild(meta);
      }

      messagesEl.appendChild(article);
    }

    for (const p of ui.optimistic) {
      const article = el("article", "message user pending");
      const header = el("header");
      header.appendChild(el("strong", null, "user"));
      article.appendChild(header);
      const content = el("div", "message-content");
      content.innerHTML = renderMarkdown(p.text || "");
      article.appendChild(content);
      const meta = el("div", "message-meta");
      if (p.status === "sending") {
        meta.appendChild(el("span", "msg-status", "sending…"));
      } else if (p.forbidden) {
        meta.appendChild(
          el(
            "span",
            "msg-error",
            "This thread isn't shared with this phone",
          ),
        );
        const discard = el("button", "link-btn danger", "Discard");
        discard.type = "button";
        discard.addEventListener("click", () => {
          pendingSends = pendingSends.filter(
            (x) => x.clientMessageId !== p.clientMessageId,
          );
          renderMessages();
        });
        meta.appendChild(discard);
      } else {
        meta.appendChild(
          el("span", "msg-error", p.error || "Send failed"),
        );
        const retry = el("button", "link-btn", "Retry");
        retry.type = "button";
        retry.addEventListener("click", () => {
          void doSend({
            text: p.text,
            clientMessageId: p.clientMessageId,
            isRetry: true,
          });
        });
        const discard = el("button", "link-btn danger", "Discard");
        discard.type = "button";
        discard.addEventListener("click", () => {
          pendingSends = pendingSends.filter(
            (x) => x.clientMessageId !== p.clientMessageId,
          );
          renderMessages();
        });
        meta.appendChild(retry);
        meta.appendChild(discard);
      }
      article.appendChild(meta);
      messagesEl.appendChild(article);
    }

    if (ui.waitingForReply) {
      const row = el("div", "thinking-row");
      const label = el("span", "thinking-label");
      label.appendChild(document.createTextNode("gotchi is thinking"));
      const dots = el("span", "thinking-dots");
      dots.appendChild(el("span", null, "."));
      dots.appendChild(el("span", null, "."));
      dots.appendChild(el("span", null, "."));
      label.appendChild(dots);
      row.appendChild(label);
      if (ui.runnerNotice) {
        row.appendChild(el("div", "runner-notice", ui.runnerNotice));
      }
      messagesEl.appendChild(row);
    }

    if (ui.replyError) {
      const row = el("div", "reply-error-row");
      row.appendChild(el("span", "msg-error", ui.replyError.error));
      const retry = el("button", "link-btn", "Retry");
      retry.type = "button";
      retry.addEventListener("click", () => {
        void doRetryReply(ui.replyError.messageId);
      });
      row.appendChild(retry);
      messagesEl.appendChild(row);
    }

    if (stick) scrollToBottom();
  }

  async function maybeCheckRunner(force = false) {
    const ui = deriveComposeUi({
      messages: model.list(),
      pendingSends,
      runner,
    });
    if (!ui.shouldCheckRunner && !force) return;
    const now = Date.now();
    if (!force && now - lastRunnerCheckAt < RUNNER_CHECK_MIN_MS) return;
    lastRunnerCheckAt = now;
    try {
      const data = await runnerStatus(desk.deskToken);
      runner = data?.runner || null;
      renderMessages();
    } catch {
      /* non-blocking */
    }
  }

  async function pullAll(initial) {
    if (isDraft()) {
      renderMessages();
      return;
    }
    let after = initial ? 0 : model.lastSeq;
    let guard = 0;
    do {
      const data = await pullMessages(desk.deskToken, {
        threadId: currentThreadId,
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

  async function ensurePoller() {
    if (isDraft()) return;
    if (activePoller?.__isThreadPoller) return;
    // Drop draft-only stub without teardown (composer still mounted)
    if (activePoller?.__isDraftStub) {
      activePoller = null;
    } else if (activePoller) {
      return;
    }

    const poller = createPoller({
      intervalMs: POLL_INTERVAL_NORMAL_MS,
      isVisible: () => document.visibilityState === "visible",
      tick: async () => {
        if (isDraft() || !currentThreadId) return;
        try {
          const after = pullAfterForReplyWatch(model.list(), model.lastSeq);
          const data = await pullMessages(desk.deskToken, {
            threadId: currentThreadId,
            after,
            limit: 500,
          });
          const msgs = data?.messages || [];
          if (msgs.length) {
            model.applyMessages(msgs);
            // Drop optimistic rows once Hub confirms same clientMessageId
            const confirmed = new Set(
              msgs.map((m) => m?.messageId).filter(Boolean).map(String),
            );
            if (confirmed.size) {
              pendingSends = pendingSends.filter(
                (p) => !confirmed.has(String(p.clientMessageId)),
              );
            }
            renderMessages();
          } else {
            // Still refresh interval / runner while waiting
            const ui = deriveComposeUi({
              messages: model.list(),
              pendingSends,
              runner,
            });
            applyPollInterval(ui);
          }
          await maybeCheckRunner(false);
        } catch (err) {
          if (err instanceof ApiError && err.kind === "unpaired") {
            await handleUnpaired("This phone was unpaired on the Hub");
          }
          if (err instanceof ApiError && err.kind === "not-found") {
            clearPoller();
          }
        }
      },
    });
    poller.__isThreadPoller = true;
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
      unbindViewport();
      root.classList.remove("has-composer");
    };

    if (document.visibilityState === "visible") poller.start();
  }

  /**
   * @param {{ text: string, clientMessageId?: string, isRetry?: boolean }} opts
   */
  async function doSend({ text, clientMessageId, isRetry = false }) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return;

    const id = clientMessageId || newClientMessageId();
    if (!isRetry) {
      pendingSends = [
        ...pendingSends.filter((p) => p.clientMessageId !== id),
        { clientMessageId: id, text: trimmed, status: "sending" },
      ];
      textarea.value = "";
      syncSendEnabled();
      autosize();
    } else {
      pendingSends = pendingSends.map((p) =>
        p.clientMessageId === id
          ? { clientMessageId: id, text: trimmed, status: "sending" }
          : p,
      );
    }
    forceScrollBottom = true;
    renderMessages();

    try {
      /** @type {{ threadId?: string, clientMessageId: string, text: string }} */
      const body = { clientMessageId: id, text: trimmed };
      if (currentThreadId) body.threadId = currentThreadId;

      const result = await sendMessage(desk.deskToken, body);
      if (!result?.ok) {
        throw new ApiError("http", 500, "Send failed");
      }

      // Promote draft → real thread without remounting
      if (!currentThreadId && result.threadId) {
        currentThreadId = String(result.threadId);
        threadTitles.set(
          currentThreadId,
          threadTitles.get(currentThreadId) || shortThreadId(currentThreadId),
        );
        history.replaceState(
          null,
          "",
          `#/thread/${encodeURIComponent(currentThreadId)}`,
        );
        void setThreadHeaderTitle();
        await ensurePoller();
      }

      pendingSends = pendingSends.filter((p) => p.clientMessageId !== id);
      // Seed optimistic confirmed row until pull fills originKind/reply
      if (result.messageId) {
        model.applyMessages([
          {
            messageId: String(result.messageId),
            seq: result.seq != null ? Number(result.seq) : model.lastSeq + 1,
            role: "user",
            text: trimmed,
            originKind: "phone",
            reply: result.reply || { status: "pending" },
            ts: new Date().toISOString(),
            op: "message",
          },
        ]);
      }
      forceScrollBottom = true;
      renderMessages();
      await maybeCheckRunner(true);
      // Immediate pull to sync
      if (currentThreadId) {
        try {
          const data = await pullMessages(desk.deskToken, {
            threadId: currentThreadId,
            after: pullAfterForReplyWatch(model.list(), model.lastSeq),
            limit: 500,
          });
          model.applyMessages(data?.messages || []);
          forceScrollBottom = true;
          renderMessages();
        } catch {
          /* poller will catch up */
        }
      }
    } catch (err) {
      if (err instanceof ApiError && err.kind === "unpaired") {
        await handleUnpaired("This phone was unpaired on the Hub");
        return;
      }
      const forbidden = err instanceof ApiError && err.status === 403;
      pendingSends = pendingSends.map((p) =>
        p.clientMessageId === id
          ? {
              clientMessageId: id,
              text: trimmed,
              status: "failed",
              forbidden,
              error: forbidden
                ? "This thread isn't shared with this phone"
                : err?.message || "Send failed",
            }
          : p,
      );
      forceScrollBottom = true;
      renderMessages();
    }
  }

  async function doRetryReply(messageId) {
    if (!currentThreadId || !messageId) return;
    try {
      await retryReply(desk.deskToken, {
        threadId: currentThreadId,
        messageId,
      });
      model.patchMessage(messageId, { reply: { status: "pending" } });
      forceScrollBottom = true;
      renderMessages();
      await maybeCheckRunner(true);
    } catch (err) {
      if (err instanceof ApiError && err.kind === "unpaired") {
        await handleUnpaired("This phone was unpaired on the Hub");
        return;
      }
      // Leave reply.error as-is; user can try again
    }
  }

  textarea.addEventListener("input", () => {
    syncSendEnabled();
    autosize();
  });
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!sendBtn.disabled) void doSend({ text: textarea.value });
    }
    // Plain Enter → newline (default); do not send on mobile
  });
  sendBtn.addEventListener("click", () => {
    if (!sendBtn.disabled) void doSend({ text: textarea.value });
  });

  if (isDraft()) {
    renderMessages();
    // Composer-only session: cleanup viewport on leave; real poller starts after first send
    activePoller = {
      __isDraftStub: true,
      stop() {},
      start() {},
      setIntervalMs() {},
      get running() {
        return false;
      },
      _cleanup: () => {
        unbindViewport();
        root.classList.remove("has-composer");
      },
    };
    return;
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
      empty.appendChild(
        el("p", null, "This thread isn't shared with this phone"),
      );
      messagesEl.appendChild(empty);
      sendBtn.disabled = true;
      textarea.disabled = true;
      activePoller = {
        stop() {},
        start() {},
        setIntervalMs() {},
        get running() {
          return false;
        },
        _cleanup: () => {
          unbindViewport();
          root.classList.remove("has-composer");
        },
      };
      return;
    }
    messagesEl.replaceChildren();
    messagesEl.appendChild(
      el("div", "notice error", err?.message || "Couldn't load messages"),
    );
    activePoller = {
      stop() {},
      start() {},
      setIntervalMs() {},
      get running() {
        return false;
      },
      _cleanup: () => {
        unbindViewport();
        root.classList.remove("has-composer");
      },
    };
    return;
  }

  await ensurePoller();
  const ui0 = deriveComposeUi({
    messages: model.list(),
    pendingSends,
    runner,
  });
  if (ui0.shouldCheckRunner) await maybeCheckRunner(true);
}

/* ── Settings view ─────────────────────────────────────────────────── */

async function renderSettingsView(root) {
  clearPoller();
  root.replaceChildren();
  root.classList.remove("has-composer");

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

  const runnerRow = el("div", "settings-row");
  runnerRow.appendChild(el("strong", null, "Runner"));
  const runnerLine = el("small", null, "…");
  runnerRow.appendChild(runnerLine);
  panel.appendChild(runnerRow);

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

  try {
    const data = await runnerStatus(desk.deskToken);
    runnerLine.textContent = formatRunnerStatusLine(data?.runner);
  } catch (err) {
    runnerLine.textContent =
      err instanceof ApiError && err.kind === "unpaired"
        ? "unpaired"
        : "unreachable";
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
