/**
 * Small DOM helpers shared by the desk views. CSP: no inline style
 * attributes in HTML strings — dynamic colors go through element.style.
 */
import { avatarObjectUrl } from "./api.js";
import { app } from "./state.js";
import { spiritChar, statusTone } from "./desk-model.js";

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function iconButton(html, label, onClick, className = "icon-btn") {
  const btn = el("button", className);
  btn.type = "button";
  btn.setAttribute("aria-label", label);
  btn.innerHTML = html;
  btn.addEventListener("click", onClick);
  return btn;
}

/**
 * Sticky header: [left] title/subtitle [right].
 * @param {{ title: string, subtitle?: string|null, left?: Node|null, right?: Node|null, center?: boolean }} opts
 */
export function topNav({ title, subtitle = null, left = null, right = null, center = false }) {
  const nav = el("header", `top-nav${center ? " centered" : ""}`);
  const leftSlot = el("div", "nav-slot nav-left");
  if (left) leftSlot.appendChild(left);
  const mid = el("div", "nav-title");
  const h1 = el("h1", null, title);
  mid.appendChild(h1);
  const sub = el("p", "nav-subtitle", subtitle || "");
  sub.hidden = !subtitle;
  mid.appendChild(sub);
  const rightSlot = el("div", "nav-slot nav-right");
  if (right) rightSlot.appendChild(right);
  nav.append(leftSlot, mid, rightSlot);
  return nav;
}

/** Update the header created by topNav in place. */
export function setNavTitle(root, title, subtitle) {
  const h1 = root.querySelector(".nav-title h1");
  if (h1 && title != null) h1.textContent = title;
  const sub = root.querySelector(".nav-subtitle");
  if (sub && subtitle !== undefined) {
    sub.textContent = subtitle || "";
    sub.hidden = !subtitle;
  }
}

let toastTimer = null;
export function toast(message, { tone = "info", ms = 2600 } = {}) {
  document.querySelector(".toast")?.remove();
  const t = el("div", `toast ${tone}`, message);
  t.setAttribute("role", "status");
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), ms);
}

/**
 * Round gotchi avatar: the Hub SVG when there is one, else a collateral-colored
 * disc with the spirit letter (same letters as the kanban thumbs).
 * @param {{ id: string, name?: string|null, collateral?: string|null, color?: string|null, hasAvatar?: boolean, status?: string }} hero
 * @param {{ size?: number, ring?: boolean }} [opts]
 */
export function heroAvatar(hero, { size = 40, ring = false } = {}) {
  const wrap = el("span", `hero-avatar${ring ? ` ring tone-${statusTone(hero.status)}` : ""}`);
  wrap.style.setProperty("--size", `${size}px`);
  if (hero.color) wrap.style.setProperty("--hero", hero.color);
  const letter = el("span", "hero-letter", spiritChar(hero.collateral, hero.name));
  wrap.appendChild(letter);
  wrap.title = hero.name || hero.id;

  if (hero.hasAvatar && app.desk?.deskToken) {
    const show = (url) => {
      if (!url) return;
      const img = el("img", "hero-img");
      img.alt = "";
      img.decoding = "async";
      img.src = url;
      img.addEventListener("load", () => wrap.classList.add("has-img"));
      wrap.appendChild(img);
    };
    if (app.avatarUrls.has(hero.id)) {
      show(app.avatarUrls.get(hero.id));
    } else {
      void avatarObjectUrl(app.desk.deskToken, hero.id).then((url) => {
        app.avatarUrls.set(hero.id, url);
        show(url);
      });
    }
  }
  return wrap;
}

export function statusPill(status) {
  const tone = statusTone(status);
  const pill = el("span", `status-pill tone-${tone}`);
  pill.appendChild(el("span", "status-dot"));
  pill.appendChild(document.createTextNode(String(status || "unknown")));
  return pill;
}

/**
 * Bottom sheet. Returns { close }. Backdrop tap / Escape close it.
 * @param {{ title: string, body: Node, onClose?: () => void }} opts
 */
export function openSheet({ title, body, onClose }) {
  const backdrop = el("div", "sheet-backdrop");
  const sheet = el("section", "sheet-content");
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-label", title);
  sheet.appendChild(el("div", "sheet-handle"));
  const head = el("div", "sheet-header");
  head.appendChild(el("h3", null, title));
  sheet.appendChild(head);
  sheet.appendChild(body);
  backdrop.appendChild(sheet);

  function close() {
    document.removeEventListener("keydown", onKey);
    backdrop.classList.add("closing");
    setTimeout(() => backdrop.remove(), 180);
    onClose?.();
  }
  function onKey(e) {
    if (e.key === "Escape") close();
  }
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(backdrop);
  return { close };
}
