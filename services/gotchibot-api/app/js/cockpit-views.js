/**
 * Read-only cockpit sections from the desk snapshot: agent roster, kanban,
 * bot inbox, Hub network. Actions (spawn, reply, re-pair) stay on the desk.
 */
import { iconChevronLeft, iconRefresh } from "./icons.js";
import { hubUrl } from "./api.js";
import { relativeTime } from "./thread-model.js";
import { app, clearPoller, navigate } from "./state.js";
import { el, heroAvatar, iconButton, statusPill, topNav } from "./ui.js";
import { shortAddress } from "./desk-model.js";
import { loadCockpit, snapshotLine } from "./cockpit.js";

const TITLES = {
  roster: "Agent roster",
  kanban: "Kanban",
  inbox: "Bot inbox",
  hub: "Hub network",
};

function emptyLine(text) {
  return el("p", "empty-line", text);
}

function agentRow({ id, name, collateral, status, meta, task }) {
  const row = el("li", "cv-row");
  row.appendChild(heroAvatar({ id, name, collateral }, { size: 32 }));
  const body = el("div", "cv-body");
  const top = el("div", "cv-top");
  top.appendChild(el("span", "cv-name", name || id));
  if (status) top.appendChild(statusPill(status));
  body.appendChild(top);
  if (meta) body.appendChild(el("p", "cv-meta", meta));
  if (task) body.appendChild(el("p", "cv-task", task));
  row.appendChild(body);
  return row;
}

function renderRoster(main, c) {
  const r = c.roster;
  const bits = [];
  if (r.heroes != null) bits.push(`${r.heroes} on the cartridge`);
  if (r.local != null) bits.push(`${r.local} local`);
  bits.push(r.remoteOk ? "iMac reachable" : `iMac offline${r.remoteReason ? ` (${r.remoteReason})` : ""}`);
  main.appendChild(el("p", "cv-summary", bits.join(" · ")));
  if (!r.agents.length) {
    main.appendChild(emptyLine("No agents in the snapshot."));
    return;
  }
  const ul = el("ul", "cv-list");
  for (const a of r.agents) {
    ul.appendChild(
      agentRow({
        ...a,
        meta: [a.host, a.kind, a.collateral?.toUpperCase()].filter(Boolean).join(" · "),
      }),
    );
  }
  main.appendChild(ul);
}

function renderKanban(main, c) {
  const k = c.kanban;
  if (k.seatsTotal != null) {
    main.appendChild(el("p", "cv-summary", `Seats ${k.seatsUsed ?? 0}/${k.seatsTotal} used · ${k.seatsFree ?? 0} free`));
  }
  if (!k.columns.length) {
    main.appendChild(emptyLine("No kanban in the snapshot."));
    return;
  }
  for (const col of k.columns) {
    const section = el("section", "cv-column");
    const head = el("div", "section-head");
    head.appendChild(el("h2", null, col.title || col.key));
    head.appendChild(el("span", "section-count", String(col.cards.length)));
    section.appendChild(head);
    if (!col.cards.length) {
      section.appendChild(emptyLine("—"));
    } else {
      const ul = el("ul", "cv-list");
      for (const card of col.cards) {
        const meta = [card.chief ? "chief" : null, card.role, card.host, card.age, card.stale ? "stale" : null]
          .filter(Boolean)
          .join(" · ");
        ul.appendChild(agentRow({ ...card, meta, task: card.task }));
      }
      section.appendChild(ul);
    }
    main.appendChild(section);
  }
}

function renderInbox(main, c) {
  const i = c.inbox;
  main.appendChild(
    el("p", "cv-summary", `${i.unread} unread${i.project ? ` · ${i.project}` : ""} · reply on the desk (gotchibot inbox)`),
  );
  if (!i.messages.length) {
    main.appendChild(emptyLine("Inbox is empty."));
    return;
  }
  const ul = el("ul", "cv-list");
  for (const m of i.messages) {
    const row = el("li", `cv-row cv-msg${m.read ? "" : " unread"}`);
    const body = el("div", "cv-body");
    const top = el("div", "cv-top");
    top.appendChild(el("span", "cv-name", m.subject || "(no subject)"));
    if (m.kind) top.appendChild(el("span", "tag", m.kind));
    body.appendChild(top);
    body.appendChild(el("p", "cv-meta", [m.from, relativeTime(m.ts)].filter(Boolean).join(" · ")));
    if (m.body) body.appendChild(el("p", "cv-task", m.body));
    row.appendChild(body);
    ul.appendChild(row);
  }
  main.appendChild(ul);
}

function renderHub(main, c) {
  const h = c.hub;
  const rows = [
    ["desk", h.deskName || "—"],
    ["desk → Hub", h.deskPaired ? "paired" : h.hubInstalled ? "this computer is the Hub" : "not set up"],
    ["Hub host", h.hubHost || "—"],
    ["this phone", app.desk?.name || "—"],
    ["phone → Hub", hubUrl("/").replace(/\/$/, "")],
    ["owner wallet", app.desk?.walletAddress ? `${shortAddress(app.desk.walletAddress)} · verified` : "—"],
  ];
  const card = el("section", "cockpit-header");
  const dl = el("dl", "cockpit-rows");
  for (const [label, value] of rows) dl.append(el("dt", null, label), el("dd", null, value));
  card.appendChild(dl);
  main.appendChild(card);
  main.appendChild(el("p", "subtle", "Change the Hub on the desk: gotchibot hub join · gotchibot hub network"));
}

const RENDERERS = { roster: renderRoster, kanban: renderKanban, inbox: renderInbox, hub: renderHub };

export async function renderCockpitSection(root, view) {
  clearPoller();
  root.replaceChildren();
  root.className = "app-shell";
  const back = iconButton(iconChevronLeft(22), "Cockpit", () => navigate("#/cockpit"));
  root.appendChild(topNav({ title: TITLES[view] || "Cockpit", left: back, center: true }));
  const main = el("main", "cockpit cockpit-view");
  root.appendChild(main);
  main.appendChild(el("div", "project-card skeleton"));

  let busy = false;
  async function paint(force) {
    if (busy) return;
    busy = true;
    let snap = app.cockpit;
    let error = null;
    try {
      snap = await loadCockpit({ force });
      if (snap === null) return;
    } catch (err) {
      error = err?.message || "Couldn't reach the Hub";
    } finally {
      busy = false;
    }
    main.replaceChildren();
    const status = el("div", "cockpit-status");
    status.appendChild(el("span", "subtle", snapshotLine(snap)));
    status.appendChild(iconButton(iconRefresh(16), "Refresh", () => void paint(true), "icon-btn small"));
    main.appendChild(status);
    if (error) main.appendChild(el("div", "notice error", error));
    if (snap?.cockpit) RENDERERS[view]?.(main, snap.cockpit);
  }

  await paint(false);
}
