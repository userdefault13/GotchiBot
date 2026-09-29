/**
 * Project chat — one thread at a time inside a project (or General).
 * Header: back · project/thread title · history sheet · crew (avatar pane).
 * Send / poll / retry behavior is the S2 composer, unchanged.
 */
import { iconArrowUp, iconChevronLeft, iconCrew, iconHistory, iconPlus } from "./icons.js";
import { renderMarkdown } from "./markdown.js";
import { createThreadModel, relativeTime, roleClass } from "./thread-model.js";
import {
  deriveComposeUi,
  newClientMessageId,
  pullAfterForReplyWatch,
  POLL_INTERVAL_NORMAL_MS,
  RUNNER_CHECK_MIN_MS,
} from "./compose-model.js";
import { createPoller } from "./poller.js";
import {
  ApiError,
  getProject,
  getProjectDesk,
  listThreads,
  pullMessages,
  retryReply,
  runnerStatus,
  sendMessage,
} from "./api.js";
import {
  app,
  clearPoller,
  handleUnpaired,
  navigate,
  rememberThreadTitles,
  setViewCleanup,
  shortThreadId,
} from "./state.js";
import { el, heroAvatar, iconButton, openSheet, setNavTitle, topNav } from "./ui.js";
import { openAvatarPane } from "./avatar-pane.js";
import { GENERAL, NEW_THREAD_ID, chatHash, suggestionPrompts } from "./desk-model.js";

/** Server filter for this chat's project. */
function threadFilter(project) {
  return project === GENERAL ? "none" : project;
}

async function projectInfo(slug) {
  if (slug === GENERAL) return { slug: GENERAL, title: "General" };
  const cached = app.projects.get(slug);
  if (cached?.roster) return cached;
  try {
    const data = await getProject(app.desk.deskToken, slug);
    if (data?.project) {
      app.projects.set(slug, { ...cached, ...data.project });
      return app.projects.get(slug);
    }
  } catch (err) {
    if (err instanceof ApiError && err.kind === "unpaired") throw err;
  }
  return cached || { slug, title: slug };
}

/**
 * Keep the fixed composer above the iOS keyboard via visualViewport.
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

/**
 * @param {HTMLElement} root
 * @param {{ project: string, threadId: string|null }} route
 */
export async function renderChatView(root, route) {
  clearPoller();
  const project = route.project || GENERAL;

  // No thread in the URL → a project opens its desk; General opens its latest chat, else a draft.
  if (!route.threadId) {
    let latest = null;
    try {
      if (project !== GENERAL) {
        const desk = await getProjectDesk(app.desk.deskToken, project).catch((err) => {
          if (err instanceof ApiError && err.kind === "unpaired") throw err;
          return null;
        });
        if (desk?.threadId) {
          app.threadTitles.set(desk.threadId, "Desk");
          latest = desk.threadId;
        }
      }
      if (!latest) {
        const data = await listThreads(app.desk.deskToken, 1, threadFilter(project));
        rememberThreadTitles(data?.threads);
        latest = data?.threads?.[0]?.threadId || null;
      }
    } catch (err) {
      if (err instanceof ApiError && err.kind === "unpaired") {
        await handleUnpaired("This phone was signed out on the Hub");
        return;
      }
    }
    navigate(chatHash(project, latest || NEW_THREAD_ID), { replace: true });
    return;
  }

  root.replaceChildren();
  root.className = "app-shell has-composer";

  /** @type {string|null} */
  let currentThreadId = route.threadId === NEW_THREAD_ID ? null : String(route.threadId);
  const isDraft = () => !currentThreadId;
  /** @type {import("./compose-model.js").PendingSend[]} */
  let pendingSends = [];
  /** @type {{ status?: string, detail?: string|null, model?: string|null }|null} */
  let runner = null;
  let lastRunnerCheckAt = 0;
  let forceScrollBottom = false;
  /** @type {{ close: () => void }|null} */
  let pane = null;

  const cachedProject = app.projects.get(project);
  const projectTitle = project === GENERAL ? "General" : cachedProject?.title || project;

  const back = iconButton(iconChevronLeft(22), "Cockpit", () => navigate("#/cockpit"));
  const actions = el("div", "nav-actions");
  actions.appendChild(iconButton(iconHistory(20), "Chat history", () => void openHistory()));
  /** @type {HTMLButtonElement|null} */
  let crewBtn = null;
  if (project !== GENERAL) {
    crewBtn = iconButton(iconCrew(20), "Crew", () => openCrew(), "icon-btn crew-btn");
    actions.appendChild(crewBtn);
  }
  root.appendChild(
    topNav({
      title: projectTitle,
      subtitle: isDraft() ? "New chat" : app.threadTitles.get(currentThreadId) || null,
      left: back,
      right: actions,
      center: true,
    }),
  );

  const wrap = el("div", "messages-wrap");
  const messagesEl = el("div", "messages");
  wrap.appendChild(messagesEl);
  root.appendChild(wrap);

  const composer = el("div", "composer");
  const field = el("div", "composer-field");
  const textarea = el("textarea", "composer-input");
  textarea.rows = 1;
  textarea.placeholder = project === GENERAL ? "Ask GotchiBot…" : `Ask the ${projectTitle} crew…`;
  textarea.setAttribute("enterkeyhint", "enter");
  textarea.setAttribute("aria-label", "Message");
  const sendBtn = el("button", "composer-send");
  sendBtn.type = "button";
  sendBtn.setAttribute("aria-label", "Send");
  sendBtn.innerHTML = iconArrowUp(18);
  sendBtn.disabled = true;
  field.append(textarea, sendBtn);
  composer.appendChild(field);
  root.appendChild(composer);

  const unbindViewport = bindComposerViewport(composer);
  const model = createThreadModel();

  function viewCleanup() {
    unbindViewport();
    pane?.close();
  }

  function openCrew() {
    if (pane) return;
    pane = openAvatarPane(project, { onClose: () => (pane = null) });
  }

  // Crew button shows the orchestrator's face once the project detail loads.
  void projectInfo(project)
    .then((info) => {
      setNavTitle(root, info.title);
      const lead = info.roster?.find((h) => h.orchestrator) || info.roster?.[0];
      if (lead && crewBtn) {
        crewBtn.replaceChildren(heroAvatar(lead, { size: 28, ring: true }));
        crewBtn.classList.add("has-face");
      }
      if (isDraft()) renderMessages();
    })
    .catch(async (err) => {
      if (err instanceof ApiError && err.kind === "unpaired") {
        await handleUnpaired("This phone was signed out on the Hub");
      }
    });

  async function openHistory() {
    const body = el("div", "history");
    const newBtn = el("button", "btn-primary btn-block");
    newBtn.type = "button";
    newBtn.innerHTML = `${iconPlus(18)}<span>New chat</span>`;
    body.appendChild(newBtn);
    const listEl = el("ul", "history-list");
    listEl.appendChild(el("li", "subtle", "Loading…"));
    body.appendChild(listEl);
    const sheet = openSheet({ title: `${projectTitle} chats`, body });
    newBtn.addEventListener("click", () => {
      sheet.close();
      navigate(chatHash(project, NEW_THREAD_ID));
    });
    try {
      const data = await listThreads(app.desk.deskToken, 100, threadFilter(project));
      const threads = [...(data?.threads || [])].sort(
        (a, b) => Number(b.kind === "desk") - Number(a.kind === "desk"),
      );
      rememberThreadTitles(threads);
      listEl.replaceChildren();
      if (!threads.length) listEl.appendChild(el("li", "subtle", "No chats yet."));
      const now = Date.now();
      for (const t of threads) {
        const li = el("li", `history-item${t.threadId === currentThreadId ? " active" : ""}`);
        const btn = el("button", "history-btn");
        btn.type = "button";
        btn.appendChild(el("span", "history-title", app.threadTitles.get(t.threadId) || t.threadId));
        const when = t.lastMessageAt || t.updatedAt;
        btn.appendChild(el("span", "history-when", when ? relativeTime(when, now) : ""));
        if (t.shared) btn.appendChild(el("span", "badge shared", "shared"));
        btn.addEventListener("click", () => {
          sheet.close();
          navigate(chatHash(project, t.threadId));
        });
        li.appendChild(btn);
        listEl.appendChild(li);
      }
    } catch (err) {
      listEl.replaceChildren(el("li", "msg-error", err?.message || "Couldn't load chats"));
    }
  }

  function syncSendEnabled() {
    sendBtn.disabled = !textarea.value.trim();
  }

  function autosize() {
    textarea.style.height = "auto";
    const max = Math.round(1.45 * 16 * 6 + 20);
    textarea.style.height = `${Math.min(textarea.scrollHeight, max)}px`;
  }

  function setThreadSubtitle() {
    if (isDraft()) {
      setNavTitle(root, null, "New chat");
      return;
    }
    const known = app.threadTitles.get(currentThreadId);
    setNavTitle(root, null, known || shortThreadId(currentThreadId));
  }

  function nearBottom() {
    const d = document.documentElement;
    return d.scrollHeight - d.scrollTop - d.clientHeight < 120;
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
    });
  }

  function applyPollInterval(ui) {
    if (app.poller && typeof app.poller.setIntervalMs === "function") {
      app.poller.setIntervalMs(ui.pollIntervalMs);
    }
  }

  function emptyDraft() {
    const empty = el("div", "chat-empty");
    const info = app.projects.get(project) || { slug: project, title: projectTitle };
    const lead = info.roster?.find((h) => h.orchestrator) || info.roster?.[0];
    if (lead) {
      empty.appendChild(heroAvatar(lead, { size: 72 }));
    } else {
      const logo = el("img", "chat-empty-logo");
      logo.src = "icons/icon-192.png";
      logo.alt = "";
      empty.appendChild(logo);
    }
    empty.appendChild(
      el("h2", null, project === GENERAL ? "What should we work on?" : info.title || projectTitle),
    );
    if (info.goal) empty.appendChild(el("p", "chat-empty-goal", info.goal));
    const chips = el("div", "suggestions");
    for (const text of suggestionPrompts(project === GENERAL ? null : info)) {
      const chip = el("button", "suggestion", text);
      chip.type = "button";
      chip.addEventListener("click", () => void doSend({ text }));
      chips.appendChild(chip);
    }
    empty.appendChild(chips);
    return empty;
  }

  function renderMessages() {
    const stick = forceScrollBottom || nearBottom();
    forceScrollBottom = false;

    const ui = deriveComposeUi({ messages: model.list(), pendingSends, runner });
    applyPollInterval(ui);
    messagesEl.replaceChildren();

    if (isDraft() && !model.list().length && !ui.optimistic.length) {
      messagesEl.appendChild(emptyDraft());
    }

    for (const m of model.list()) {
      const cls = roleClass(m.role);
      const article = el("article", `message ${cls}`);
      if (cls !== "user") {
        const header = el("header");
        header.appendChild(el("strong", null, cls === "assistant" ? "GotchiBot" : cls));
        let timeLabel = m.ts ? relativeTime(m.ts) : "";
        if (m.edited) timeLabel = timeLabel ? `${timeLabel} · edited` : "edited";
        header.appendChild(el("small", null, timeLabel));
        article.appendChild(header);
      }
      const content = el("div", "message-content");
      content.innerHTML = renderMarkdown(m.text || "");
      article.appendChild(content);
      const via = m.messageId && ui.viaModelByMessageId.get(String(m.messageId));
      if (via && cls === "assistant") {
        const meta = el("div", "message-meta");
        meta.appendChild(el("span", "msg-via", `via ${via}`));
        article.appendChild(meta);
      }
      messagesEl.appendChild(article);
    }

    for (const p of ui.optimistic) {
      const article = el("article", "message user pending");
      const content = el("div", "message-content");
      content.innerHTML = renderMarkdown(p.text || "");
      article.appendChild(content);
      const meta = el("div", "message-meta");
      const discard = () => {
        pendingSends = pendingSends.filter((x) => x.clientMessageId !== p.clientMessageId);
        renderMessages();
      };
      if (p.status === "sending") {
        meta.appendChild(el("span", "msg-status", "sending…"));
      } else if (p.forbidden) {
        meta.appendChild(el("span", "msg-error", "This thread isn't shared with this phone"));
        const d = el("button", "link-btn danger", "Discard");
        d.type = "button";
        d.addEventListener("click", discard);
        meta.appendChild(d);
      } else {
        meta.appendChild(el("span", "msg-error", p.error || "Send failed"));
        const retry = el("button", "link-btn", "Retry");
        retry.type = "button";
        retry.addEventListener("click", () => {
          void doSend({ text: p.text, clientMessageId: p.clientMessageId, isRetry: true });
        });
        const d = el("button", "link-btn danger", "Discard");
        d.type = "button";
        d.addEventListener("click", discard);
        meta.append(retry, d);
      }
      article.appendChild(meta);
      messagesEl.appendChild(article);
    }

    if (ui.waitingForReply) {
      const row = el("div", "thinking-row");
      const label = el("span", "thinking-label");
      label.appendChild(document.createTextNode("gotchi is thinking"));
      const dots = el("span", "thinking-dots");
      for (let i = 0; i < 3; i++) dots.appendChild(el("span", null, "."));
      label.appendChild(dots);
      row.appendChild(label);
      if (ui.runnerNotice) row.appendChild(el("div", "runner-notice", ui.runnerNotice));
      messagesEl.appendChild(row);
    }

    if (ui.replyError) {
      const row = el("div", "reply-error-row");
      row.appendChild(el("span", "msg-error", ui.replyError.error));
      const retry = el("button", "link-btn", "Retry");
      retry.type = "button";
      retry.addEventListener("click", () => void doRetryReply(ui.replyError.messageId));
      row.appendChild(retry);
      messagesEl.appendChild(row);
    }

    if (stick) scrollToBottom();
  }

  async function maybeCheckRunner(force = false) {
    const ui = deriveComposeUi({ messages: model.list(), pendingSends, runner });
    if (!ui.shouldCheckRunner && !force) return;
    const now = Date.now();
    if (!force && now - lastRunnerCheckAt < RUNNER_CHECK_MIN_MS) return;
    lastRunnerCheckAt = now;
    try {
      const data = await runnerStatus(app.desk.deskToken);
      runner = data?.runner || null;
      renderMessages();
    } catch {
      /* non-blocking */
    }
  }

  async function pullAll() {
    let after = 0;
    let guard = 0;
    do {
      const data = await pullMessages(app.desk.deskToken, {
        threadId: currentThreadId,
        after,
        limit: 500,
      });
      model.applyMessages(data?.messages || []);
      after = data?.nextAfter ?? model.lastSeq;
      if (!data?.hasMore) break;
      guard += 1;
    } while (guard < 50);
    forceScrollBottom = true;
    renderMessages();
  }

  function startPoller() {
    const poller = createPoller({
      intervalMs: POLL_INTERVAL_NORMAL_MS,
      isVisible: () => document.visibilityState === "visible",
      tick: async () => {
        if (!currentThreadId) return;
        try {
          const after = pullAfterForReplyWatch(model.list(), model.lastSeq);
          const data = await pullMessages(app.desk.deskToken, {
            threadId: currentThreadId,
            after,
            limit: 500,
          });
          const msgs = data?.messages || [];
          if (msgs.length) {
            model.applyMessages(msgs);
            const confirmed = new Set(msgs.map((m) => m?.messageId).filter(Boolean).map(String));
            if (confirmed.size) {
              pendingSends = pendingSends.filter((p) => !confirmed.has(String(p.clientMessageId)));
            }
            renderMessages();
          } else {
            applyPollInterval(deriveComposeUi({ messages: model.list(), pendingSends, runner }));
          }
          await maybeCheckRunner(false);
        } catch (err) {
          if (err instanceof ApiError && err.kind === "unpaired") {
            await handleUnpaired("This phone was signed out on the Hub");
          }
          if (err instanceof ApiError && err.kind === "not-found") clearPoller();
        }
      },
    });

    function onVis() {
      if (app.poller !== poller) return;
      if (document.visibilityState === "visible") {
        if (!poller.running) poller.start();
      } else if (poller.running) {
        poller.stop();
      }
    }
    document.addEventListener("visibilitychange", onVis);
    /** @type {any} */ (poller)._cleanup = () => {
      document.removeEventListener("visibilitychange", onVis);
      viewCleanup();
    };
    app.poller = poller;
    if (document.visibilityState === "visible") poller.start();
  }

  /** @param {{ text: string, clientMessageId?: string, isRetry?: boolean }} opts */
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
        p.clientMessageId === id ? { clientMessageId: id, text: trimmed, status: "sending" } : p,
      );
    }
    forceScrollBottom = true;
    renderMessages();

    try {
      /** @type {{ threadId?: string, clientMessageId: string, text: string, project?: string }} */
      const body = { clientMessageId: id, text: trimmed };
      if (currentThreadId) body.threadId = currentThreadId;
      else if (project !== GENERAL) body.project = project;

      const result = await sendMessage(app.desk.deskToken, body);
      if (!result?.ok) throw new ApiError("http", 500, "Send failed");

      // Promote draft → real thread without remounting
      if (!currentThreadId && result.threadId) {
        currentThreadId = String(result.threadId);
        app.threadTitles.set(currentThreadId, trimmed.slice(0, 60));
        history.replaceState(null, "", chatHash(project, currentThreadId));
        setThreadSubtitle();
        // Swap the draft's cleanup stub for the real poller (same view — no teardown)
        app.poller = null;
        startPoller();
      }

      pendingSends = pendingSends.filter((p) => p.clientMessageId !== id);
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
      try {
        const data = await pullMessages(app.desk.deskToken, {
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
    } catch (err) {
      if (err instanceof ApiError && err.kind === "unpaired") {
        await handleUnpaired("This phone was signed out on the Hub");
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
              error: forbidden ? "This thread isn't shared with this phone" : err?.message || "Send failed",
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
      await retryReply(app.desk.deskToken, { threadId: currentThreadId, messageId });
      model.patchMessage(messageId, { reply: { status: "pending" } });
      forceScrollBottom = true;
      renderMessages();
      await maybeCheckRunner(true);
    } catch (err) {
      if (err instanceof ApiError && err.kind === "unpaired") {
        await handleUnpaired("This phone was signed out on the Hub");
      }
    }
  }

  textarea.addEventListener("input", () => {
    syncSendEnabled();
    autosize();
  });
  textarea.addEventListener("keydown", (e) => {
    // Plain Enter = newline on mobile; Cmd/Ctrl+Enter sends
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!sendBtn.disabled) void doSend({ text: textarea.value });
    }
  });
  sendBtn.addEventListener("click", () => {
    if (!sendBtn.disabled) void doSend({ text: textarea.value });
  });

  if (isDraft()) {
    renderMessages();
    setViewCleanup(viewCleanup);
    return;
  }

  setThreadSubtitle();
  try {
    await pullAll();
    // Deep link / reload: fill the subtitle from the thread list once
    if (!app.threadTitles.has(currentThreadId)) {
      const data = await listThreads(app.desk.deskToken, 100, threadFilter(project)).catch(() => null);
      rememberThreadTitles(data?.threads);
      setThreadSubtitle();
    }
  } catch (err) {
    if (err instanceof ApiError && err.kind === "unpaired") {
      await handleUnpaired("This phone was signed out on the Hub");
      return;
    }
    messagesEl.replaceChildren();
    const msg =
      err instanceof ApiError && err.kind === "not-found"
        ? "This chat isn't shared with this phone"
        : err?.message || "Couldn't load messages";
    const empty = el("div", "empty-state");
    empty.appendChild(el("p", null, msg));
    messagesEl.appendChild(empty);
    if (err instanceof ApiError && err.kind === "not-found") {
      sendBtn.disabled = true;
      textarea.disabled = true;
    }
    setViewCleanup(viewCleanup);
    return;
  }

  startPoller();
  const ui0 = deriveComposeUi({ messages: model.list(), pendingSends, runner });
  if (ui0.shouldCheckRunner) await maybeCheckRunner(true);
}
