/**
 * GotchiBot phone desk — hash router + boot.
 *   #/login · #/pair · #pair=CODE → sign-in
 *   #/projects                    → portfolio (home)
 *   #/p/<slug>[/t/<threadId>]     → project chat (+ crew pane)
 *   #/settings
 */
import { parsePairHash } from "./pair.js";
import { getDesk } from "./storage.js";
import { app, navigate } from "./state.js";
import { parseDeskRoute } from "./desk-model.js";
import { renderLoginView, renderPairView } from "./login.js";
import { renderPortfolioView } from "./portfolio.js";
import { renderChatView } from "./chat.js";
import { renderSettingsView } from "./settings.js";

let bootOnce = false;

/** Sheets / panes live on <body>; never carry them across views. */
function dropOverlays() {
  for (const n of document.querySelectorAll(".sheet-backdrop, .pane-backdrop")) n.remove();
  document.body.classList.remove("no-scroll");
}

async function route() {
  const root = document.getElementById("root");
  if (!root) return;
  dropOverlays();

  // Deep link #pair=CODE → pair view prefilled (tap to confirm)
  const raw = location.hash || "";
  const pairCode = parsePairHash(raw);
  if (pairCode && !raw.startsWith("#/")) {
    renderPairView(root, { prefills: pairCode });
    return;
  }

  const r = parseDeskRoute(raw);
  if (!app.desk) app.desk = await getDesk();

  if (r.name === "pair") {
    renderPairView(root);
    return;
  }
  if (!app.desk) {
    if (r.name !== "login") {
      navigate("#/login", { replace: true });
      return;
    }
    renderLoginView(root);
    return;
  }
  if (r.name === "login") {
    navigate("#/projects", { replace: true });
    return;
  }
  if (r.name === "settings") {
    await renderSettingsView(root);
    return;
  }
  if (r.name === "chat") {
    await renderChatView(root, r);
    return;
  }
  await renderPortfolioView(root);
}

async function boot() {
  if (bootOnce) return;
  bootOnce = true;
  app.route = route;
  window.addEventListener("hashchange", () => void route());
  await route();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void boot());
  } else {
    void boot();
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {
      /* ignore registration failures on file:// or unsupported hosts */
    });
  }
}
