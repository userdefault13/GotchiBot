/**
 * Portfolio — home screen. Every pstack project on the Hub as a card, plus a
 * "General" card for chats with no project, and an ask bar that opens a new
 * general chat.
 */
import { iconArrowUp, iconChat, iconSearch, iconSettings } from "./icons.js";
import { ApiError, listProjects, listThreads } from "./api.js";
import { relativeTime } from "./thread-model.js";
import { app, clearPoller, handleUnpaired, navigate, rememberThreadTitles } from "./state.js";
import { el, heroAvatar, iconButton, topNav } from "./ui.js";
import {
  GENERAL,
  NEW_THREAD_ID,
  chatHash,
  filterProjects,
  greeting,
  groupThreadsByProject,
  kanbanSegments,
  shortAddress,
} from "./desk-model.js";

function kanbanBar(kanban) {
  const segs = kanbanSegments(kanban);
  const bar = el("div", "kanban-bar");
  if (!segs.length) {
    bar.classList.add("empty");
    return bar;
  }
  for (const s of segs) {
    const seg = el("span", `kanban-seg col-${s.column}`);
    seg.style.width = `${s.pct}%`;
    seg.title = `${s.count} ${s.column}`;
    bar.appendChild(seg);
  }
  return bar;
}

function projectCard(p, threads, now) {
  const card = el("article", "project-card");
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  if (p.accent) card.style.setProperty("--accent", p.accent);

  const head = el("div", "project-head");
  const titleWrap = el("div", "project-title-wrap");
  const h3 = el("h3", null, p.title);
  titleWrap.appendChild(h3);
  const tags = el("div", "project-tags");
  if (p.current) tags.appendChild(el("span", "tag tag-accent", "current"));
  if (p.working) tags.appendChild(el("span", "tag tag-live", `${p.working} working`));
  else if (p.units?.running) tags.appendChild(el("span", "tag tag-live", `${p.units.running} running`));
  titleWrap.appendChild(tags);
  head.appendChild(titleWrap);

  const stack = el("div", "avatar-stack");
  for (const h of p.heroes || []) stack.appendChild(heroAvatar(h, { size: 26 }));
  if (p.heroCount > (p.heroes || []).length) {
    stack.appendChild(el("span", "avatar-more", `+${p.heroCount - p.heroes.length}`));
  }
  head.appendChild(stack);
  card.appendChild(head);

  if (p.goal) card.appendChild(el("p", "project-goal", p.goal));
  card.appendChild(kanbanBar(p.kanban));

  const foot = el("div", "project-foot");
  const k = p.kanban || {};
  const bits = [];
  if (k.doing) bits.push(`${k.doing} doing`);
  if (k.todo) bits.push(`${k.todo} to do`);
  if (k.done) bits.push(`${k.done} done`);
  if (!bits.length) bits.push(p.status || "draft");
  foot.appendChild(el("span", null, bits.join(" · ")));
  const last = threads?.[0];
  const when = last?.lastMessageAt || last?.updatedAt || p.updatedAt;
  const chatBit = threads?.length ? `${threads.length} chat${threads.length === 1 ? "" : "s"} · ` : "";
  foot.appendChild(el("span", null, `${chatBit}${when ? relativeTime(when, now) : ""}`));
  card.appendChild(foot);

  const open = () => navigate(chatHash(p.slug, null));
  card.addEventListener("click", open);
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  });
  return card;
}

function generalCard(threads, now) {
  const card = el("article", "project-card general-card");
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  const head = el("div", "project-head");
  const icon = el("span", "general-icon");
  icon.innerHTML = iconChat(20);
  const titleWrap = el("div", "project-title-wrap");
  titleWrap.appendChild(el("h3", null, "General"));
  titleWrap.appendChild(el("p", "project-goal", "Chats that aren't tied to a project"));
  head.append(icon, titleWrap);
  card.appendChild(head);
  const foot = el("div", "project-foot");
  const last = threads?.[0];
  foot.appendChild(el("span", null, threads?.length ? `${threads.length} chats` : "No chats yet"));
  foot.appendChild(el("span", null, last ? relativeTime(last.lastMessageAt || last.updatedAt, now) : ""));
  card.appendChild(foot);
  const open = () => navigate(chatHash(GENERAL, null));
  card.addEventListener("click", open);
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  });
  return card;
}

function skeletonCards(n = 3) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < n; i++) frag.appendChild(el("div", "project-card skeleton"));
  return frag;
}

export async function renderPortfolioView(root) {
  clearPoller();
  root.replaceChildren();
  root.className = "app-shell";

  const settingsBtn = iconButton(iconSettings(20), "Settings", () => navigate("#/settings"));
  const brand = el("div", "brand-mark");
  const logo = el("img", "brand-logo");
  logo.src = "icons/icon-32.png";
  logo.alt = "";
  brand.appendChild(logo);
  root.appendChild(topNav({ title: "GotchiBot", left: brand, right: settingsBtn }));

  const main = el("main", "portfolio");
  const hello = el("section", "hello");
  hello.appendChild(el("h2", "hello-title", greeting()));
  const who = app.desk?.walletAddress ? shortAddress(app.desk.walletAddress) : app.desk?.name;
  hello.appendChild(el("p", "hello-sub", who ? `Signed in as ${who}` : "Your projects"));
  main.appendChild(hello);

  const searchWrap = el("label", "search-field");
  const searchIcon = el("span", "search-icon");
  searchIcon.innerHTML = iconSearch(16);
  const search = el("input");
  search.type = "search";
  search.placeholder = "Search projects";
  search.setAttribute("aria-label", "Search projects");
  searchWrap.append(searchIcon, search);
  main.appendChild(searchWrap);

  const sectionHead = el("div", "section-head");
  sectionHead.appendChild(el("h2", null, "Projects"));
  const count = el("span", "section-count");
  sectionHead.appendChild(count);
  main.appendChild(sectionHead);

  const list = el("div", "project-list");
  list.appendChild(skeletonCards());
  main.appendChild(list);
  root.appendChild(main);

  // Grok-style ask bar → new general chat
  const ask = el("button", "ask-bar");
  ask.type = "button";
  ask.appendChild(el("span", "ask-placeholder", "Ask GotchiBot anything…"));
  const askGo = el("span", "ask-go");
  askGo.innerHTML = iconArrowUp(18);
  ask.appendChild(askGo);
  ask.addEventListener("click", () => navigate(chatHash(GENERAL, NEW_THREAD_ID)));
  root.appendChild(ask);
  root.classList.add("has-ask");

  let projects = [];
  let grouped = new Map();

  function render() {
    const now = Date.now();
    const shown = filterProjects(projects, search.value);
    list.replaceChildren();
    count.textContent = projects.length ? String(projects.length) : "";
    for (const p of shown) list.appendChild(projectCard(p, grouped.get(p.slug), now));
    if (!search.value.trim()) list.appendChild(generalCard(grouped.get(GENERAL), now));
    if (!shown.length && search.value.trim()) {
      list.appendChild(el("p", "empty-line", `No projects match “${search.value.trim()}”`));
    }
    if (!projects.length && !search.value.trim()) {
      const empty = el("div", "empty-state");
      empty.appendChild(el("p", null, "No projects on this Hub yet."));
      empty.appendChild(el("p", "subtle", "Start one on the desk: gotchibot project new"));
      list.prepend(empty);
    }
  }

  search.addEventListener("input", render);

  try {
    const [pData, tData] = await Promise.all([
      listProjects(app.desk.deskToken),
      listThreads(app.desk.deskToken, 200).catch(() => ({ threads: [] })),
    ]);
    projects = pData?.projects || [];
    for (const p of projects) app.projects.set(p.slug, { ...app.projects.get(p.slug), ...p });
    rememberThreadTitles(tData?.threads);
    grouped = groupThreadsByProject(tData?.threads);
    render();
  } catch (err) {
    if (err instanceof ApiError && err.kind === "unpaired") {
      await handleUnpaired("This phone was signed out on the Hub");
      return;
    }
    list.replaceChildren();
    const notice = el("div", "notice error", err?.message || "Couldn't load projects");
    const retry = el("button", "btn-secondary", "Retry");
    retry.type = "button";
    retry.addEventListener("click", () => void renderPortfolioView(root));
    list.append(notice, retry);
  }
}
