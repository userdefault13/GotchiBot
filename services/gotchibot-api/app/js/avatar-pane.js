/**
 * Avatar pane — slides in from the right over a project chat. Phone twin of
 * the desk's tmux avatar pane: who is on the project, what they're doing,
 * and the board at a glance.
 */
import { iconClose } from "./icons.js";
import { ApiError, getProject } from "./api.js";
import { relativeTime } from "./thread-model.js";
import { app, handleUnpaired } from "./state.js";
import { el, heroAvatar, iconButton, statusPill } from "./ui.js";
import { kanbanSegments, roleLabel } from "./desk-model.js";

function heroRow(h, now) {
  const row = el("li", "crew-row");
  row.appendChild(heroAvatar(h, { size: 44, ring: true }));
  const info = el("div", "crew-info");
  const top = el("div", "crew-top");
  top.appendChild(el("strong", "crew-name", h.name || h.id));
  top.appendChild(statusPill(h.status));
  info.appendChild(top);
  const meta = [roleLabel(h.role)];
  if (h.host) meta.push(h.host);
  if (h.updatedAt) meta.push(relativeTime(h.updatedAt, now));
  info.appendChild(el("p", "crew-meta", meta.join(" · ")));
  row.appendChild(info);
  return row;
}

function boardSummary(project) {
  const wrap = el("section", "pane-section");
  wrap.appendChild(el("h4", "pane-heading", "Board"));
  const segs = kanbanSegments(project.kanban);
  const bar = el("div", "kanban-bar tall");
  for (const s of segs) {
    const seg = el("span", `kanban-seg col-${s.column}`);
    seg.style.width = `${s.pct}%`;
    bar.appendChild(seg);
  }
  if (!segs.length) bar.classList.add("empty");
  wrap.appendChild(bar);
  const legend = el("div", "kanban-legend");
  for (const col of ["todo", "doing", "review", "done"]) {
    const item = el("span", `legend-item col-${col}`);
    item.appendChild(el("span", "legend-swatch"));
    item.appendChild(document.createTextNode(`${project.kanban?.[col] || 0} ${col}`));
    legend.appendChild(item);
  }
  wrap.appendChild(legend);

  const active = (project.cards || []).filter((c) => c.column !== "done").slice(0, 6);
  if (active.length) {
    const ul = el("ul", "card-list");
    const byId = new Map((project.roster || []).map((h) => [h.id, h]));
    for (const c of active) {
      const li = el("li", "card-row");
      li.appendChild(el("span", `card-col col-${c.column}`, c.column));
      li.appendChild(el("span", "card-title", c.title));
      const owner = c.owner ? byId.get(c.owner) : null;
      if (owner) li.appendChild(heroAvatar(owner, { size: 20 }));
      ul.appendChild(li);
    }
    wrap.appendChild(ul);
  }
  return wrap;
}

/**
 * @param {string} slug
 * @param {{ onClose?: () => void }} [opts]
 * @returns {{ close: () => void }}
 */
export function openAvatarPane(slug, { onClose } = {}) {
  const backdrop = el("div", "pane-backdrop");
  const pane = el("aside", "avatar-pane");
  pane.setAttribute("role", "dialog");
  pane.setAttribute("aria-modal", "true");
  pane.setAttribute("aria-label", "Project crew");

  const head = el("header", "pane-head");
  const titles = el("div", "pane-titles");
  const cached = app.projects.get(slug);
  const h2 = el("h2", null, cached?.title || slug);
  const sub = el("p", "pane-sub", "Crew");
  titles.append(h2, sub);
  head.appendChild(titles);
  head.appendChild(iconButton(iconClose(20), "Close", () => close()));
  pane.appendChild(head);

  const body = el("div", "pane-body");
  body.appendChild(el("div", "pane-loading", "Loading crew…"));
  pane.appendChild(body);
  backdrop.appendChild(pane);
  document.body.appendChild(backdrop);
  document.body.classList.add("no-scroll");
  requestAnimationFrame(() => backdrop.classList.add("open"));

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey);
    document.body.classList.remove("no-scroll");
    backdrop.classList.remove("open");
    setTimeout(() => backdrop.remove(), 240);
    onClose?.();
  }
  function onKey(e) {
    if (e.key === "Escape") close();
  }
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });

  // Swipe right to dismiss
  let startX = null;
  let dx = 0;
  pane.addEventListener(
    "touchstart",
    (e) => {
      startX = e.touches[0].clientX;
      dx = 0;
    },
    { passive: true },
  );
  pane.addEventListener(
    "touchmove",
    (e) => {
      if (startX == null) return;
      dx = Math.max(0, e.touches[0].clientX - startX);
      pane.style.transform = dx ? `translateX(${dx}px)` : "";
    },
    { passive: true },
  );
  pane.addEventListener("touchend", () => {
    pane.style.transform = "";
    if (dx > 80) close();
    startX = null;
  });

  void (async () => {
    try {
      const data = await getProject(app.desk.deskToken, slug);
      const p = data?.project;
      if (!p || closed) return;
      app.projects.set(slug, { ...app.projects.get(slug), ...p });
      h2.textContent = p.title;
      if (p.accent) pane.style.setProperty("--accent", p.accent);
      const units = p.units ? ` · ${p.units.running || 0} running` : "";
      sub.textContent = `${p.roster.length} gotchi${p.roster.length === 1 ? "" : "s"}${units}`;

      const now = Date.now();
      body.replaceChildren();
      if (p.goal) {
        const goal = el("section", "pane-section");
        goal.appendChild(el("h4", "pane-heading", "Goal"));
        goal.appendChild(el("p", "pane-goal", p.goal));
        body.appendChild(goal);
      }

      const orch = p.roster.filter((h) => h.orchestrator);
      const crew = p.roster.filter((h) => !h.orchestrator);
      if (orch.length) {
        const s = el("section", "pane-section");
        s.appendChild(el("h4", "pane-heading", "Orchestrator"));
        const ul = el("ul", "crew-list");
        for (const h of orch) ul.appendChild(heroRow(h, now));
        s.appendChild(ul);
        body.appendChild(s);
      }
      const s = el("section", "pane-section");
      s.appendChild(el("h4", "pane-heading", `Crew · ${crew.length}`));
      if (crew.length) {
        const ul = el("ul", "crew-list");
        for (const h of crew) ul.appendChild(heroRow(h, now));
        s.appendChild(ul);
      } else {
        s.appendChild(el("p", "subtle", "No gotchis on this project's roster yet."));
      }
      body.appendChild(s);
      body.appendChild(boardSummary(p));
    } catch (err) {
      if (err instanceof ApiError && err.kind === "unpaired") {
        close();
        await handleUnpaired("This phone was signed out on the Hub");
        return;
      }
      body.replaceChildren(el("div", "notice error", err?.message || "Couldn't load crew"));
    }
  })();

  return { close };
}
