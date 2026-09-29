/**
 * Cockpit — the phone's root menu, modeled on the terminal desk cockpit:
 * header (wallet · cartridge · roster · orchestrator · project) and the same
 * numbered "What next?" menu. Rows the phone can't run are greyed "on desk".
 * Data comes from the desk's cockpit snapshot (GET /api/gotchibot/cockpit).
 */
import { iconRefresh, iconSettings } from "./icons.js";
import { ApiError, getCockpit, listProjects } from "./api.js";
import { getCurrentProject } from "./storage.js";
import { relativeTime } from "./thread-model.js";
import { app, clearPoller, handleUnpaired, navigate } from "./state.js";
import { el, iconButton, topNav } from "./ui.js";
import { cockpitHeaderRows, cockpitMenu } from "./desk-model.js";

const STALE_MS = 30_000;

/**
 * Cached cockpit snapshot; refetches when older than 30s or forced.
 * @returns {Promise<{ pushedAt: string|null, cockpit: object|null, fetchedAt: number }|null>} null = handled (signed out / verify)
 */
export async function loadCockpit({ force = false } = {}) {
  if (!force && app.cockpit && Date.now() - app.cockpit.fetchedAt < STALE_MS) return app.cockpit;
  try {
    const data = await getCockpit(app.desk.deskToken);
    app.cockpit = { pushedAt: data?.pushedAt || null, cockpit: data?.cockpit || null, fetchedAt: Date.now() };
    return app.cockpit;
  } catch (err) {
    if (err instanceof ApiError && err.kind === "unpaired") {
      await handleUnpaired("This phone was signed out on the Hub");
      return null;
    }
    if (err instanceof ApiError && err.kind === "verify") return null;
    throw err;
  }
}

/** "Desk snapshot · updated 3 min ago" / how to get one. */
export function snapshotLine(snap) {
  if (!snap?.cockpit) return "No desk snapshot yet. On the desk run: gotchibot hub cockpit push";
  const when = relativeTime(snap.pushedAt);
  return `Desk snapshot${when ? ` · updated ${when}` : ""}`;
}

/** This phone's project: its own pick, else whatever the desk has current. */
export async function resolveCurrentProject(snap) {
  const mine = await getCurrentProject().catch(() => null);
  if (mine) return mine;
  const deskCurrent = snap?.cockpit?.header?.project;
  if (deskCurrent) return deskCurrent;
  try {
    const data = await listProjects(app.desk.deskToken);
    for (const p of data?.projects || []) app.projects.set(p.slug, { ...app.projects.get(p.slug), ...p });
    return (data?.projects || []).find((p) => p.current)?.slug || null;
  } catch {
    return null;
  }
}

function headerCard(rows) {
  const card = el("section", "cockpit-header");
  const dl = el("dl", "cockpit-rows");
  for (const [label, value] of rows) {
    dl.append(el("dt", null, label), el("dd", null, value));
  }
  card.appendChild(dl);
  return card;
}

function menuList(items) {
  const ol = el("ol", "cockpit-menu");
  items.forEach((item, i) => {
    const li = el("li");
    const row = item.href ? el("a", "cockpit-item") : el("div", "cockpit-item desk-only");
    if (item.href) row.href = item.href;
    else row.setAttribute("aria-disabled", "true");
    row.appendChild(el("span", "cockpit-num", String(i + 1)));
    row.appendChild(el("span", "cockpit-label", item.label));
    if (item.badge) row.appendChild(el("span", "tag tag-accent", String(item.badge)));
    if (item.deskOnly) row.appendChild(el("span", "tag cockpit-desk-tag", "on desk"));
    li.appendChild(row);
    ol.appendChild(li);
  });
  return ol;
}

export async function renderCockpitView(root) {
  clearPoller();
  root.replaceChildren();
  root.className = "app-shell";

  const brand = el("div", "brand-mark");
  const logo = el("img", "brand-logo");
  logo.src = "icons/icon-32.png";
  logo.alt = "";
  brand.appendChild(logo);
  const settingsBtn = iconButton(iconSettings(20), "Settings", () => navigate("#/settings"));
  root.appendChild(topNav({ title: "GotchiBot cockpit", left: brand, right: settingsBtn }));

  const main = el("main", "cockpit");
  root.appendChild(main);

  let refreshing = false;
  async function paint(force) {
    if (refreshing) return;
    refreshing = true;
    let snap = app.cockpit;
    let error = null;
    try {
      snap = await loadCockpit({ force });
      if (snap === null) return;
    } catch (err) {
      error = err?.message || "Couldn't reach the Hub";
    } finally {
      refreshing = false;
    }
    const project = await resolveCurrentProject(snap);
    const projectTitle = project ? app.projects.get(project)?.title || null : null;
    const cockpit = snap?.cockpit || null;

    main.replaceChildren();
    main.appendChild(headerCard(cockpitHeaderRows({ cockpit, desk: app.desk, project, projectTitle })));

    const status = el("div", "cockpit-status");
    status.appendChild(el("span", "subtle", snapshotLine(snap)));
    const refresh = iconButton(iconRefresh(16), "Refresh", () => void paint(true), "icon-btn small");
    status.appendChild(refresh);
    main.appendChild(status);
    if (error) main.appendChild(el("div", "notice error", error));

    main.appendChild(el("h2", "cockpit-prompt", "What next?"));
    main.appendChild(menuList(cockpitMenu({ project, cockpit })));
  }

  main.appendChild(el("div", "project-card skeleton"));
  await paint(false);
}
